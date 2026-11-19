// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Audits a built package against decision 0007 (docs/planning/_archive/phase-1/phase-1-m9.md §5). Run after
// scripts/package.mjs:
//   node scripts/verify-package.mjs release|smoke [--tamper] [--output <name>]
// It reads the unpacked app only, and prints paths, counts and sizes — never file contents. The rules
// live in scripts/lib/package-audit.mjs (unit-tested); this file gathers what they judge.
// --tamper (Windows) also proves asar integrity: it flips one byte in a COPY of the app and launches
// that copy isolated from the user's data, CLIs and network settings; it must refuse to start.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assetNoticesMissing, assetProblems, auditArchive, containsNeedle, flavorProblems, FONT_DIRECTORY, forbiddenPaths, fuseMismatches, LIMITS, noticesMissing, privacyNeedles,
} from './lib/package-audit.mjs';
import { AVATAR_ART_FOLDER, auditAvatarArt, avatarArtLeaks } from './lib/avatar-art.mjs';
import { installed, licenseText, packageNoticeProblems, PACKAGED_ASSETS, shippedPackages } from './lib/packages.mjs';
import { FILE_MARKERS } from '../tests/fixtures/project-files.mjs';
import { checkPackageDirectories, packageOptions } from './lib/package-output.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

let options;
try { options = packageOptions(ROOT, process.argv.slice(2), ['--tamper']); } catch (error) {
  console.error(`${error.message}\nusage: node scripts/verify-package.mjs release|smoke [--tamper] [--output <name>]`);
  process.exit(2);
}
const { flavor, output: base } = options;
checkPackageDirectories(ROOT, [base]);
const problems = [];
const warnings = [];
const problem = (message, items = []) => { problems.push(items.length ? `${message}:\n    ${items.slice(0, 20).join('\n    ')}${items.length > 20 ? `\n    … ${items.length - 20} more` : ''}` : message); };

// ── Where the unpacked app is, per platform ──────────────────────────────────────────────────
function locate() {
  if (process.platform === 'darwin') {
    const folder = existsSync(base) ? readdirSync(base).find((name) => name.startsWith('mac') && existsSync(path.join(base, name, 'fat-g.app'))) : undefined;
    if (folder === undefined) return undefined;
    const app = path.join(base, folder, 'fat-g.app');
    return { unpacked: path.join(base, folder), resources: path.join(app, 'Contents', 'Resources'), executable: path.join(app, 'Contents', 'MacOS', 'fat-g'), fuses: app };
  }
  const unpacked = path.join(base, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  const executable = path.join(unpacked, process.platform === 'win32' ? 'fat-g.exe' : 'fat-g');
  return existsSync(unpacked) ? { unpacked, resources: path.join(unpacked, 'resources'), executable, fuses: executable } : undefined;
}
const where = locate();
if (where === undefined) {
  console.error(`[verify-package] no unpacked ${flavor} app under ${path.relative(ROOT, base)}; run: node scripts/package.mjs ${flavor} --dir --output ${path.basename(base)}`);
  process.exit(1);
}
const archive = path.join(where.resources, 'app.asar');
const relative = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

// ── 1. app.asar against the allowlist ────────────────────────────────────────────────────────
const { header, headerSize } = asar.getRawHeader(archive);
function* leaves(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const file = prefix ? `${prefix}/${name}` : name;
    if (child.files) yield* leaves(child, file);
    else yield { path: file, size: Number(child.size ?? 0), offset: child.offset, unpacked: child.unpacked === true, link: child.link !== undefined };
  }
}
const entries = [...leaves(header)];
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const shipped = shippedPackages(lock);
const { unexpected, missing } = auditArchive(entries.map((entry) => entry.path), shipped.map((pkg) => pkg.key));
if (unexpected.length) problem('app.asar holds files outside the allowlist', unexpected);
if (missing.length) problem('app.asar lacks shipped packages', missing);
const oddEntries = entries.filter((entry) => entry.unpacked || entry.link).map((entry) => entry.path);
if (oddEntries.length) problem('app.asar has unpacked or linked entries (nothing may run from outside the archive)', oddEntries);

// ── 2. Forbidden content, in the archive and in the unpacked app ─────────────────────────────
function walk(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full, root);
    return [{ path: path.relative(root, full).replaceAll('\\', '/'), full }];
  });
}
const loose = walk(where.unpacked);
// The installer's own folder too: an updater leftover beside the installer (a .blockmap, latest*.yml)
// would travel with it.
const besideInstaller = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
const forbidden = [
  ...forbiddenPaths(entries.map((entry) => entry.path)).map((file) => `app.asar/${file}`),
  ...forbiddenPaths(loose.map((file) => file.path)),
  ...forbiddenPaths(besideInstaller).map((name) => `${relative(base)}/${name}`),
];
if (forbidden.length) problem('forbidden content ships', forbidden);

// ── 2b. Fonts and images (decision 0012, M11): the vendor's font files unchanged, nothing else ──
const hashOf = (entry) => createHash('sha256').update(asar.extractFile(archive, entry.path.split('/').join(path.sep))).digest('hex');
const assets = assetProblems(entries.map((entry) => ({ path: entry.path, ...(entry.path.startsWith(`${FONT_DIRECTORY}/`) ? { sha256: hashOf(entry) } : {}) })));
if (assets.length) problem('font or image files differ from what ships', assets);

// ── 3. Size tripwires: how a platform binary or a stray folder would sneak back ──────────────
const archiveBytes = statSync(archive).size;
if (archiveBytes > LIMITS.archiveBytes) problem(`app.asar is ${(archiveBytes / 2 ** 20).toFixed(1)} MiB (limit ${LIMITS.archiveBytes / 2 ** 20} MiB)`);
const large = [...entries.filter((entry) => entry.size > LIMITS.fileBytes).map((entry) => `app.asar/${entry.path}`),
  ...readdirSync(where.resources).filter((name) => name !== 'app.asar').map((name) => path.join(where.resources, name)).filter((file) => statSync(file).isFile() && statSync(file).size > LIMITS.fileBytes).map(relative)];
if (large.length) problem(`files over ${LIMITS.fileBytes / 2 ** 20} MiB outside the Electron runtime`, large);

// ── 4. Privacy: fixture text and the builder's paths never ship (paths reported, never text) ─
const constants = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'claude', 'fake-cli-constants.json'), 'utf8'));
// And the long-conversation fixture (M19, C52), by a line of its table stream: it is read from its
// file by the stream form, and is part of no build, in either flavor.
const LONG_FIXTURE_LINE = 'The measurements, row by row:';
// And its activity (M20a, C44), by what every command of it holds: a bundler that took the
// activity's generator alone would leave the table's line out.
const LONG_FIXTURE_ACTIVITY = "src --glob '*_";
// And the files the replay fakes' answers name (M19b, C46), by each one's marker: the smoke run
// writes them into its live project folder, and they are part of no build, in either flavor.
const needles = privacyNeedles({ home: os.homedir(), repo: ROOT, fixtureStrings: [constants.sentinel, constants.email, 'smoke@example.test', LONG_FIXTURE_LINE, LONG_FIXTURE_ACTIVITY, ...FILE_MARKERS] });
// The smoke flavor's own smoke chunks assert on the fixtures' synthetic identities; machine paths
// stay forbidden there too, and every other file is scanned for everything.
const pathNeedles = privacyNeedles({ home: os.homedir(), repo: ROOT, fixtureStrings: [LONG_FIXTURE_LINE, LONG_FIXTURE_ACTIVITY, ...FILE_MARKERS] });
const needlesFor = (entry) => (flavor === 'smoke' && /^out\/main\/smoke/.test(entry.path) ? pathNeedles : needles);
const caseInsensitive = process.platform === 'win32';
const read = (entry) => asar.extractFile(archive, entry.path.split('/').join(path.sep)).toString('latin1');
const leaks = [
  ...entries.filter((entry) => containsNeedle(read(entry), needlesFor(entry), caseInsensitive)).map((entry) => `app.asar/${entry.path}`),
  ...readdirSync(where.resources).filter((name) => /\.(txt|json|html|md)$/i.test(name)).map((name) => path.join(where.resources, name))
    .filter((file) => containsNeedle(readFileSync(file, 'latin1'), needles, caseInsensitive)).map(relative),
];
// And every file of the avatar art beside the archive, images included, as the archive's entries are (M102, C70).
const artRoot = path.join(where.resources, AVATAR_ART_FOLDER);
const artFiles = existsSync(artRoot) ? walk(artRoot) : [];
leaks.push(...avatarArtLeaks(artFiles.map((file) => ({ path: relative(file.full), text: readFileSync(file.full, 'latin1') })), (text) => containsNeedle(text, needles, caseInsensitive)));
if (leaks.length) problem('private text (fixture strings or the build machine\'s paths) ships', leaks);

// ── 4b. The built-in avatar art (M102, C69, C70): its names, its credits and its one bound ────
if (existsSync(artRoot)) {
  const manifests = Object.fromEntries(readdirSync(artRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const file = path.join(artRoot, entry.name, 'family.json');
    let manifest;
    try { manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; } catch { manifest = undefined; }
    return [entry.name, manifest];
  }));
  const noticesPath = path.join(where.resources, 'THIRD_PARTY_NOTICES.txt');
  const artProblems = auditAvatarArt({ files: artFiles.map((file) => ({ path: file.path, bytes: statSync(file.full).size })), manifests, notices: existsSync(noticesPath) ? readFileSync(noticesPath, 'utf8') : '' });
  if (artProblems.length) problem('the avatar art breaks its rules', artProblems);
} else {
  problem(`the avatar art is missing: no ${AVATAR_ART_FOLDER} folder beside the archive`);
}

// ── 5. Fuses (decision 0007) ─────────────────────────────────────────────────────────────────
// Default effects are a closed asset set outside app.asar, copied into userData at startup.
const audioRoot = path.join(where.resources, 'audio');
const soundNames = ['question.wav', 'approval.wav', 'plan-ready.wav', 'review-ready.wav', 'error.wav', 'button.wav', 'done.wav', 'BagClose.mp3', 'right-click.wav', 'BagOpen.mp3', 'notification-done.wav', 'Launch-1.mp3', 'LICENSE.txt'].sort();
const audioFiles = existsSync(audioRoot) ? walk(audioRoot) : [];
if (JSON.stringify(audioFiles.map((file) => file.path).sort()) !== JSON.stringify(soundNames)) problem('the default audio assets are missing or include unexpected files');
for (const file of audioFiles) {
  const bytes = readFileSync(file.full);
  const original = path.join(ROOT, 'assets', 'audio', file.path);
  if (!soundNames.includes(file.path) || !existsSync(original) || !bytes.equals(readFileSync(original))) problem('a default audio asset differs from the source', [file.path]);
  if (containsNeedle(bytes.toString('latin1'), needles, caseInsensitive)) problem('private text in an audio asset', [file.path]);
}

const wire = await getCurrentFuseWire(where.fuses);
const fuseProblems = fuseMismatches(wire, FuseV1Options);
if (fuseProblems.length) problem('fuses differ from decision 0007', fuseProblems);
if (process.platform === 'darwin') {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', where.fuses], { encoding: 'utf8' });
  if (signature.status !== 0) problem('macOS bundle signature is invalid', [signature.error?.message ?? signature.stderr.trim()]);
  else {
    const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', where.fuses], { encoding: 'utf8' });
    if (details.status !== 0 || !/^Signature=adhoc$/m.test(details.stderr)) problem('macOS bundle must be ad hoc signed');
  }
}

// ── 6. Flavor: no smoke code in a release, and smoke code in the smoke flavor ────────────────
problems.push(...flavorProblems(flavor, entries.filter((entry) => entry.path.startsWith('out/main/')).map((entry) => ({ path: entry.path, text: read(entry) }))));

// ── 7. Licenses and notices ──────────────────────────────────────────────────────────────────
const noticesFile = path.join(where.resources, 'THIRD_PARTY_NOTICES.txt');
const ownLicense = path.join(where.resources, 'LICENSE.fat-g.txt');
if (!existsSync(ownLicense)) problem('LICENSE.fat-g.txt is missing');
else if (readFileSync(ownLicense, 'utf8').replace(/\r\n/g, '\n').trim() !== readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim()) problem('LICENSE.fat-g.txt differs from the source license');
if (!existsSync(noticesFile)) {
  problem('THIRD_PARTY_NOTICES.txt is missing');
} else {
  const bundled = ['preload', 'renderer'].flatMap((target) => {
    const listing = path.join(ROOT, 'release', '.staging', `bundled-${target}.json`);
    return existsSync(listing) ? JSON.parse(readFileSync(listing, 'utf8')).map((name) => installed(lock, name)).filter(Boolean) : [];
  });
  if (bundled.length === 0) warnings.push('no bundle listing in release/.staging: only shipped packages were checked against the notices');
  const notices = readFileSync(noticesFile, 'utf8');
  const absent = noticesMissing(notices, [...shipped, ...bundled]);
  if (absent.length) problem('THIRD_PARTY_NOTICES.txt does not credit', absent);
  problems.push(...packageNoticeProblems([...shipped, ...bundled].map((pkg) => ({ ...pkg, text: licenseText(path.join(ROOT, pkg.key)) })), notices));
  const assetsAbsent = assetNoticesMissing(notices, PACKAGED_ASSETS.map((asset) => asset.line));
  if (assetsAbsent.length) problem('THIRD_PARTY_NOTICES.txt does not credit the assets', assetsAbsent);
}
const electronLicenses = ['LICENSE.electron.txt', 'LICENSES.chromium.html'].filter((name) => !loose.some((file) => path.basename(file.path) === name));
if (electronLicenses.length) problem('Electron\'s license files are missing', electronLicenses);

// ── 8. Tamper test: a byte-flipped archive must refuse to start (Windows) ────────────────────
if (options.flags.has('--tamper')) {
  if (process.platform !== 'win32') warnings.push('--tamper runs on Windows only; skipped');
  else await tamperTest();
}

async function tamperTest() {
  const copy = mkdtempSync(path.join(os.tmpdir(), 'fatg-tamper-'));
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  try {
    cpSync(where.unpacked, copy, { recursive: true });
    // Isolated: a throwaway profile, no CLI on PATH, nothing inherited. The untampered control opens
    // the app's window for a few seconds against that empty profile, where it finds no agent CLI.
    const home = path.join(copy, 'isolated-home');
    for (const dir of ['AppData/Roaming', 'AppData/Local', 'Temp']) mkdirSync(path.join(home, dir), { recursive: true });
    const env = {
      SystemRoot: system, windir: system, PATH: path.join(system, 'System32'), USERPROFILE: home, HOME: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'),
      ELECTRON_ENABLE_LOGGING: '1',
    };
    const launch = async (waitMs) => {
      const child = spawn(path.join(copy, 'fat-g.exe'), [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      const collect = (chunk) => { if (output.length < 65536) output += chunk.toString('utf8'); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      const outcome = await Promise.race([exited.then((code) => ({ exited: true, code })), new Promise((resolve) => setTimeout(() => resolve({ exited: false }), waitMs))]);
      if (!outcome.exited) {
        spawnSync(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        await exited;
      }
      return { ...outcome, output };
    };

    // Control: the untouched copy must start in this environment, or a refusal below proves nothing.
    const control = await launch(6000);
    if (control.exited) {
      problem(`tamper test control: the untampered copy exited (code ${control.code}) in the isolated environment`);
      return;
    }
    const target = entries.find((entry) => entry.path === 'out/main/index.js');
    const position = 8 + headerSize + Number(target.offset) + Math.floor(target.size / 2);
    const fd = openSync(path.join(copy, 'resources', 'app.asar'), 'r+');
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, position);
    byte[0] ^= 0x01;
    writeSync(fd, byte, 0, 1, position);
    closeSync(fd);
    const tampered = await launch(20_000);
    if (!tampered.exited) problem('a tampered app.asar still started (asar integrity is not enforced)');
    else if (tampered.code === 0) problem('a tampered app.asar exited normally instead of refusing to start');
    else if (!/ASAR Integrity Violation|integrity check failed/i.test(tampered.output)) problem(`a tampered app.asar exited (code ${tampered.code}) without Electron's integrity failure message`);
    else console.log(`[verify-package] tamper test: the untampered copy started; the one-byte-flipped copy refused (exit ${tampered.code}, ASAR integrity violation)`);
  } finally {
    rmSync(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────
const unpackedBytes = loose.reduce((sum, file) => sum + statSync(file.full).size, 0);
const installers = existsSync(base) ? readdirSync(base).filter((name) => /\.(exe|dmg|AppImage)$/.test(name)) : [];
console.log(`[verify-package] ${flavor} (${process.platform}): app.asar ${(archiveBytes / 2 ** 20).toFixed(1)} MiB, ${entries.length} files; unpacked ${(unpackedBytes / 2 ** 20).toFixed(0)} MiB; ` +
  `${shipped.length} shipped packages${installers.length ? `; ${installers.map((name) => `${name} ${(statSync(path.join(base, name)).size / 2 ** 20).toFixed(0)} MiB`).join(', ')}` : ''}`);
for (const warning of warnings) console.log(`[verify-package] note: ${warning}`);
if (problems.length) {
  for (const message of problems) console.error(`[verify-package] FAIL ${message}`);
  process.exit(1);
}
console.log(`[verify-package] passed: allowlist, forbidden content, fonts and images, sizes, privacy scan, avatar art, audio assets, fuses, flavor, notices${process.platform === 'darwin' ? ', ad hoc bundle signature' : ''}`);
