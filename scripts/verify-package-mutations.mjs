// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Focused M9 fault injection: each mutation breaks one packaging safeguard and must turn a check red.
//   package mutations rebuild the release flavor (--dir), installer mutations build the installer too,
//   and both require scripts/verify-package.mjs to fail with a specific message; unit mutations require
//   a focused test to fail.
// Runs sequentially. Each mutation's files are put back to their exact original bytes and read back —
// one it added is removed, one it removed is written again — and the run cannot end with one left
// changed without saying so and failing (scripts/lib/mutation-files.mjs). It never widens the
// allowlist over real folders: the "widened allowlist" case plants a canary, so spikes/output (which
// can hold unredacted account captures) is never copied into even a throwaway build.
// Takes several minutes. Afterwards rebuild a clean package: npm run package:dir
//   node scripts/verify-package-mutations.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutationFiles, guardTree, leftMutated, retrying, turn } from './lib/mutation-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANARY = path.join(ROOT, 'spikes', 'mutation-canary');
// A path the way a leak would really look: written once as an ordinary string literal.
const leakedPath = JSON.stringify(path.join(os.homedir(), 'fatg-canary'));

const FONTS = 'src/renderer/public/fonts/inter';

/**
 * [name, edits, kind, expectation]. package/installer: the audit's output must include it.
 * An edit is [file, before, after] (text), or { file, flip | create | remove } for a file the build
 * copies as it is: flip its last byte, add it with these contents, or take it away.
 */
const mutations = [
  ['allowlist widened to a repo folder', [['electron-builder.yml', '  - out/renderer/**\n', '  - out/renderer/**\n  - spikes/mutation-canary/**\n']], 'package', 'holds files outside the allowlist'],
  ['runAsNode fuse left on', [['electron-builder.yml', '  runAsNode: false\n', '  runAsNode: true\n']], 'package', 'RunAsNode should be off'],
  ['asar integrity fuse off', [['electron-builder.yml', '  enableEmbeddedAsarIntegrityValidation: true\n', '  enableEmbeddedAsarIntegrityValidation: false\n']], 'package', 'EnableEmbeddedAsarIntegrityValidation should be on'],
  ['release flavor built with smoke hooks', [['electron.vite.config.ts', "const smokeHooks = process.env['FATG_RELEASE_BUILD'] !== '1';", 'const smokeHooks = true;']], 'package', 'FATG_SMOKE is in the release bundle'],
  // The demo source's switch read outside the build flag (M14, C27, C67, V16).
  ['release flavor built with the demo source', [['src/main/app/flavor.ts', "const demoValue: string | undefined = __FATG_SMOKE_HOOKS__ ? process.env['FATG_DEMO_SESSIONS'] : undefined;", "const demoValue: string | undefined = process.env['FATG_DEMO_SESSIONS'];"]], 'package', 'FATG_DEMO is in the release bundle'],
  // The stream form (M19, C63, C69) is behind the build flag twice: its switch is read behind it, so
  // that `isStreamForm` is false at build time, and its one dynamic import names it again. Either
  // alone keeps the form out of a release — the import's flag taken off by itself leaves a clean
  // bundle, which the audit rightly passes — so the mutation takes both, and the form's chunk is in.
  ['release flavor built with the stream form', [
    ['src/main/app/flavor.ts', "const demoValue: string | undefined = __FATG_SMOKE_HOOKS__ ? process.env['FATG_DEMO_SESSIONS'] : undefined;", "const demoValue: string | undefined = process.env['FATG_DEMO_SESSIONS'];"],
    ['src/main/index.ts', '} else if (__FATG_SMOKE_HOOKS__ && isStreamForm) {', '} else if (isStreamForm) {'],
  ], 'package', 'a demo chunk is in the release bundle'],
  // The long-conversation fixture (M19, C52), pulled into the page's bundle.
  ['the long-conversation fixture bundled into the page', [['src/renderer/src/boot.tsx', "import { createRoot } from 'react-dom/client';\n", "import { createRoot } from 'react-dom/client';\nimport { streamText } from '../../../tests/fixtures/conversations/long-conversation.mjs';\nconsole.debug(streamText('table').length);\n"]], 'package', 'private text'],
  // Its activity alone (M20a, C44, V16): the generator of what its turns did, without the streams.
  ['the long-conversation fixture’s activity bundled into the page', [['src/renderer/src/boot.tsx', "import { createRoot } from 'react-dom/client';\n", "import { createRoot } from 'react-dom/client';\nimport { activities } from '../../../tests/fixtures/conversations/long-conversation.mjs';\nconsole.debug(activities(1).length);\n"]], 'package', 'private text'],
  // The files the fakes' answers name (M19b, C46), pulled into the page's bundle.
  ['the project files bundled into the page', [['src/renderer/src/boot.tsx', "import { createRoot } from 'react-dom/client';\n", "import { createRoot } from 'react-dom/client';\nimport { FILES } from '../../../tests/fixtures/project-files.mjs';\nconsole.debug(FILES['README.md'].length);\n"]], 'package', 'private text'],
  ["builder's home path in a renderer string", [['src/renderer/src/boot.tsx', "import { createRoot } from 'react-dom/client';\n", `import { createRoot } from 'react-dom/client';\nconsole.debug(${leakedPath});\n`]], 'package', 'private text'],
  ['notices left empty', [['scripts/package.mjs', 'renderNotices([...entries.values()], assets)', "''"]], 'package', 'does not credit'],
  // The Markdown lexer is bundled into the page (M19, C28; decision 0021): its notice is owed like any other's.
  ['the Markdown lexer left out of the notices', [['scripts/package.mjs', 'renderNotices([...entries.values()], assets)', "renderNotices([...entries.values()].filter((entry) => entry.name !== 'marked'), assets)"]], 'package', 'marked@18.1.0'],
  ['asset notices left out', [['scripts/package.mjs', 'renderNotices([...entries.values()], assets)', 'renderNotices([...entries.values()])']], 'package', 'does not credit the assets'],
  // The packaged font (decision 0012): the vendor's files only, unchanged (M11, V7).
  ['a packaged font altered', [{ file: `${FONTS}/Inter-Bold.woff2`, flip: true }], 'package', "packaged font file differs from the vendor's"],
  ['a font file added', [{ file: `${FONTS}/Inter-Italic.woff2`, create: 'a stand-in, not a font' }], 'package', 'unexpected font file'],
  ['a font file missing', [{ file: `${FONTS}/Inter-Medium.woff2`, remove: true }], 'package', 'packaged font file missing'],
  // A records file in a package would publish someone's folders (M12, C84, V28).
  ['a records file packed', [{ file: 'src/renderer/public/records.json', create: '{"schemaVersion":5,"minReaderVersion":5,"projects":[],"sessions":[]}' }], 'package', 'forbidden content ships'],
  // A conversation store holds what someone said to a provider (M18, C43).
  ['a conversation store packed', [{ file: 'src/renderer/public/conversations.sqlite', create: 'SQLite format 3' }], 'package', 'forbidden content ships'],
  // A catalog override holds the user's own words and paths; the defaults ship inside main's bundle (M13, C53, V16).
  ['a catalog file packed', [{ file: 'src/renderer/public/catalog.json', create: '{"schemaVersion":1,"minReaderVersion":1,"providers":{}}' }], 'package', 'forbidden content ships'],
  // elevate.exe is added only while the NSIS installer is built, so this one needs a full build.
  ['updater helper packed', [['electron-builder.yml', '  packElevateHelper: false\n', '  packElevateHelper: true\n']], 'installer', 'forbidden content ships'],
  ['update block map beside the installer', [['electron-builder.yml', '  differentialPackage: false\n', '  differentialPackage: true\n']], 'installer', 'forbidden content ships'],
  ['react back in dependencies', [['package.json', '"dependencies": {\n', '"dependencies": {\n    "react": "^19.3.0",\n']], 'unit', ['tests/architecture/runtime-dependencies.test.ts', 'nothing missing, nothing extra']],
  ['an Anthropic package in dependencies', [['package.json', '"dependencies": {\n', '"dependencies": {\n    "@anthropic-ai/claude-agent-sdk": "0.3.278",\n']], 'unit', ['tests/architecture/claude-confinement.test.ts', 'names no Anthropic package']],
  ['productName changed', [['electron-builder.yml', 'productName: fat-g\n', 'productName: Fat G\n']], 'unit', ['src/main/app/identity.test.ts', 'matches what electron-builder.yml']],
];

const node = (args, timeout) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, env: process.env });
const packageAndAudit = (installer) => {
  const build = node(['scripts/package.mjs', 'release', ...(installer ? [] : ['--dir'])], 900_000);
  if (build.status !== 0) return { built: false, output: build.stdout + build.stderr };
  const audit = node(['scripts/verify-package.mjs', 'release'], 300_000);
  return { built: true, failed: audit.status !== 0, output: audit.stdout + audit.stderr };
};

// Optional filter: node scripts/verify-package-mutations.mjs <part of a mutation name>
const only = process.argv[2];
const files = createMutationFiles();
guardTree(files, { root: ROOT });
let survived = 0;
for (const [name, edits, kind, expectation] of mutations) {
  if (only !== undefined && !name.includes(only)) continue;
  let failed;
  try {
    for (const edit of edits) {
      const file = Array.isArray(edit) ? edit[0] : edit.file;
      const target = path.join(ROOT, file);
      const original = files.original(target); // its bytes as the run found it, or null when it was not there
      if (!Array.isArray(edit)) {
        if (edit.create !== undefined) {
          if (original !== null) throw new Error(`mutation would overwrite an existing file: ${name} (${file})`);
          files.write(target, edit.create);
        } else if (original === null) {
          throw new Error(`missing mutation target: ${name} (${file})`);
        } else if (edit.remove) {
          files.remove(target);
        } else {
          const bytes = Buffer.from(original);
          bytes[bytes.length - 1] ^= 0x01;
          files.write(target, bytes);
        }
        continue;
      }
      const [, before, after] = edit;
      const source = (files.read(target)?.toString('utf8') ?? '').replace(/\r\n/g, '\n');
      if (!source.includes(before)) throw new Error(`missing mutation anchor: ${name} (${file})`);
      files.write(target, source.replace(before, after));
    }
    let detected;
    if (kind === 'package' || kind === 'installer') {
      if (name.startsWith('allowlist')) { mkdirSync(CANARY, { recursive: true }); files.write(path.join(CANARY, 'canary.json'), '{}'); }
      const result = packageAndAudit(kind === 'installer');
      detected = result.built && result.failed && result.output.includes(expectation);
      if (!detected) console.log(result.output.slice(-2000));
    } else {
      const [test, title] = expectation;
      const result = node(['node_modules/vitest/vitest.mjs', 'run', test, '-t', title], 120_000);
      detected = result.status !== 0 && (result.stdout + result.stderr).includes('FAIL');
      if (!detected) console.log(result.stdout.slice(-2000), result.stderr.slice(-2000));
    }
    console.log(`${detected ? 'DETECTED' : 'SURVIVED/INVALID'}: ${name}`);
    if (!detected) survived++;
  } finally {
    failed = files.restore();
    // The canary's folder is this script's own, made for one mutation: it goes with it.
    retrying(() => rmSync(CANARY, { recursive: true, force: true }));
  }
  // A file that could not be put back stops the run: nothing more is mutated on a tree that is not as it was.
  if (failed.length > 0) throw leftMutated(failed, ROOT);
  await turn();
}
console.log('Rebuild a clean package before using release/: npm run package:dir');
process.exitCode = survived ? 1 : 0;
