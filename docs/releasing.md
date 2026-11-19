# Releasing fat-g

Releases are made by one person, by hand, when there is something to release: there is no schedule, no automatic update and no support commitment. The Windows installer is unsigned and the Mac app ad hoc signed ([decision 0007](decisions/0007-packaged-build-contents.md)); there is no signing account and no notarization.

## What a release guarantees

- **It is built from a tagged commit of this repository,** `v<version>` with the version of `package.json`, so what shipped can be read.
- **The package audit passed on the shipped files:** `node scripts/verify-package.mjs release` checks the package's contents, the absence of private data and of smoke hooks, the notices and the Electron fuses, and on macOS the ad hoc signature.
- **Checksums are published beside the installers,** in `SHA256SUMS.txt`, one line per file in `shasum` format. They let you verify bytes, not who published them.
- **A published installer is never replaced in place.** A fix is a new version, with its own tag and notes.
- **The notes say** that the app is unsigned, which systems each file was tried on, and what changed. Data written by an earlier release keeps being read ([decision 0014](decisions/0014-format-compatibility-starts-at-first-release.md#baselines-091)).

An image or installer that was not launched at least once on its own kind of machine is left out of the release rather than shipped untried.

## Building one

Everything comes from the same tagged checkout, with Node 24 (`.nvmrc`). The commands are explained in the [development guide](development.md#build-a-package); the checks a change needs are in [testing](testing.md), with the pre-push full suite and the packaged smoke before the tag.

**Windows,** in PowerShell:

```powershell
.\do-package.bat --output release-0.9.1
node scripts/verify-package.mjs release --output release-0.9.1 --tamper
Get-FileHash .\release\release-0.9.1\fat-g-0.9.1-x64-setup.exe -Algorithm SHA256
```

`--output` builds into `release\release-0.9.1\` and leaves a running packaged copy alone; package builds run one at a time. `--tamper` also launches an isolated copy and proves that a one-byte alteration is refused. If electron-builder stops on a locked user-level 7-Zip cache, point `ELECTRON_BUILDER_CACHE` at a folder inside the checkout's `node_modules\.cache\`.

**macOS,** in the same tagged checkout after `npm ci`:

```sh
npm run package -- --arm64 --output mac-arm64
node scripts/verify-package.mjs release --output mac-arm64
npm run package -- --x64 --output mac-x64
node scripts/verify-package.mjs release --output mac-x64
shasum -a 256 release/mac-arm64/fat-g-0.9.1-arm64.dmg release/mac-x64/fat-g-0.9.1-x64.dmg
```

**The assets:**

| Asset | Platform |
|---|---|
| `fat-g-0.9.1-x64-setup.exe` | Windows x64, per-user installer |
| `fat-g-0.9.1-arm64.dmg` | macOS, Apple Silicon |
| `fat-g-0.9.1-x64.dmg` | macOS, Intel |
| `SHA256SUMS.txt` | the hashes of the files above |

**The release:** a draft release on the tag, with the notes and these files alone — no unpacked app, smoke package, app data, captures or checkout; GitHub adds its own *Source code* archives, which the notes tell apart from the installers. Download the files again, check their hashes, and on a machine that is not the build machine open each installer once as a user would: the system's unsigned-app prompt, the first launch, one prompt to a CLI. Then publish, and check the README's download buttons, the assets and the checksums while signed out.
