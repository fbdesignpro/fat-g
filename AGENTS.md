# AGENTS.md
We are building an AI Agent wrapper around CLI's, similar in goal to the Codex and Claude desktop apps. 

The vision is to render it more like a video game UI, whilst retaining DOM copy and paste etc functionality.

This is meant to be fully open source. 

IMPORTANT: the code and file layout should be modularized and layered, so that others may easily add new functionality, providers, etc.
IMPORTANT: user file, personal information and privacy are of paramount importance.

This should be architected for cross platform (windows will be the development platform, then Mac OS and Linux).

## Where to look

- **Development guide:** [`docs/development.md`](docs/development.md) covers prerequisites, running from source, checking changes, packaging, and the guides for adding a provider, a tab kind or avatars.
- **Decisions:** scan the one-line index [`docs/decisions/README.md`](docs/decisions/README.md), then open only the records for the area you touch (each starts with a `Rule:` line). Check them before proposing an alternative.
- **Verification:** follow [`docs/testing.md`](docs/testing.md) for targeted checks and full-suite gates.
- **Avatar art:** [`docs/maintaining-avatar-art.md`](docs/maintaining-avatar-art.md) records how raw artwork becomes built-in avatar families. Read it before adding, replacing or re-encoding avatar art.

## Hard rules

- **Credentials and network** ([0004](docs/decisions/0004-never-touch-credentials.md)): the app never reads CLI credential files or keychains, never calls undocumented vendor endpoints, and makes no network calls of its own — the user's installed CLI makes every authenticated call. Agents never log in or handle credentials either.
- **Project folders** ([0015](docs/decisions/0015-no-writes-into-project-folders.md)): fat-g never writes into a project's folders — no files of its own, no provider files such as `AGENTS.md` or `CLAUDE.md`, no settings; what it remembers about a project lives in its data folder or the session. [`PRIVACY.md`](PRIVACY.md) lists every file fat-g writes: update it in the same commit when that changes.
- **Conversation content** ([0019](docs/decisions/0019-conversation-store.md)): kept until the user removes it, in the conversation store alone, a plan's text beside it in the plan store ([0029](docs/decisions/0029-plans.md)) until the plan is implemented or discarded, or the user removes it — never in `records.json`, the app state, a log or the Pet — and only an explicit removal, or a plan implemented or discarded, deletes it.
- **Project files** ([0022](docs/decisions/0022-reading-project-files.md)): opened at the user's press, then checked and refreshed automatically while its text tab is visible, inside the project's trusted folders, checked in main — never a provider's or an account's configuration folder, nor fat-g's own data folder. Nothing of it is kept: the text is shown, never stored, logged or sent to the Pet, except a passage the user sends to an aside, kept with it as their question ([0025](docs/decisions/0025-asides.md)). No file is opened with the system's application.
- **Stored formats** ([0014](docs/decisions/0014-format-compatibility-starts-at-first-release.md)): until the first public release, no migrations or backward-compatibility shims; a format change raises `schemaVersion` and `minReaderVersion` together. The version envelope, the refusal of incompatible files and unknown-field preservation are still complete and tested from each format's first version. Each format's baseline sits in `tests/fixtures/baselines/`, recorded by `do-record-baselines.bat`, and `tests/baselines/` proves every build reads it: before the release tag a raise re-records the baseline; after it, a raise adds a migration and a new baseline, the old kept.
- **Layers** ([0002](docs/decisions/0002-single-package-layered-layout.md)): who may import whom is enforced by ESLint and tested; a new provider or artifact kind is a module, not an edit of shared code.

## Architecture Overview

This project is a multimedia desktop application built on **Electron**, with **React/TypeScript and the browser DOM as the primary UI layer**.

The application deliberately keeps normal interface content—text, Markdown, code, forms, buttons, selection, clipboard behavior, accessibility, and input—as standard HTML rather than rendering the entire interface through a game engine.

The visual presentation is game-inspired, and MAY contain the following, although we are scaling down the emphasis a bit to focus on functionality:
- Image-based buttons with rollover/pressed states
- CSS compositing, including additive / `plus-lighter` effects
- Scene-style transitions and animated overlays
- Music, ambience, UI sounds, and SFX through Web Audio
- Full-window image and video backgrounds
- Layered PNG/WebP artwork
- Optional Canvas/PixiJS/Three.js layers only where DOM/CSS is insufficient

The application should be thought of as a **multimedia DOM engine**, not as a conventional web page and not as a game-engine-rendered UI.

We have a so-called "Pet" window: an always on top list of the sessions running or waiting on the user (not a pet-like display; [0010](docs/decisions/0010-pet-deferred.md)). **Naming:** everything the user sees calls it the **mini window** — its Settings switch, the title strip's button, its tooltips, its window title, `PRIVACY.md`, `README.md`; the code, file names, IPC channels (`pet:*`), the window kind (`pet`), the app state's `pet` and the stored preference `windows.pet` keep "pet". Write new user-facing text with "mini window", and keep "pet" in code.

### High-Level Structure

```text
Electron
├── Main BrowserWindow
│   ├── React / TypeScript
│   ├── Page grid and regions
│   ├── DOM-based application UI
│   ├── Image / video presentation layers
│   ├── Audio system
│   └── Optional GPU/canvas effects
│
├── Desktop Pet BrowserWindow
│   ├── Opaque, frameless; fixed width, height following its list of sessions
│   ├── Always-on-top
│   ├── No taskbar entry; shown without taking focus
│   └── Main's allowlisted view of the sessions (never account identity)
│
└── Main Process
    ├── Window lifecycle
    ├── Native OS integration
    ├── IPC
    ├── Process/subprocess management
    └── Agent runtime adapters
```

AI/coding backends such as **Claude Code and Codex should be treated as agent runtimes behind adapters**. Their native structured events should be normalized into application-level events before reaching the UI.

```text
Claude Code ──► Claude Adapter ──┐
                                ├──► Normalized Agent Events ──► UI
Codex       ──► Codex Adapter ──┘
```

The UI should render agent activity semantically—for example messages, tool activity, plans, permission requests, questions, file changes, and completion states—rather than exposing raw terminal output whenever structured information is available.

### Architectural Principle

**Use the DOM for interface semantics, Electron for desktop integration, media/CSS for presentation, and GPU rendering only for effects that genuinely require it.**

Avoid replacing normal HTML UI with Canvas/WebGL unless there is a concrete rendering requirement that the DOM cannot reasonably satisfy.

### Git / GitHub
CI runs in tiers ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): pushes and pull requests run tests, the build and packaging on Windows and Linux, and lint and typecheck once on Linux; a push of documents alone runs nothing. **macOS is opt-in, including for milestones:** it runs only when the maintainer explicitly requests it through the push's last commit message (`[ci macos]`, a list including `macos`, or `[ci all]`) or a manual run's systems input (`gh workflow run ci.yml -f systems=macos`, or `-f systems=all` for all three). `gh workflow run ci.yml` without a systems input runs Windows and Linux too. A push that only fixes what CI found failing on some systems names them in its last commit's message — `[ci macos]`, `[ci linux, windows]` — and runs there alone; other pushes name none unless the maintainer explicitly requests macOS.
