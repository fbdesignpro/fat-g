# Developing fat-g

This guide is for running fat-g from source or changing it. To use the packaged app, start with [installation in the README](../README.md#easy-install-use-fat-g-immediately).

## Prerequisites

- **Node.js 24 or later**, with npm.
- **Git**, if you want to clone the repository and pull updates. A source archive also works.
- **Claude Code or Codex**, installed and signed in through its own CLI, to use live agents. You can build the app and run automated checks without a provider account.

Windows is the primary development platform. The app is structured for Windows, macOS, and Linux; the Windows batch files wrap npm scripts that can also be run on the other systems.

## Get the source

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/fbdesignpro/fat-g.git
cd fat-g
npm ci
```

If you downloaded a source archive, extract it and run `npm ci` from the folder containing `package.json`. Dependency installation downloads Electron as well as the JavaScript packages.

## Run the development app

On Windows, double-click [do-run-dev.bat](../do-run-dev.bat), or run it from PowerShell in the repository folder:

```powershell
.\do-run-dev.bat
```

On macOS or Linux:

```sh
npm run dev
```

The development app reloads as you work on the interface. It uses your installed provider CLIs, so sending a real prompt uses your provider account as usual.

For interface work without live agents, Windows also has [do-run-stream.bat](../do-run-stream.bat), which opens synthetic conversations in an isolated temporary data folder and starts no CLI. See the [Windows script reference](../do-readme.md) for its example prompts and other development shortcuts.

## Development data

Development and packaged builds keep separate app data:

| Build | Windows data folder |
|---|---|
| Development (`do-run-dev.bat`) | `%APPDATA%\fat-g-dev` |
| Packaged or installed app | `%APPDATA%\fat-g` |

On macOS and Linux, the development folder is likewise named `fat-g-dev` beside the regular `fat-g` folder. [Privacy](../PRIVACY.md#the-data-folder) lists the locations.

Preferences, projects, and chats from one build do not appear in the other. Both builds use the same installed CLIs unless you configure separate accounts; the CLIs' own logins and histories are shared.

Development runs can also save changes to built-in avatar family manifests in the checkout's `assets/avatars/`. See [maintaining avatar art](maintaining-avatar-art.md) before changing those assets.

## Build a package

Build on the operating system you want to package for. On Windows:

```powershell
.\do-package.bat
```

This builds the unsigned installer and unpacked app into `release/release/`. It does not launch, install, or publish them. Run the resulting `fat-g-<version>-x64-setup.exe` to install it. The per-user wizard offers an installation folder and a **Run fat-g** checkbox on its final page, checked by default; choose a folder your Windows account can write to.

If that packaged copy is running, build and audit a separate output folder:

```powershell
.\do-package.bat --output candidate-0.9.0
node scripts/verify-package.mjs release --output candidate-0.9.0
```

The output is `release/candidate-0.9.0/`; `--output` takes a folder name, not a path. It leaves the default packaged copy running. On other systems, use `npm run package -- --output candidate-0.9.0`. Builds still share `out/` and notice staging, so run one package build at a time. The smoke runner continues to use the default `release/smoke/` folder.

To try the packaged app without installing it:

```powershell
.\do-package-and-run.bat
```

That builds the unpacked app and launches it using the regular `fat-g` data folder. Use [do-run-packaged.bat](../do-run-packaged.bat) to launch the same build again without rebuilding. Each package build replaces the previous output; run `do-package.bat` again if you need an installer after an unpacked-only build.

On macOS or Linux, the equivalent package commands are:

```sh
npm run package
```

For an unpacked app alone:

```sh
npm run package:dir
```

The configured installer formats are Windows NSIS (`.exe`), macOS disk image (`.dmg`), and Linux AppImage. On macOS the default target is the architecture of the running Node.js. To build and audit Apple Silicon and Intel DMGs in separate output folders, run these commands on macOS.

```sh
npm run package -- --arm64 --output mac-arm64
node scripts/verify-package.mjs release --output mac-arm64
npm run package -- --x64 --output mac-x64
node scripts/verify-package.mjs release --output mac-x64
```

The Mac app bundle is ad hoc signed during packaging. Developer ID signing, notarization and testing the browser-download approval flow are separate from the local package build. What a release guarantees, and these commands in order with the audits and checksums: see [Releasing fat-g](releasing.md).

Package contents are restricted to the built app, runtime dependencies, and bundled assets and notices. The audit is run with `node scripts/verify-package.mjs release`; see the [packaging decision](decisions/0007-packaged-build-contents.md) for what it checks.

## Make and check changes

Read the [project guidelines](../AGENTS.md) and relevant entries in the [decisions index](decisions/README.md) before making a change. Provider adapters normalize CLI events, the main process owns durable data, and React renders the interface. Keep new functionality within those layers.

On Windows, preview and run the checks selected for your changes:

```powershell
.\do-check.bat list
.\do-check.bat focused
```

On macOS or Linux:

```sh
npm run check:plan
npm run check:focused
```

Follow the [testing guide](testing.md) for checks limited to particular files, Electron smoke scenarios, and the full suite required before pushing code. Documentation-only changes do not require code checks.

Keep private chats, account details, credentials, and personal captures out of source changes and bug reports. fat-g's credential and project-folder boundaries are described in [Privacy](../PRIVACY.md) and the project guidelines.

### Extending fat-g

A new provider, a new kind of artifact tab or a new avatar set is a module of its own, not an edit of shared code ([decision 0002](decisions/0002-single-package-layered-layout.md)); ESLint and the architecture tests hold the boundaries between the layers. One guide for each kind of addition:

- [Adding a provider](adding-a-provider.md): a folder under `src/main/providers/` that holds everything fat-g knows about one CLI, in the order it is built, then the files outside it that change and the rules every provider follows.
- [Adding a kind of tab](adding-a-tab-kind.md): a folder under `src/renderer/src/artifacts/` and one line in the list of kinds, with the file and aside kinds as the examples.
- [Avatars of your own](avatars.md): the `avatars` folder, a family's `family.json`, and how a family's avatars are matched to models and overlaid; [maintaining avatar art](maintaining-avatar-art.md) is for the built-in families.
- [Adjusting the model lists](catalog-override.md): the `catalog.json` file in the data folder that adds to, hides from or relabels what a CLI reports ([decision 0013](decisions/0013-catalog-format-and-layers.md)).
- [Screenshot setups](dev-setups.md): development data frozen once and restored fresh for each screenshot or demonstration run, through `do-dev-setup.bat`.

### Comment notation

Code comments, test names and some fixture names cite the maintainer's planning records: `M<number>` is a milestone, `V<number>` and `C<number>` are its verification and acceptance items, and `Design <number>` is a design point of its plan; `decision <number>` refers to a record in [`docs/decisions/`](decisions/README.md). The planning documents and research notes those citations name are not part of this repository, and the comment text beside each citation stands on its own.
