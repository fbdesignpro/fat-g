# 0003 — Detect the user's installed CLIs; do not bundle them

> **Rule:** fat-g launches only the `claude` and `codex` the user installed: a path override, or else the newest version of those found on PATH and in known install folders. It never bundles a CLI, sets a CLI's configuration folder only for an account the user added, to the folder they picked, and an invalid override reports "CLI not found" or "Selected CLI unavailable" with no silent fallback.

- **Status:** Accepted. Amended by [0017](0017-provider-instances.md) (M14b): the configuration folder variable. Amended by the maintainer: the newest version found, below.
- **Applies to:** provider adapters, packaging, onboarding UX

## Context

Both agent runtimes can technically be shipped inside the app: `@anthropic-ai/claude-agent-sdk` and `@openai/codex` each pull a native binary as a per-platform npm optional dependency. Options considered:

1. **Detect** the user's own `claude` / `codex` installation.
2. **Bundle** the binaries that come with the npm packages.
3. Detect, with a bundled copy as fallback.

## Decision

**Detect only.** Resolution order: user-set path override (preferences) → the app's own PATH walk → the provider descriptor's known install directories. If nothing is found the UI shows install guidance; if a user override is invalid the provider reports `not-installed { overrideInvalid }` with **no silent fallback**.

**M6 admission amendment (implemented):** [decision 0005](0005-preferences-compatibility.md) gates detection before this resolution order. Unavailable/incompatible preferences or malformed provider controls yield a preference-blocked status and launch no probes. A schema-valid override whose executable cannot be resolved still follows the `not-installed { overrideInvalid }` rule above.

**M14b amendment ([0017](0017-provider-instances.md)):** a provider's first account sets nothing, as this record says: it follows a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` the user set themselves, or the CLI's default. An account the user added runs the same installed CLI with that variable set to a folder the user picked in fat-g's own folder picker. fat-g sets it for no other reason, and to no other value.

The Claude Agent SDK is still used as a *library*, but always with `pathToClaudeCodeExecutable` pointing at the user's binary, and any SDK-embedded binary is excluded from electron-builder's `files`.

## Consequences

- **Policy posture:** the app only ever launches the *unmodified, vendor-published* binary that the user installed and logged in to themselves. Anthropic's guidance permits users to authenticate that binary with their own subscription, subject to its integration conditions; OpenAI's current app-server guidance covers local and open-source applications. The maintainer accepted the [reviewed provider terms](../licensing.md#provider-policy-review) for this release. See [0004](0004-never-touch-credentials.md).
- Smaller installer; no asar-unpacking of native binaries; app releases are not tied to CLI releases.
- Users see the same account, config, and sessions as in their terminal, because it *is* the same install. For the first account we never set `CODEX_HOME`, and we honour `CLAUDE_CONFIG_DIR` if the user has set it; an added account's folder is the one the user picked ([0017](0017-provider-instances.md)).
- Cost: onboarding has an "install the CLI" step, and we must handle arbitrary CLI versions defensively (record `--version`, parse everything as optional, degrade to `not-applicable { unsupported-cli-version }`).
- Windows specifics this forces us to handle: npm-installed Codex is a `codex.cmd` shim (needs `cross-spawn`, never blanket `shell: true`), and GUI-launched Electron may not inherit the shell's PATH (PATH repair in `src/main/process/env.ts`).

## Revisit when

- Onboarding friction proves to be a real adoption barrier — option 3 (bundled fallback) can be added later without changing the adapter contract. Bundling changes the detect-only basis of the accepted provider-policy review and requires reviewing that new distribution arrangement.

## Automatic installation discovery

[Decision 0037](0037-provider-discovery.md) adds metadata-only discovery at launch and on Main focus. It preserves saved switches, blocks all discovery for unavailable preferences, permits passive installation checks of manually disabled providers without starting their CLIs, and makes missing providers inactive across their accounts without interrupting running work. Account folders and credentials are never searched.

## Desktop runtime folders

Known install folders include the executable locations of an installed desktop application, declared by its provider module (layout evidence (private research note)). Fixed CLI paths precede versioned runtime folders, which are read numeric versions newest first and hash builds by directory modification time, a root's own executable after its builds; detection then keeps the newest version of all those found (below). The resolver enumerates at most 128 immediate entries per folder, at most one build level inside each version, newest version first, filters version/build names, follows no directory links in that enumeration, and never searches surrounding application data or account/configuration folders. Detection and launch share this resolution, with no persisted version path, PATH modification, new file writes or account import. An inaccessible or oversized runtime directory is inconclusive for passive discovery. Existing CLI version/protocol checks remain required after a file is found. Missing detection says **CLI not found**; it does not assert that the desktop application is absent. A CLI found by an override or in a known install folder is often not on the user's terminal PATH: **Open a terminal to sign in** runs its login command by the file's full path, built in main, which keeps that path out of app state; the account's row shows the command by the CLI's name and says a terminal of the user's own may not find it.

## The newest version found

Where a CLI sits says nothing of which copy is newer: the Codex app left its root `codex.exe` at 0.130 while its newest build folder held 0.167, and a machine with no other Codex ran the old one, without the newer models. So, at the maintainer's direction, detection — at start, on **Redetect / reconnect** and whenever a provider's preferences or availability change — asks the resolver for every CLI it finds (PATH, fixed folders, then the desktop folders, each copy once, eight at most), runs each one's own `--version`, and keeps the newest by semantic version precedence, a prerelease included (`0.167.0-alpha.3.2` above `0.164.0`). A copy whose check fails is passed over; a version that cannot be read sorts below every one that can; of two equal the earlier in that order is kept. A path override is the user's choice and is used alone. Each check takes tens of milliseconds. Passive discovery stays metadata-only ([0037](0037-provider-discovery.md)): it asks only whether a CLI is present.

Accounts places a short recommendation for automatic detection beside a keyboard-accessible **How to find the CLI executable** disclosure. It gives the current platform's terminal lookup command, static example folders supplied by the provider module, how to choose the CLI file and save a literal absolute path, and how to clear an override after an update. Examples contain placeholders, never a detected user path. Opening the help runs no command, reads no file, changes no preference and stays available with read-only preferences. The first-run guide points to it.

On macOS, the Codex descriptor also declares the CLI shipped inside an installed `ChatGPT.app`. The known-folder search checks that exact executable under `~/Applications` and `/Applications` after PATH. Launch uses the same resolver as discovery and the same documented app-server protocol. The bundled CLI's presence is independent of its sign-in status. [Codex app-server documentation](https://developers.openai.com/codex/app-server)
