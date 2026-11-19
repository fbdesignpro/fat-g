// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Builds a package: the only supported way to run electron-builder (electron-builder.yml).
//   npm run package        node scripts/package.mjs release        installer + unpacked folder, release/release/
//   npm run package:dir    node scripts/package.mjs release --dir  unpacked folder only (what CI audits)
//   npm run package:smoke  node scripts/package.mjs smoke          unpacked smoke flavor, release/smoke/
// Add --output <name> to build into release/<name>/ while another packaged copy is running.
// On macOS, use --arm64 or --x64 to select the target architecture explicitly.
// A release build compiles the smoke hooks out (FATG_RELEASE_BUILD=1); the smoke flavor keeps them so
// `node scripts/smoke.mjs packaged` can drive the packaged app. Both use the same builder config.
// macOS gets an ad hoc signature after the fuse changes. Certificate and publishing variables are
// removed from the builder's environment. Afterwards, `node scripts/verify-package.mjs <flavor>` audits the result.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_ART_SOURCE, avatarFamilyAssets } from './lib/avatar-art.mjs';
import { installed, licenseText, packageNoticeProblems, PACKAGED_ASSETS, renderNotices, shippedPackages } from './lib/packages.mjs';
import { checkPackageDirectories, packageOptions } from './lib/package-output.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isMac = process.platform === 'darwin';
const macArchFlags = ['--arm64', '--x64'];
let options;
let selectedArch;
try {
  options = packageOptions(ROOT, process.argv.slice(2), isMac ? ['--dir', ...macArchFlags] : ['--dir']);
  const architectures = macArchFlags.filter((flag) => options.flags.has(flag));
  if (architectures.length > 1) throw new Error('Choose either --arm64 or --x64.');
  [selectedArch] = architectures;
} catch (error) {
  console.error(`${error.message}\nusage: node scripts/package.mjs release|smoke [--dir] [--output <name>]${isMac ? ' [--arm64|--x64]' : ''}`);
  process.exit(2);
}
const { flavor, output, flags } = options;
const unpackedOnly = flavor === 'smoke' || flags.has('--dir');
const staging = path.join(ROOT, 'release', '.staging');

function run(label, command, args, env) {
  console.log(`[package] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    console.error(`[package] ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

// 1. A clean build of the requested flavor. The bundle recorder (electron.vite.config.ts) lists what
//    the preload and renderer bundle in, for the notices.
const cleanDirectories = [output, staging, path.join(ROOT, 'out')];
checkPackageDirectories(ROOT, cleanDirectories);
for (const directory of cleanDirectories) rmSync(directory, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const buildEnv = { ...process.env, FATG_PACKAGE_STAGING: staging };
if (flavor === 'release') buildEnv.FATG_RELEASE_BUILD = '1'; else delete buildEnv.FATG_RELEASE_BUILD;
run(`building the ${flavor} flavor`, process.execPath, [path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], buildEnv);

// 2. Third-party notices: every package shipped under node_modules and every package bundled in, then
//    the assets.
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const entries = new Map();
function credit(pkg, how) {
  const id = `${pkg.name}@${pkg.version}`;
  const known = entries.get(id);
  if (known) { if (!known.how.includes(how)) known.how += `; ${how}`; return; }
  entries.set(id, { name: pkg.name, version: pkg.version, license: pkg.license, text: licenseText(path.join(ROOT, pkg.key)), how });
}
for (const pkg of shippedPackages(lock)) credit(pkg, 'shipped as a runtime module');
for (const target of ['preload', 'renderer']) {
  const listing = path.join(staging, `bundled-${target}.json`);
  if (!existsSync(listing)) { console.error(`[package] the build did not record what the ${target} bundles`); process.exit(1); }
  for (const name of JSON.parse(readFileSync(listing, 'utf8'))) {
    const pkg = installed(lock, name);
    if (pkg === undefined) { console.error(`[package] ${name} is bundled into the ${target} but not installed`); process.exit(1); }
    credit(pkg, `bundled into the ${target}`);
  }
}
const noticeProblems = packageNoticeProblems([...entries.values()]);
if (noticeProblems.length) {
  console.error(`[package] incomplete third-party notices:\n${noticeProblems.join('\n')}`);
  process.exit(1);
}
// Then the assets (the packaged font, the provider marks), each licence read from what the build put
// in out/ — the file that ships — rather than from the source tree; and each avatar family whose
// manifest names a licence, its text from its LICENSE.txt, which ships beside it (M102, C69).
const assets = [...PACKAGED_ASSETS, ...avatarFamilyAssets(path.join(ROOT, AVATAR_ART_SOURCE))].map((asset) => {
  if (asset.licenseFile === undefined) return { line: asset.line, text: asset.text ?? '' };
  const file = path.join(ROOT, asset.licenseFile);
  if (!existsSync(file)) { console.error(`[package] ${asset.licenseFile} is missing from the build`); process.exit(1); }
  return { line: asset.line, text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() };
});
writeFileSync(path.join(staging, 'THIRD_PARTY_NOTICES.txt'), renderNotices([...entries.values()], assets));
console.log(`[package] notices: ${entries.size} packages, ${assets.length} assets`);

// 3. electron-builder: never publishes or searches a keychain for identities. Electron's fuse
// tool renews the Mac bundle's ad hoc signature after writing to the Electron Framework.
const builderEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
for (const name of Object.keys(builderEnv)) if (/^(CSC_(?!IDENTITY_AUTO_DISCOVERY$)|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|EP_)/.test(name)) delete builderEnv[name];
run('packaging', process.execPath, [
  path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
  '--publish', 'never',
  `-c.directories.output=${path.relative(ROOT, output).replaceAll('\\', '/')}`,
  ...(isMac ? ['-c.electronFuses.resetAdHocDarwinSignature=true'] : []),
  ...(selectedArch ? [selectedArch] : []),
  ...(unpackedOnly ? ['--dir'] : []),
], builderEnv);

console.log(`[package] ${flavor} flavor → ${path.relative(ROOT, output)}: ${readdirSync(output).join(', ')}`);
