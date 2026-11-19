# Test suites

This is the source of truth for choosing verification. Ordinary work finishes with targeted checks. Finishing a request or making a commit does **not** trigger every node/renderer test, full lint, or the full Electron smoke suite. Broaden only for an affected boundary or one of the gates below, and say why.

## Everyday checks

Use [`do-check.bat`](../do-check.bat) on Windows. Elsewhere, `npm run check:focused -- <options>` runs the same selector. It uses explicit area mappings and adjacent/module tests, without following the entire import graph.

```bat
do-check.bat list
do-check.bat focused
do-check.bat list --files src/renderer/src/sessions/Capsule.tsx
do-check.bat focused --files src/renderer/src/sessions/Capsule.tsx --area drafts
```

- With no file arguments, selection includes staged, unstaged and untracked changes against `HEAD`. Deleted and renamed files still select tests; missing files are omitted from lint. Use `--since <ref>` to include committed changes since a ref as well.
- With unrelated edits already in the checkout, use `--files <repository-relative paths...>` for the current task. `--area <name>` adds consumer coverage; repeat it for several areas. `--areas` lists the names. `--files` and `--since` are alternatives.
- `list` shows each selected test file and its reason without running checks. Review that plan for the behavior changed. Shared contracts need their affected consumers added explicitly; one field in a shared IPC file does not automatically require every consumer's test.
- `focused` runs lint on selected existing JS/TS files, one cached-project typecheck, then selected tests. ESLint or TypeScript configuration changes widen lint to the whole checkout. Package-script edits alone do not.
- `test` runs only the selected tests; `lint` runs only the selected lint files. A directly supplied test file runs by itself unless an area is added. During iteration, rerun the failing/relevant file, then run `focused` once when the implementation settles.
- Documents alone run no code checks. No selected tests for a code/fixture change is an error, rather than an empty Vitest invocation that accidentally runs everything. Specify the relevant test files/area when the selector cannot infer them.
- The selector is in [`scripts/lib/check-plan.mjs`](../scripts/lib/check-plan.mjs). Add a small area entry when a feature spans modules. New providers also select their provider/process tests; store and process changes select their crash/process tests. Fixture/capture changes need their consumers named explicitly.

No automatic selector proves complete coverage. Include relevant failure, navigation, privacy and IPC-boundary checks; use judgment for dependencies and cross-cutting changes. Do not broaden or repeat successful runs merely because work is about to be handed back. Do not run heavy suites concurrently: process-recovery deadlines can fail under contention.

## Gates and commands

| Suite | When | Command / scope |
|---|---|---|
| **Spot check** | During editing | `do-check.bat test --files <test paths>` or a selected area |
| **Focused** | Ordinary work, once the implementation settles | `do-check.bat focused --files <changed paths> --area <affected consumer>`; changed-file lint, typecheck and selected tests |
| **Pre-push full** | Before every push of code; documents-only pushes and CI fix-ups excepted | `do-check.bat full` / `npm run check`: full lint, typecheck, tooling tests and all Vitest groups, about 20 min; then the full smoke and every smoke scenario, at least 10 min more. CI runs no smoke, so a push's smoke runs here. |
| **CI fix-up** | After CI fails on code that passed full checks locally | Failing files alone, then targeted checks; push naming only the failed systems |
| **Scenario smoke** | Part of pre-push full; alone, when a changed UI/IPC workflow needs proof through the real preload and Electron | `do-check.bat smoke new-chat`, `session-search`, `avatar-family` or `data-reset`; `do-check.bat smoke all` runs each in turn |
| **Full smoke** | Part of pre-push full; alone, for broad startup, shutdown, window lifecycle, provider launch/recovery or persistence/restart changes; or an explicit acceptance requirement | `npm run smoke`; all three fixture launches, process/privacy checks; about 10 min. A small IPC payload or button change does not alone trigger it. |
| **Milestone acceptance** | The milestone's agreed verification | Pre-push full; `npm run package:smoke`, then `npm run smoke:packaged`; CI on requested systems. macOS is opt-in, as in AGENTS.md. |

The `new-chat` scenario checks the initial screen, preset changes, retained text/images/Plan and the draft selection IPC through the real bridge. It also verifies Main-only image refresh, unchanged metadata, changed preview ids and decoding the replacement through the real media route. The `session-search` scenario checks Main-only search access, service readiness, the dialog, filters and focus restoration. They each start one fixture-only app in a separate temporary data folder, check cleanup, and report their scenario name. They do not replace provider recovery or restart/privacy coverage in full smoke. More scenarios should reuse the existing check functions rather than copy their assertions.

The npm equivalents are `check:plan`, `check:focused`, `test:focused`, `lint:changed`, and `smoke:scenario -- <name>` (or `-- all`). `npm run check` and CI both run every test, `npm run test:tooling` included; only `npm run check` runs the smoke. Full commands are explicit and are not launched by the targeted command.

## Test groups

Vitest's environment groups remain unchanged ([`vitest.config.ts`](../vitest.config.ts)); they are scheduling groups, not the everyday selection policy:

| Group | What it holds | Full group, approximately |
|---|---|---|
| **node** | Main, preload, shared contracts and repository architecture checks | 40 s |
| **renderer** | React/jsdom and `tests/chat/` | 2 min |
| **process-trees** | Process, provider, conversation crash, fake replay and parity tests | 17 min |

Tooling checks use Node's test runner. Typecheck takes seconds with its build cache; full type-aware lint can take a minute or more. The selected files and machine load matter more than the number of individual assertions.

Screenshot-setup tooling checks (`scripts/dev-setup.test.mjs`) use synthetic temporary data to verify repeatable copies, preserved SQLite WAL content, path/link confinement and a windowless real-Electron lock check (skipped on Linux without a display server). They open no personal app data or installed CLI.

## Coverage notes

About checks cover tab navigation and readable attribution/license text with read-only preferences and no IPC. License tooling checks cover multiple license files, separate NOTICE text, missing/empty texts and lost attribution. Packaging checks preserve the exact root license and full collected dependency notices; macOS notice-file presence is mandatory. For SPDX-only edits, verify that removing the inserted comments restores the previous source bytes; behavioral checks can stay focused on functional changes and source-reading architecture tests.

Package-output tooling checks cover a shared named output for the build and audit, unchanged default folders, preservation of another packaged copy, and refusal of path traversal, Windows device names, links/junctions and invalid options before cleanup. A real candidate build and `verify-package.mjs release --output <name> --tamper` verify the alternate folder end to end; the normal packaged smoke runner still uses `release/smoke/`.

M105 tests replay four versioned, allowlisted lifecycle projections separately from synthetic parallel-tool, worker/wait and stale-event faults. Interrupt tests wait for provider work explicitly: the immediate Thinking fallback is not proof that a provider frame has arrived. Fake clocks cover main-owned 2,000 ms display deadlines across remounts; animation models cover 100%/25% capsule targets, width-adjusted full-size waits and resizing, interrupted ramps, phase, independent capsules, hidden windows and live reduced motion. Full and packaged Electron smoke also measure actual compositor rates/positions, width-adjusted Main waiting and unchanged mini pace, immediate decision pauses and live reduced motion. For visual review, `do-run-stream.bat` (or `do-run-stream.bat packaged`) accepts `states`, `states held` and `states lost`; these deterministic third-provider scripts spend no model turn and add no avatar art. Review both themes, Main's normal/minimum size and both mini sizes. The implementation record is M105 (private).

Avatar checks cover eligible family preview choices, the saved selection after refused writes, editing without selecting, the separate specific-avatar dialog, nested close and focus restoration, and Make a copy: unchanged artwork, styles, matches and licence; exclusive numbered names; path and link confinement; failure cleanup; and the immediate switch into the editable copy. Smoke checks the new Main-only channel too.

The audio checks cover the folder's exclusive default copies, file confinement and signatures, event preferences (including rollover defaulting to Off), UI delegation, bounded playback and notification priorities. Packaging checks the twelve selected default files, including the imported WAV and MP3 sounds, while preserving the remaining generated effects' quiet PCM bounds. Smoke plays every enabled default to completion, muted, through `app://media/audio`: a streamed sound may have infinite duration at metadata load. It reports missing or failed defaults by bundled filename and permits retained old sounds in the catalog. It also checks that the mini window cannot read the catalog or request session cues, and confirms exactly one successful playback while Main is minimized. The notification tests also cover new blocking and nonblocking question cards, sub-agent requests, shared plan versions, review rounds, error outcomes and suppression of generic Ready. These checks run in packaged smoke too.

Window smoke checks also cover the mini window's automatic hiding: Main gaining and losing focus, minimizing and restoring, changing the option while Main is focused, preserving the enabled preference, and leaving a disabled mini window hidden. They drop its native always-on-top state while hidden and verify that returning repairs it; subsequent shows after minimizing, disabling auto-hide and enabling the title toggle must also stay on top without taking focus. Enabling it from the title toggle shows it while Main keeps focus, through unrelated preference writes, with automatic hiding resuming on the next Main focus. Opening Main without a session restores and focuses it while preserving its selection. The same mini window is reused, and showing it never takes focus.

The architecture tests are inside the node group. They read stylesheets and the source tree directly rather than importing them, so a change to a `.css` file can break one without touching any test's imports. The targeted selector adds the relevant architecture readers explicitly, including the stylesheet tests for CSS changes. This does not require the whole node group.

Vitest's `--changed <ref>` was tried as the focused selector and is not used: a change to a shared contract reaches nearly every test through its imports, and the run took 17.5 minutes.

Session-search checks cover the read-only message projection, post-commit invalidation, typo/prefix matching, filters, paging, deletion and reset races, safe excerpts, debounce and keyboard behavior. Smoke exercises the real Main-only IPC, lazy indexing, dialog controls and focus restoration; packaged smoke also verifies MiniSearch is shipped. The synthetic benchmark is opt-in and uses no personal data:

```powershell
$env:FATG_SEARCH_BENCHMARK = '1'
npx vitest run src/main/sessions/search/benchmark.test.ts --reporter=verbose --silent=false
Remove-Item Env:FATG_SEARCH_BENCHMARK
```

It reports cold indexing, warm and broad-query time, heap growth and yield counts for 10,000 synthetic messages (50 MiB). Timing is diagnostic, not a machine-dependent pass threshold.

Visible-file refresh checks cover metadata-only changes, stable/unstable reads, replacement saves, deletion and recreation, lock/access failures, deadlines, current trust and path confinement on Windows/macOS/Linux rules, Main-only IPC, quiet failure recovery, selection/visibility pauses, stale-result races, scroll/focus preservation and the toolbar's update clock. Smoke checks the real Main-only refresh endpoint with both unchanged metadata and a stable reread, and refusal from the mini window. For a visual check, run `do-run-dev.bat`, open a Markdown or supported text artifact, save it in an editor, and check its timestamp and scroll position. Temporarily making the file unavailable should leave its text visible with only the small failure label; restoring it should recover automatically.

Image-file preview checks cover content revisions at the same path and dimensions, fresh lookups for later answers and thumbnail presses, existing-tab updates, missing files and late reads after leaving the chat. Visible image refresh tests cover metadata-only polling without image reads, timestamp-only saves, stable changed reads and rapid-save retries, deadlines, excluded folders, immutable attachments, Main-only IPC, background pauses, selected artifacts only, decode-before-replace, quiet failure recovery, stale replies and update-clock lifetime. Generated-image preview checks cover bounded Codex live/history extraction, a real replay payload above the former 4 MiB chat envelope, history images above the shared connection's base limit, per-method reply budgets and their reset, the runtime-to-store-to-chat path, retained files and removal, worker ownership, explicit validation/save failures and shutdown draining. The replay fake's oversized-line faults now exceed the 32 MiB Codex chat/history envelope. Ordinary account replies, requests and notifications retain their smaller limit. No real image-generation request is needed for these checks; live generated-image protocol/lifetime measurements remain M25's separate spike.

## What CI runs


On every push of code; a push of documents alone runs nothing ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

| Job | Systems | Time |
|---|---|---|
| Lint and typecheck | Linux, once | ~2.5 min |
| Test and build: `npm test`, then `npm run build` | Windows and Linux | Windows ~23 min, Linux ~13 min |
| Package and audit: `npm run package`, then `scripts/verify-package.mjs` | Windows and Linux | Windows ~3 min, Linux ~1 min |

macOS runs only when the last commit's message asks for it (`[ci macos]`, or `[ci all]` for all three systems), and a commit naming systems (`[ci linux, windows]`) runs on those alone.

## A failure in a large run

The machine often runs heavy work in parallel. A test that fails in the full suite or in the process group may be a timing flake: rerun its file alone before calling it a regression. A failure that repeats when its file runs alone is real.

### Windows agent sandboxes

An agent's restricted execution sandbox can prevent Electron's GPU process from starting and make Windows `taskkill /T /F` return Access denied even for a child that the test just launched. This can produce GPU startup errors, process-cleanup failures in smoke, and failures in the real-process tests while mocked shutdown tests pass.

If either happens under an agent sandbox, rerun the failing file or scenario outside that execution sandbox with the tool's required approval, or from the maintainer's terminal using `do-check.bat`. Keep Electron's own renderer sandbox and the process-cleanup assertions enabled. A sandboxed failure alone does not establish an application regression; record the results of both runs, and investigate a failure that also occurs outside it. Keep heavy runs sequential there too.

Naming model checks cover numeric family versions and dated revisions, hidden and override-only exclusions, account-local catalog refresh, the automatic small-model default, explicit session and fixed choices, missing-model fallback, and revision-23 refusal of older preferences without changing their files. No live model request is needed.


The `avatar-family` scenario drops a real image onto the new-family area, decodes its two previews, creates a Default-only family and one with a matched avatar, and checks the editor handoff, compact Technical details position, duplicate-name refusal, cancel focus restoration, Main-only IPC and the preload image bounds. Full smoke reuses the same checks. `FATG_SMOKE_VISUAL_DIR` optionally captures the creation dialog in both themes and the updated family listing. Targeted tests additionally cover portable names, image signatures and dimensions, exclusive reservation races, failures at each write, link confinement and cleanup, retryable UI refusals, and untouched provider selections.

Project-folder opening checks cover saved and newly picked roots, unchanged drafts and trust, retryable failures, refusal before filesystem lookups for unadmitted paths, missing/non-directory targets, macOS bundle symlinks, strict requests and mini-window refusal. The shared records smoke check exercises the new Main-only channel through the preload in each scenario.

Provider discovery checks cover first launches with no/one/several installations, a synthetic third provider, acknowledged restarts, manual disables, addition/removal/return, inconclusive metadata reads, cooldown/coalescing/deadlines, stale overrides and shutdown, deferred runtime cleanup, invalid overrides on Windows/macOS/Linux resolution rules, notice acknowledgment, modal priority, Accounts navigation, and Main-only privacy/IPC. Select `do-check.bat focused --area provider-discovery`. Full Electron smoke exercises the real initial dialog, Got it focus and dismissal, unchanged manual rescans and mini-window refusal in the demo and live launches. Later synthetic executable changes are acknowledged through the real IPC so their automatic notices do not interrupt unrelated smoke dialogs. No installed CLI or personal account is used.

Full-data reset checks: `do-check.bat focused --area data-reset` covers exclusive durable requests, invalid/incompatible or linked markers, no-op startup, partial failures and retry, root/path confinement, symlinks/junctions, hard links, SQLite overwriting, lock preservation, two default-Cancel confirmations, Main-only IPC and graceful quit without a third question. `do-check.bat smoke data-reset` runs two real Electron launches in `fatg-smoke-data-reset` under the temporary folder, separate from normal/dev/full-smoke data. It cancels each confirmation once, confirms the reset, checks the real quit leaves the old data and request in place, then verifies startup erases old custom files while preserving a fixture project file, restores defaults/browser zoom and presents first-install detection. No installed CLI or personal account is used. Full smoke remains the broad startup/shutdown gate.

Desktop CLI discovery checks cover the registered Windows/macOS bundle layouts, Linux isolation, stable executables and version/hash ordering, updates and incomplete folders, override/PATH/ordinary-install precedence, fixture isolation, metadata-only bounded enumeration, directory-link refusal and inconclusive access failures. Include `src/main/services/desktop-cli-discovery.test.ts` and `src/main/process/install-children.test.ts` with the provider-discovery area; provider launch changes also require full smoke. No personal account or authentication is needed.

Accounts executable-help checks in `SettingsDialog.test.tsx` cover platform-specific commands/folders supplied by a provider, disclosure and focus with read-only preferences, and no IPC or preference changes when the help opens. Existing Accounts checks cover selection, saving, Browse, reconnect and login alongside the disclosure. This static help adds no IPC workflow or provider-launch behavior.

Stored-format baseline checks: `do-check.bat focused --area baselines` runs `tests/baselines/`, which holds every build to the committed baselines in `tests/fixtures/baselines/` ([decision 0014](decisions/0014-format-compatibility-starts-at-first-release.md#baselines-091)): one file of each format at the version the build writes and nothing else, each current one reproduced byte for byte by recording again into a scratch folder, and every one read by the current reader as compatible, with its content. A change to a format's module, its writer, a baseline or the recorder selects the area. A raised format fails the check until `do-record-baselines.bat` records the new version's file: before the release tag with the old one deleted first, after it kept beside a migration. The checks use scratch folders under the temporary folder and no app data.
