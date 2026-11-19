# Spikes (S1)

Throwaway experiments that answer "how do these CLIs *actually* behave?" before application code depends on the answer. They are **not** part of the app build and deliberately ignore the project's layering. Their lasting products are:

- redacted fixtures in `tests/fixtures/{claude,codex}/`, and
- the decision in [`docs/decisions/0001-claude-usage-tier.md`](../docs/decisions/0001-claude-usage-tier.md).

> **Status:** run on Windows 11 (Node 24.19, codex-cli 0.155.1, Claude Code 2.1.268, Agent SDK 0.3.278). Results are written up in [decision 0001](../docs/decisions/0001-claude-usage-tier.md) and the "S1 findings" section of the Phase 1 plan (private). Not yet run on macOS or Linux.

## Prerequisites (maintainer)

Node 24 LTS, plus `claude` and `codex` installed and **logged in via their own flows** (`claude auth login`, `codex login`). Agents must never perform logins or handle credentials — see [decision 0004](../docs/decisions/0004-never-touch-credentials.md).

## Run

```bash
node spikes/codex-app-server.mjs
```

```bash
npm install --prefix spikes
```

```bash
node spikes/claude-usage.mjs --probes 10
```

Options: `--path <executable>` overrides detection. `claude-usage.mjs --no-strict-mcp` drops `strictMcpConfig` to show the account-level connectors that otherwise attach to the probe session (scope and status only; names are never printed). `claude-usage.mjs --try-slash-usage` additionally tests Tier 2 by sending `/usage` as a prompt — **this may spend a small number of tokens** if the CLI doesn't handle it locally, so it's opt-in.

## S2 — Claude control protocol without the SDK (M7b)

```bash
node spikes/claude-control.mjs --probes 10
```

It answers M7b's go/no-go table (private). It speaks the CLI's stdio control protocol directly (no Agent SDK import), from a normal-launch environment in which every inherited `CLAUDE*`/`ANTHROPIC*`/`DEBUG*` variable is removed, so the CLI is never told it is talking to the SDK. It sends `initialize` and `get_usage`, plus `mcp_status` and one deliberately unknown subtype on the second probe. No prompt, no login, no quota use.

It judges shapes with the production `normalize.ts`, bundled on the fly with the root `esbuild`. It prints only types, counts, key names and yes/no answers; the same summary goes to `spikes/output/`. **Re-run it when a CLI update breaks Claude usage** (the app falls back to the account-only panel). Result (CLI 2.1.268): go.

Two companions:

```bash
node spikes/capture-sdk-wire.mjs
```

It records what Agent SDK 0.3.278 sends for fat-g's options, run against the *fixture* CLI (no real account), into `tests/fixtures/claude/sdk-0.3.278-wire.json`. That file is the reference for fat-g's own client. It uses this folder's SDK install (`npm install --prefix spikes`), which the app no longer ships.

```bash
node spikes/claude-acceptance.mjs
```

It runs the **production** Claude adapter — control client, process layer, production timings — against the installed CLI through three generations with two reads each. It prints kinds, counts and timings, and the image names of any child process left behind (there should be none).

## M10 — decisions and spikes (`spikes/m10/`)

Plan: docs/planning/_archive/M10.md (private). Findings: turn-tracing.md (private research note), models-and-effort.md (private research note), projects.md (private research note) §4.

**Run on Windows only.** The helpers' POSIX path (`ps`, process groups) is written but was not exercised in M10. Everything here is plain Node with helpers of its own under `spikes/m10/lib/`. It imports nothing from the older spikes above or from `src/`, and never runs the Agent SDK (the SDK's types were reading material). The one Electron script is the font page. Run from the repository root. No npm install is needed.

| Step | Command | Launches | Spends | Leaves behind |
|---|---|---|---|---|
| 0 | `node spikes/m10/selftest.mjs` | The stand-in only (Node), through `node.exe` and a `.cmd` shim | Nothing | `spikes/output/m10/selftest/` |
| 1 | `node spikes/m10/preflight.mjs` | `--version`, `auth status` / `login status`, `--help` | Nothing | `preflight.json`: versions and two booleans |
| 2 | `node spikes/m10/schema.mjs` | `codex app-server generate-json-schema` (plain and `--experimental`) | Nothing | `schema/` |
| 3 | `node spikes/m10/discover.mjs` | Idle sessions: Claude three, Codex one | **No turn** (fails if a turn frame arrives) | `discovery-<cli>.json`, raw captures |
| 4 | `node spikes/m10/trust.mjs` | Codex one idle thread; Claude two idle sessions | No turn | `trust.json`, raw captures, the marker folder |
| 5 | `node spikes/m10/usage.mjs --label before` | One read per CLI | Nothing | `usage-before.json`: percentages only |
| 6 | `node spikes/m10/trace.mjs --cli <claude\|codex> --scenario t1..t8` | Nothing: prints the plan and the turn count | Nothing | Nothing |
| 6′ | … `--confirm-turns <n>` | One session | **n turns** (T2 and T8: 2, the rest 1) | A raw capture, a ledger entry |
| 7 | `node spikes/m10/usage.mjs --label after` | One read per CLI, after a 90 s wait | Nothing | `usage-after.json` |
| 8 | `node spikes/m10/history.mjs` | Codex `thread/list`; one idle Claude resume attempt per traced session id | Nothing | `history.json` |
| 9 | `node spikes/m10/publish.mjs [--dry-run]`, then `--check` | `claude auth status`, one idle Codex connection (account values for the leak check, kept in memory) | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` |
| 10 | `node spikes/m10/fonts/run.mjs` | The repository's Electron, network blocked | Nothing | `spikes/output/fonts/` |

- **One invocation is one run** of one scenario on one CLI. A retry is a new invocation, and the run ledger (`spikes/output/m10/ledger.json`) refuses a fourth run, a third void run, or a run of a scenario that already happened (without `--again`). A run spoiled by the spike's own defect is marked with `trace.mjs --mark-void <run id> --defect "…"`; its turns stay counted.
- **Deadlines** (in `lib/deadlines.mjs`): startup 30 s, each request 15 s, scenario 240 s, shutdown 20 s. Each invocation has a 480 s budget that ends it through the same path as Ctrl+C, inside the 10-minute limit of an agent's shell tool.
- **Cleanup:** every launched tree is recorded (pid, parent, start time, image name; never a command line) and confirmed gone on every path. `spikes/output/m10/launched.json` names what is running; a spike that finds a recorded process still alive stops, names it and ends nothing. Exit codes: 0 happened, 10 did not happen, 11 timed out, 12 not run, 13 void, 2 CLI missing or logged out, 3 cleanup unconfirmed, 4 recorded process still running, 5 run cap reached, 130 cancelled.
- **Environment:** every inherited `CLAUDE*`, `ANTHROPIC*`, `DEBUG*`, `ELECTRON_*` variable and `NODE_OPTIONS` is removed; the SDK's identity variables are never set.
- **What the CLIs keep:** Codex threads are started `ephemeral` and were not in `thread/list` afterwards; Claude sessions run with `--no-session-persistence` and could not be resumed afterwards. The CLIs' own records of working folders grow by the three scratch folders under the temp folder (`fat-g-spike-trace`, `-trust`, `-probe`), rebuilt per invocation. Also under the temp folder: `fat-g-spike-trust-markers` (the trust spike's marker scripts) and `fat-g-spike-fonts` (Electron's user data for the font page). All are safe to delete.
- **Font files** are fetched by the maintainer, or by an agent with the maintainer's go-ahead per file, into `spikes/output/fonts/files/<inter|tex-gyre-heros|liberation-sans>/`.

**V2 and V27 text searches** (run by the self-test over `spikes/m10/` only; the older spikes above import the SDK and are out of scope). The expected hits are:
- `.claude/settings.json` in `trust.mjs`: the scratch trust project's *own* settings file, which the spike writes.
- `planted-user\.codex\…` in `standin/stall-cli.mjs`: made-up paths the stand-in plants to prove `config/read` is reduced (V21).
- The SDK identity variable names in `lib/env.mjs`: the list the environment builder asserts is absent.
- No SDK import, no import leaving `spikes/m10/`, no read of a process command line.

## M14b — provider instances (`spikes/m14b/`)

Plan: docs/planning/_archive/M14b.md (private), Design 1. Findings: multiple-accounts.md §8 (private research note).

The question: does each CLI keep one login per configuration folder, so that the same CLI started with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` naming another folder is another account, at the same time as the first? Plain Node, run from the repository root, with M10's launcher, deadlines, process-tree check, launch record, leak check and drivers imported from `spikes/m10/lib/`, and two helpers of its own under `spikes/m14b/lib/`.

| Step | Command | Launches | Spends | Leaves behind |
|---|---|---|---|---|
| 1 | `node spikes/m14b/instances.mjs --part 1` | Per CLI, two processes at once, twice: one in your own configuration, one with the variable naming an empty scratch folder, then one that does not exist. Claude: `auth status`, then a control session that sends `initialize` only. Codex: an app-server that sends `initialize`, `account/read`, `account/rateLimits/read` | **No turn** (fails if a turn frame arrives) | `spikes/output/m14b/part-1.json`; two empty login folders under the temp folder; the two login commands, printed |
| — | The two login commands part 1 prints, **in your own terminal** | Each CLI's own login, with the variable set | Nothing | A login in each scratch login folder |
| 2 | `node spikes/m14b/instances.mjs --part 2` | Per CLI, two processes at once: your own configuration and the login folder. The same requests, plus one `get_usage` per Claude side | No turn | `spikes/output/m14b/part-2.json`; the scratch folders deleted (`--keep-login` keeps the login folders) |

- **Two launchers.** M10's launcher refuses a launch until its earlier tree is confirmed gone, so each side has a launcher and a launch record of its own (`spikes/output/m10/launched.json` and `spikes/output/m14b/launched-second.json`); both records are checked before anything is launched. Exit codes are M10's; 0 means the part showed what it set out to, 10 that it did not.
- **Environment.** M10's clean environment on both sides, so no inherited `CLAUDE*` or `ANTHROPIC*` variable reaches either; the folder side sets the one variable on top. Claude's own side therefore runs in its default folder even when `CLAUDE_CONFIG_DIR` was inherited; an inherited `CODEX_HOME` is kept on Codex's own side. The report names, never values, what was inherited.
- **Scratch folders:** `fat-g-spike-m14b` under the temp folder, with the spikes' marker file, holding `<cli>-empty`, `<cli>-absent` and `<cli>-login`. Each part deletes the ones it used once every process is confirmed gone. A login a CLI keeps outside its folder is neither looked for nor touched.
- **What it reads of a folder:** whether it is there, and one listing of its top-level entry names after its processes are gone, with anything id-like in a name replaced. No file in a folder is opened.
- **What it writes down:** booleans, kinds, key names and entry names. Emails, plans and usage readings are compared in memory and never written; the report passes M10's leak check before it is written.

## M15 — live slice: Codex (`spikes/m15/`)

Plan: docs/planning/_archive/M15.md (private), Design 1. Findings: turn-tracing.md §6 (private research note). Run on Windows with codex-cli 0.155.1: 17 turns.

What M10 did not trace: a saved thread, its resume from another process, the history reads, the refusals, large output and two worker cases. Plain Node, run from the repository root, with M10's launcher, deadlines, process-tree check, launch record, ledger, redactor and leak check, and one helper of its own, `spikes/m15/lib/common.mjs`. M10's rules hold: one invocation is one run, three runs at most per scenario, and every script prints its plan and its turn count and launches only with `--confirm-turns` equal to it.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| 1 | `node spikes/m10/schema.mjs`, then `node spikes/m10/usage.mjs --label before --cli codex` | Nothing | The schema, a usage reading |
| 2 | `node spikes/m10/trace.mjs --cli codex --scenario t1 --again` (and `t3`, `t4`, `t5`), then `node spikes/m15/recheck.mjs` | 1 turn each | Raw captures; `spikes/output/m15/recheck.json` |
| 3 | `node spikes/m15/resume.mjs --scenario saved`, then `resume` | 1 turn each | The saved thread; its id and its live item ids in `spikes/output/m15/state.json` |
| 4 | `node spikes/m15/history.mjs` | Nothing | A raw capture |
| 5 | `node spikes/m15/resume.mjs --scenario refusals`, `empty`, `earlystop`, `outside`, `parallel` | 0, 0, 1, 1, 2 turns | Raw captures |
| 6 | `node spikes/m15/output.mjs` | 1 turn | A raw capture, its long strings cut |
| 7 | `node spikes/m15/workers.mjs --scenario interrupt`, then `outlive` | 1 turn each | Raw captures |
| 8 | `node spikes/m15/resume.mjs --cleanup` | Nothing | `cleanup.json`: the saved threads found, deleted and left |
| 9 | `node spikes/m10/usage.mjs --label after --cli codex --no-wait` | Nothing | A usage reading |
| 10 | `node spikes/m10/publish.mjs --cli codex --include <T6's run id> --only <names, with commas>`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/codex/captures/` |

- **Saved threads.** These scenarios cannot be `ephemeral`. Every thread starts in the scratch folder `fat-g-spike-m15` under the temp folder (a second one, `fat-g-spike-m15-outside`, holds the file one turn reads from outside it), so step 8 finds them by that folder with `thread/list` and deletes each with `thread/delete`. Both methods are the spike's alone; the app sends neither. Run step 8 last: steps 3 and 4 need the saved thread.
- **Raw output** goes to `spikes/output/m15/`: a ledger of its own, the raw captures, and a second launch record for the scenarios that run two processes at once. A string over 32 KiB is cut before anything keeps it, with its length noted.
- **Publishing a family.** The saved thread's two live captures and its history read name one `family`, and `publish.mjs` redacts them with one set of aliases, oldest first, so an id is the same alias in the three. Publish them in one invocation.
- **The app-server is started in another folder than the thread's**, as the app starts it: the thread's folder goes in `thread/start` only.

### M15 acceptance follow-up: timed forced exit (Windows)

`node spikes/m15/forced-exit.mjs` prints its plan and launches nothing. To run one announced model turn:

```powershell
node spikes/m15/forced-exit.mjs --cli "$env:APPDATA/npm/codex.cmd" --model gpt-5.6-terra --effort low --confirm-turns 1
```

Use a model and effort the installed CLI reports. `--delay-ms 3000` waits three additional seconds after `turn/started`, before process discovery and the kill. The diagnostic refuses a completed turn as evidence of an active-turn kill. It requires Windows process enumeration permissions.

This follow-up is separate from the original capture/ledger workflow above: a timestamped report per run under `spikes/output/m15/forced-exit-*.json` holds its submitted-turn count, PID/creation-time identities, liveness observations and fixed resume-result classifications. It builds `forced-exit-parent.ts` into the same ignored folder. The parent uses fat-g's real process layer and session handshake; the controller kills **only that disposable Node parent**, never the running Electron app. It samples the recorded descendants every 100 ms for at most 90 seconds, probes resume without further prompts, and cleans recorded survivors after measuring. Resume-probe refusals are classified in memory; their raw text and conversation content are not saved.

The diagnostic creates an empty `fatg-exit-acceptance-*` scratch folder under the system temp directory, with separate `project` and process-layer `data` folders. It leaves the scratch folder and its conversation in Codex history; the report holds their private paths/reference for follow-up. No existing fat-g session, records file, account file, or user project is modified. Reports and bundled output are gitignored; publish only the redacted measurements in turn-tracing §7 (private research note). These timings do not replace the actual Electron application's forced-exit acceptance.

### M15 next live test with the actual app

1. Close the existing fat-g development window. In a separate terminal at the repository root, run `npm run trace:live`.
2. Keep that terminal open. It prints the trace filename and fat-g's main PID. Once a turn has started, allow at least two seconds for process discovery, then end **only that main PID** in Task Manager's Details tab. Do not end the terminal, development launcher, CLI, or whole tree.
3. Type `r` then Enter in the terminal to reopen fat-g in the same trace. Send a follow-up promptly; if refused, retry later and note approximately when. The launcher never sends a prompt for you.
4. Once recovery has been tested, close fat-g normally and type `q` then Enter to finish the trace. Share the printed `spikes/output/m15/live-trace-*.jsonl` file for diagnosis. It is gitignored and capped at 8 MiB.

`FATG_TRACE_LIFECYCLE=1` is honored by unpackaged builds only. The app emits process spawn/exit/pipe-close/stop/cleanup events, request/reply metadata and turn boundaries. Resume replies name a fixed `active-writer` or `other` classification plus the numeric error code. No CLI text, session/thread IDs, model/account data, paths or request/reply bodies are written. Request numbers are local to each process; use `appPid` + `pid` + `request` to correlate them. The external observer saves only PID, parent PID and creation/observation times, follows recorded descendants after their parent disappears, and distinguishes PID reuse. Polling runs sequentially with a 250 ms pause between Windows process snapshots; use `lastSeenAt` and `at` as the exit interval. A failed observation is recorded and proves nothing about that interval.

The observer must be allowed to enumerate Windows processes and write the trace in the development checkout. It never reads CLI account files or launches a CLI of its own. Ordinary build/console output is displayed but not saved. `q` stops recording without terminating fat-g or its providers. This live trace complements the controlled diagnostic above and does not itself pass V16/V49.

## M16 — live slice: Claude (`spikes/m16/`)

Spec sheet: docs/planning/_archive/M16-spec-sheet.md (private), its spike items K1 to K27. Findings: turn-tracing.md §8 (private research note). What the app took from them is [decision 0020](../docs/decisions/0020-claude-chat-sessions.md); the published captures are what its replay fake sends (`tests/fixtures/claude/replay.mjs`), so a capture taken again for a new CLI version is a change to the tests that read it. Run on Windows with Claude Code 2.1.268: 46 prompts, K22's one, and nine for K23 to K27.

What M10 did not trace for Claude: a chat session's own launch (the user's setting sources, saved sessions, a model and an effort), its resume and the launches that fail, what holds it to its tools and folders, the worker cases, a Stop hook, and prompts that name the CLI's commands. Plain Node, run from the repository root, with M10's launcher, deadlines, process-tree check, launch record, ledger, redactor and leak check, M14b's configuration-folder helpers, and one helper of its own, `spikes/m16/lib/common.mjs`. M10's rules hold: one invocation is one run, three runs at most per scenario, and the script prints its plan and its turn count and launches only with `--confirm-turns` equal to it.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| 1 | `node spikes/m10/trace.mjs --cli claude --scenario t1 --again --confirm-turns 1` (and `t3`, `t4`, `t5`, `t7`), then `node spikes/m16/recheck.mjs` | 1 turn each | Raw captures; `spikes/output/m16/recheck.json` (K1) |
| 2 | `node spikes/m16/trace.mjs --list` | Nothing | Nothing: the scenarios and their turn counts |
| 3 | `node spikes/m16/trace.mjs --scenario discover --confirm-turns 0`, then `--scenario usage --confirm-turns 0` | Nothing | The model and effort the other scenarios name, in `spikes/output/m16/state.json`; a usage reading |
| 4 | `--scenario saved`, then `resume`, `failures`, `effort`, `parallel`, `named`, `replay` | 1, 1, at most 1, 1, 2, 2, 1 | The saved session, its id in `state.json` (K2 to K7) |
| 5 | `--scenario report`, `outside-asked`, `outside-added`, `rule`, `worker-write`, `agent-defined`, `agent-allowed`, `worktree` | 1 each | Raw captures (K14, K8, K9, K10, K15, K21) |
| 6 | `--scenario worker-interrupt`, `early-interrupt`, `background`, `background-disabled`, `self-turn`, `large-read`, `stop-hook`, `commands`, `commands-disabled` | 1, 1, 1, 1, 2, 1, 1, 6, 3 | Raw captures (K11, K16, K12, K17, K13, K18, K19) |
| 7 | `--scenario chat-t1`, `chat-t3`, `chat-t4`, `chat-t5`, `chat-command`, `chat-early-interrupt` | 1 each, the last two reaching no model | The captures the replay fake replays (K20, and K22's interrupt before `init`, added), taken last: with `--disable-slash-commands`, background tasks disabled and an id on each prompt, as the sheet settled them |
| 7b | `--scenario chat-request`, `chat-early-resume`, `chat-forced-resume` | 1, at most 2 (the first reaching no model), at most 2 | Under step 7's arguments (K23 to K25, added): the capture the fake replays for a request from the CLI; a resume of a session interrupted before its first turn ran; a resume after a forced end of the process. The last two leave one raw capture per process |
| 7c | `--scenario chat-hooks`, `chat-forced-turn` | 1, at most 2 | Under step 7's arguments (K26 and K27, added): a turn under a `SessionStart` and a `UserPromptSubmit` hook written into the scratch configuration folder, each timed against the frames a deadline waits for; a forced end at a turn's first tool call, then a resume |
| 8 | `node spikes/m10/publish.mjs --cli claude --only <names, with commas>`, then `node spikes/m10/publish.mjs --check` | Nothing | Redacted fixtures in `tests/fixtures/claude/captures/` as `m16-*.json` |

- **The scratch configuration folder.** K2 to K21 run with `CLAUDE_CONFIG_DIR` naming M14b's login folder (`fat-g-spike-m14b/claude-login` under the temp folder), which the maintainer signed in to: your own configuration is neither read nor changed. A scenario that needs a settings file, an agent, a skill or a hook there writes it before the launch and removes it after the run; a run that is ended from outside leaves their names in `state.json`, and the next run removes them first. A scenario refuses to run when that folder holds a settings file it did not write. If the folder is gone, run `node spikes/m14b/instances.mjs --part 1 --cli claude`, then the login command it prints, **in your own terminal** (agents never log in), and keep the folder with `--keep-login` at part 2.
- **Saved sessions.** A chat session is never launched with `--no-session-persistence`, so every traced session is saved, in the scratch configuration folder. They go with that folder.
- **Scratch project folders:** `fat-g-spike-m16` (the working folder), `fat-g-spike-m16-other` and `-third` (two roots handed over with `--add-dir`) and `fat-g-spike-m16-outside` (outside every root), under the temp folder, rebuilt per invocation and compared with their manifest after every run. `worktree` makes the working folder a git repository first, with one commit.
- **What the spike answers the CLI:** every `can_use_tool` request is denied, as the app will deny it, and any other request gets an error reply. `get_settings` and `get_usage` are the spike's alone: the app sends neither in a chat session.
- **Raw output** goes to `spikes/output/m16/`: a ledger of its own, the raw captures, and a second launch record for the scenarios that run two processes at once. A string over 32 KiB is cut before anything keeps it, the frame's own size being measured first.
- **Publishing.** `publish.mjs` reads M16's raw captures beside M10's and M15's, redacts the scratch configuration folder as a scratch folder, asks that folder's account for its values for the leak check, and replaces an MCP server's name inside its tools' names (`mcp__<server>__<tool>`). The captures of the saved session name one `family` and share their aliases, and so do K24's two and K25's three: publish a family's captures in one call. A run whose text names one of the account's connectors is left unpublished (`worker-write`).
- **A forced end (K25).** `chat-forced-resume` ends its process as the app's process layer ends one on Windows: `taskkill /PID <pid> /T /F` at once, with no end of input first (`ctx.endByForce` in `lib/common.mjs`). The capture records it under `run.endedByForce`; the teardown that follows only confirms the tree gone, so its `graceful` says no more than that. Windows only: elsewhere the process layer ends the input first. `chat-forced-turn` makes the same end during a turn.
- **Hooks (K26).** `chat-hooks` writes a hook script and a settings file into the scratch configuration folder and removes them after the run, with the script's log. The CLI makes a `session-env` folder there for the `SessionStart` hook, and that stays.
- **A model may not produce a case.** `chat-request`'s first run was answered with no tool call, so the CLI made no request; its prompt now asks for the call itself.
- **The first recording of a tree runs beside the handshake** in these scripts, not before it as in M10's: `claude` is a native executable here, and the wait would hide how long a launch and a resume take.

## M18 — the conversation store (`spikes/m18/`)

Spec sheet: docs/planning/_archive/M18-spec-sheet.md (private), its spike items K1 to K3. Findings: conversation-store.md (private research note). Run on Windows with Node 24.19.0 and Electron 44.4.3.

No CLI is launched, no account is read and nothing is fetched: these three ask about SQLite, not about a provider. Plain Node, run from the repository root, with no helper from the other spikes. The stores hold made-up rows.

| Step | Command | Launches | Spends | Leaves behind |
|---|---|---|---|---|
| K1 | `node spikes/m18/k1.mjs` (`--no-package` skips the last leg) | vitest; electron-vite; the repository's Electron on the spike's own main process, with no window; electron-builder `--dir` on a scratch app, then that app's executable | Nothing; a few minutes | `spikes/output/m18/k1.json`, the scratch stores under `k1/`, the scratch app's bundle under `app/` (its package is deleted once it has run) |
| K2 | `node spikes/m18/k2.mjs`, then the same script under Electron's Node (below) | The same runtime again, as a writer that is killed | Nothing | `k2-node.json`, `k2-electron.json`, the scratch stores under `k2-node/` and `k2-electron/` |
| K3 | `node spikes/m18/k3.mjs`, then the same script under Electron's Node (below) | Nothing | Nothing; a second or two | `k3-node.json`, `k3-electron.json`, the scratch stores under `k3-node/` and `k3-electron/` |

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe spikes/m18/k2.mjs
```

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe spikes/m18/k3.mjs
```

- **One check, four places.** `lib/store-check.mjs` creates a store with `node:sqlite`, commits, reopens and reads it; K1 runs it in plain Node, in `store.test.ts` under a copy of the repository's `node` test project, and in `app/main.mjs`, built by electron-vite as the app's main process is.
- **The packaged leg is a scratch app, never fat-g.** Its product name and app id are its own, its fuses are read from the repository's `electron-builder.yml`, its Electron is the repository's (`electronDist`, so nothing is downloaded), and it keeps Electron's own data in its scratch folder: nothing reaches fat-g's data folder.
- **A native module is not run.** Running one means installing it; do that in a scratch folder, never in the repository's `package.json`.
- **K3 removes a chat and looks for its text.** Per setting — SQLite's defaults, then `secure_delete`, a truncating checkpoint and `auto_vacuum` — it deletes one chat's rows and searches each of the store's files for a text only those rows held, with the store open and after its close.
- **Exit codes:** K1 ends 0 when every leg passed and 10 when one did not; K2 and K3 report and end 0.

## M19 — streaming and readable messages (`spikes/m19/`)

Spec sheet: docs/planning/_archive/M19-spec-sheet.md (private), its spike items K1 to K4. Findings: chat-protocols.md §10 (private research note). Run on Windows.

K1 and K2 are new traces, under M15's and M16's runners (`spikes/m15/lib/common.mjs`, `spikes/m16/lib/common.mjs`, each given M19's output folder and a driver of M19's own): the rules of M10 hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count. They keep the one delta kind the milestone reads, which the earlier captures count and drop: Codex's `item/agentMessage/delta`, by a session handshake that is production's less that one opt-out (`DELTA_METHODS` is read from `src/main/providers/codex/methods.ts`), and Claude's `stream_event`, by `--include-partial-messages` added to M16's settled launch. K3 and K4 launch no CLI and spend nothing.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m19/k1.mjs --scenario answer --confirm-turns 1` (and `interrupt`, `worker`, `markdown`) | 1 turn each, Codex | Raw captures under `spikes/output/m19/raw/codex/`; saved threads in M15's scratch folder, which `node spikes/m15/resume.mjs --cleanup` deletes with M15's own |
| K2 | `node spikes/m19/k2.mjs --list`, then `--scenario chat-t1 --confirm-turns 1` (and `chat-t3`, `chat-t4`, `chat-t5`, `chat-command`, `chat-markdown`), then `--scenario chat-cut-resume --confirm-turns 2` | 1 turn each, the last at most 2, Claude; `chat-t5` reaches no model | Raw captures under `spikes/output/m19/raw/claude/`; saved sessions in M16's scratch configuration folder |
| K3 | `npm install --prefix spikes/m19/k3` once, then `node spikes/m19/k3.mjs --sizes`, `--leg dev`, `--leg packaged` (`--leg preview` and `--quick` check the spike itself; `--summary` prints the reports) | Nothing; some minutes a leg, with a window shown | `spikes/output/m19/k3-*.json`, the scratch app under `k3/app/` (its package deleted once it has run), a Vite cache |
| K4 | `node spikes/m19/k4.mjs`, then the same under Electron's Node (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe spikes/m19/k4.mjs`) | Nothing; some seconds | `k4-node.json`, `k4-electron.json`, the scratch stores under `k4-*/` |
| Publish | `node spikes/m10/publish.mjs --cli codex --only m19-answer,m19-interrupt,m19-worker,m19-markdown`, `node spikes/m10/publish.mjs --cli claude --only <names, with commas>`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m19-*.json`, their deltas kept (`deltas.requested` says so) |

- **K2's prompts are K20's**, word for word, for the five scenarios that have one there (`chat-t1`, `chat-t3`, `chat-t4`, `chat-t5`, `chat-command`): the replay fake can then answer the same prompt with this capture when it is started with the new argument (C55). `chat-t4` interrupts at the first text delta of the session's own, wherever in the turn it comes, where K20's interrupted at the first tool call. `chat-markdown` runs at a high effort so that a thinking block is likely. `chat-cut-resume` ends its process as the app's process layer does (`taskkill /PID <pid> /T /F`, Windows only) during the first text block of a new conversation, before any model `assistant` frame — a run in which one arrives first did not make its case — then resumes by the id its `init` named; its two captures name one family. The model and effort are the ones M16's `discover` scenario left in `spikes/output/m16/state.json`.
- **K3 is a scratch Electron app, never fat-g**, built by electron-vite from `spikes/m19/k3/` and served as fat-g serves its page: its main process calls fat-g's own `src/main/app/csp.ts`, `origins.ts`, `protocol.ts` and `security.ts`, so the page runs under the development policy (from a Vite development server, React's development build) and the packaged policy (`app://`, a package made as M18's K1 made one, with the repository's fuses and Electron). The three packages are installed into `spikes/m19/k3/node_modules` — ignored, and not the repository's — at the exact versions `spikes/m19/k3/package.json` names; React is the repository's (`.npmrc` keeps npm from installing a second one). The page measures each way of drawing on the fixture of `k3/fixture.mjs`, which is the sheet's C52 and the same every time (its hash is in `k3-sizes.json`): the parse and the display of the two static messages, the newest page and the full window, each stream into a full window at a 50 ms and a 100 ms interval, a scroll through the window, and how a few small texts draw. A stream grows at 5,000 units a second, faster than either CLI writes: the cost of an update is its text's size, not its rate. The window is shown without taking the focus, since a hidden window is not painted; Chromium's occlusion detection is turned off for the scratch app alone.
- **K4 is a store made as the app makes one** (write-ahead mode, `synchronous=FULL`, `secure_delete`, `auto_vacuum=FULL`, the app's tables) with 200 turns in it, into which one message is written at its first text and written again at every checkpoint of a counted clock — once per interval, then once more whole — as it grows to 100,000 units, per interval (2 s, 500 ms, 5 s), rate of growth and form of the write (the whole body, or `json_set` of its keys). Each write is timed and the log's size read after it.

## M19b — artifact pane: tabs and Markdown files (`spikes/m19b/`)

Spec sheet: docs/planning/_archive/M19b-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §11 (private research note). Run on Windows with codex-cli 0.155.1 and Claude Code 2.1.268: six prompts, three to each.

K1 launches no CLI and spends nothing. K2 is a trace under M15's and M16's runners with M19's drivers (`spikes/m19/lib/common.mjs`), so each CLI runs under its production launch as M19 leaves it; the rules of M10 hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m19b/k1.mjs --sizes`, then `--leg dev`, `--leg packaged` (`--leg preview` and `--quick` check the spike itself; `--summary` prints the reports) | Nothing; three or four minutes a leg, with a window shown | `spikes/output/m19b/k1-*.json`, the scratch app under `k1/app/` (its package deleted once it has run), a Vite cache |
| K1, beyond the sheet | `node spikes/m19b/k1.mjs --leg packaged --cases line-50000,line-100000,line-250000,line-500000,line-1048576,line-2097152 --name one-line --page-ms 150000` (and `--leg dev`) | Nothing; three minutes | `k1-<leg>-one-line.json` |
| K1, for C54 | `node spikes/m19b/k1.mjs --leg packaged --cases capped-1mib,capped-2mib,capped-line-1mib,capped-line-2mib --name capped` (and `--leg dev`); the same with `--cases wrapped-1mib,wrapped-2mib --name wrapped` | Nothing; two minutes each | `k1-<leg>-capped.json`: plain texts with a line wrapping at 2,000 px, as C54 has it; `k1-<leg>-wrapped.json`: the whole text wrapped at the pane's width, C54's first form |
| K2 | `node spikes/m19b/k2.mjs --list`, then `--cli codex --scenario line --confirm-turns 1` (and `readme`, `space`), then the same three with `--cli claude` | 1 turn each: six in all | Raw captures under `spikes/output/m19b/raw/<cli>/`; saved threads in M15's scratch folder, which `node spikes/m15/resume.mjs --cleanup` deletes with M15's own; saved sessions in M16's scratch configuration folder |
| K2, again | `node spikes/m19b/k2.mjs --reread` | Nothing: no CLI is launched | The mentions read again from the raw captures, by the reader as it is now, and each capture's notes rewritten |
| Publish | `node spikes/m10/publish.mjs --cli codex --only m19b-line,m19b-readme,m19b-space`, the same with `--cli claude`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m19b-*.json`, their deltas kept |

- **K1 is M19's K3 harness with a page of its own** (`k1/app/main.mjs`, `k1/page/`): a scratch Electron app, never fat-g, served under fat-g's own policy from a development server and from a package. It installs nothing: React and `marked` are the repository's. A Markdown file is drawn by **fat-g's own component** (`src/renderer/src/markdown/`), under fat-g's tokens, styles and fonts, in a pane 520 px wide; a plain text as one text node and as one element a line. Each case has a window of its own and is shown three times from an empty pane; the page then scrolls through the whole of it, and comes to a line of its middle. The texts are `k1/fixture.mjs`'s, the same every time (their hash is in `k1-sizes.json`); the Markdown is made by M19's fixture (`spikes/m19/k3/fixture.mjs`, whose `mixed` is exported for it).
- **A case that never ends is given up**, not waited for: the main process asks the page with the time that is left (`--page-ms`), keeps what the page had measured, and ends the page's process. The first run's 2 MiB line, scrolled to its end, was such a case.
- **K2's folder** is M15's scratch folder for Codex and M16's for Claude, with three files added to M10's (`lib/common.mjs`): a `README.md`, `src/tides.js` and `field notes/harbour-log.md`. No file names another by a path, and no prompt says how a file is to be named.
- **What K2 notes** is each mention of one of those files in the form the answer wrote it — a link, a code span, a fenced block or prose; relative or absolute; its line's form; its separators; how a space is written — with the scratch folder replaced by `<scratch>`, and the answer's other code spans, cut short (`lib/mentions.mjs`, which reads the answer with `marked`'s lexer). Nothing else of an answer is noted.
- **A form the reader did not know costs no prompt.** Codex's `/C:/…` was not known to the reader when its run was made: the reader was corrected and `--reread` read the capture again.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run K2's three scenarios for that CLI with `--again`, read the mentions, publish the three, and reopen only the sheet's items the answers change.

## M20a — activity and workers (`spikes/m20a/`)

Spec sheet: docs/planning/_archive/M20a-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §12 (private research note). Run on Windows with codex-cli 0.155.1: six runs, five prompts, all to Codex (the sheet planned two; the maintainer asked for more when they brought no checklist). Claude Code was 2.1.268, the captures' version, so K2 did not run.

K1 is a trace under M15's runner with M19's Codex driver (`spikes/m19/lib/common.mjs`), so the session runs under production's handshake as M19 leaves it; the rules of M10 hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count. K2 has no script: it is M19b's K2 run again for Claude (`node spikes/m19b/k2.mjs --cli claude --scenario line|readme|space --again`, three prompts at most), and only where B1 finds the installed Claude Code at another version than the captures'.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m20a/k1.mjs --list`, then `--scenario <name> --confirm-turns 1` for `steps`, `steps-tracked`, `steps-high`, `steps-tool`, `steps-tool-on` (`investigate-high` was not run) | 1 turn each, Codex: five spent | Raw captures under `spikes/output/m20a/raw/codex/`, two per run (the session's and a second process that reads the thread's history); saved threads in M15's scratch folder, which `node spikes/m15/resume.mjs --cleanup` deletes with M15's own |
| K3 | `node spikes/m20a/k3.mjs --list`, then `--scenario spawn --confirm-turns 1` (`--effort`, `--model` name others than the acceptance run's medium and gpt-5.6-luna; `outlive` was not run) | 1 turn each, Codex: two spent, the first at low effort, which started no sub-agent | A raw capture a run under `spikes/output/m20a/raw/codex/`; a saved thread in M15's scratch folder, deleted by `node spikes/m15/resume.mjs --cleanup` |
| Publish | `node spikes/m10/publish.mjs --cli codex --only m20a-steps-tool-on-main`, then `--include <run id> --only m20a-steps-main` (and `m20a-steps-tool-main`, `m20a-steps-tracked-main`, each with its run id), `--only m20a-collab-spawn`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/codex/captures/` as `m20a-*.json`, their deltas kept; a run that did not happen is published for what it shows (M15, C5) |

- **What K1 notes** is never a text of the model's: whether `turn/plan/updated` came and in what shape (its keys, how many notifications, how many steps and their states), what each `reasoning` item's `summary` and `content` hold by count and size, and what a history read of the turn returns by item type, on the session's own connection and from a second process that never resumed the thread.
- **`steps-tool-on` is the spike's own launch, never the app's:** its `thread/start` carries `config: { "tools.update_plan": { enabled: true } }`, the switch the installed binary names, so that the notification's shape is seen once; the app sends no `config` (decision 0018, item 4), and in the app the switch is the user's own configuration's. A bare boolean in that key is refused at `thread/start` and costs no prompt.
- **The thread is saved, not ephemeral,** so that the second process can read it as the app's history check does (M18, C51); the cleanup deletes it afterwards (the runs left none).
- **K3 came from the acceptance, not from the sheet:** the maintainer's own run on gpt-5.6-luna showed a sub-agent started through the `spawnAgent` collab tool, which no capture held. It notes each collab call's frames by tool, status, the threads it names and its agents' states, whether any `subAgentActivity` came, the worker thread's own frames in order, and what a history read holds: never a text of the model's.
- **For B1's re-check**, when the installed Codex's version differs from the captures': run K1's two scenarios with `--again`, publish, and reopen only the sheet's items the frames change.

## M20b — asides: Explain this and side questions (`spikes/m20b/`)

Spec sheet: docs/planning/_archive/M20b-spec-sheet.md (private), its spike items K1 to K3. Findings: chat-protocols.md §13 (private research note). Run on Windows with Claude Code 2.1.268 and codex-cli 0.155.1: 21 runs, all happened, 26 prompts (16 to Claude, 10 to Codex).

K1 and K2 are traces under M16's runner with M19's Claude driver, so the session runs under M16's launch less `--disable-slash-commands`, with `--include-partial-messages` and background tasks off, in the scratch configuration folder; K3 is under M15's runner with M19's Codex driver, production's handshake as M19 leaves it. The rules of M10 hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count. A side question and a turn on a child thread are prompts: each runner's `ctx.countTurn()` counts them as it counts a `user` frame or a `turn/start`.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m20b/k1.mjs --list`, then `--scenario seed --confirm-turns 1`, `idle` (1), `during` (2), `two` (2), `followup` (1), `cancel` (1), `flagged` (1) | 9 prompts, Claude | Raw captures under `spikes/output/m20b/raw/claude/`; the seed session saved in the scratch configuration folder, its id in `spikes/output/m20b/state.json`; `idle` writes a hook script, its log and a `settings.json` there and removes them after |
| K2 | `node spikes/m20b/k2.mjs --list`, then `--scenario <name> --confirm-turns 1` for `btw`, `compact`, `resume`, `exit`, `quit`, `login`, and `logout` last | 7 prompts at most, Claude; six reach no model | Raw captures under `spikes/output/m20b/raw/claude/`; the seed session resumed each time |
| K3 | `node spikes/m20b/k3.mjs --list`, then `--scenario seed --confirm-turns 2`, `fork` (0), `followup` (2), `during` (2), `two` (2), `read` (1), `again` (1) | 10 prompts, Codex; a fork costs none | Raw captures under `spikes/output/m20b/raw/codex/`; the saved thread in M15's scratch folder, its id and its first turn's in `state.json` |
| Cleanup | `node spikes/m15/resume.mjs --cleanup` | Nothing | The saved thread deleted (the ephemeral children were never listed) |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m20b-seed,m20b-idle,m20b-during,m20b-two,m20b-followup,m20b-cancel,m20b-flagged,m20b-cmd-btw,m20b-cmd-compact,m20b-cmd-resume,m20b-cmd-exit,m20b-cmd-quit,m20b-cmd-login,m20b-cmd-logout`, `--cli codex --only m20b-fork-seed,m20b-fork-only,m20b-fork-followup,m20b-fork-during,m20b-fork-two,m20b-fork-read,m20b-fork-again`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m20b-*.json`, their deltas kept |

- **What K1 notes** is never a text: whether the request is taken and its reply's shape, the progress frames by status and time, what the answer knows of the turn in flight and of the aside's history as a yes or no, the turn's `command_lifecycle` bounds, which of three hooks ran for it, whether the session's history file grew (by its size alone, never read), and what the cancel brings. `flagged` is the one launch under `--disable-slash-commands`, for the record of what the flag gates.
- **What K2 notes:** whether the CLI answered by itself or a model did, whether the process ended, how the `result` came, whether a new `init` named another session, the names the `init` frame's command list holds, and the history file's growth. `logout` runs last of the Claude spikes, since a sign-out could be undone by the maintainer alone (agents never log in); it was refused like the others.
- **What K3 notes:** whether the fork takes each field and what its reply reports, each child's frames by method and item type on the one connection, whether it read when told to act on nothing, how many MCP start notifications named it, whether its answer knows the parent's history, and what `turn/interrupt` on its turn does. `seed` forks with no `lastTurnId` during the first turn (C69); the others fork through the seed turn after a resume with `excludeTurns`.
- **The frame tables grew** for these captures: Claude's by `control_request/side_question` and the SDK's two refusal subtypes, Codex's by `thread/fork`.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again` in the order above (K1's `seed` first; K3's `seed` first), publish, and reopen only the sheet's items the frames change.

## M21 — questions and interaction lifecycle (`spikes/m21/`)

Spec sheet: docs/planning/_archive/M21-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §14 (private research note). Run on Windows with Claude Code 2.1.268 and codex-cli 0.155.1: 12 runs, 12 prompts (7 to Claude, 5 to Codex); one Claude case did not happen and one Codex run was refused before any prompt went.

K1 is a trace under M16's runner with M19's Claude driver, so the session runs under M16's launch as M20b leaves it — no `--disable-slash-commands`, `--include-partial-messages`, background tasks off — plus `AskUserQuestion` in `--tools`, in the scratch configuration folder; each scenario is a session of its own. K2 is under M15's runner with M19's Codex driver, production's handshake as M19 leaves it, in one saved thread; its two plan scenarios take `--experimental`, which puts `experimentalApi: true` on the spike's handshake and nowhere else, since Codex refuses `collaborationMode` without it. The rules of M10 hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count. A `turn/start` of the spike's own is counted once Codex took it.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m21/k1.mjs --list`, then `--scenario one --confirm-turns 1`, `multi` (1), `two` (1), `worker` (1), `stop` (1), `killed` (2) | 7 prompts, Claude | Raw captures under `spikes/output/m21/raw/claude/`; six sessions saved in the scratch configuration folder, their ids in the ledger |
| K2 | `node spikes/m21/k2.mjs --list`, then `--scenario plan --confirm-turns 1 --experimental`, `plan-stop --confirm-turns 1 --experimental`, `async --confirm-turns 2`, `async-two --confirm-turns 1`, `history --confirm-turns 0` | 5 prompts, Codex; the history read costs none | Raw captures under `spikes/output/m21/raw/codex/`; the saved thread in M15's scratch folder, its id in `state.json` |
| Cleanup | `node spikes/m15/resume.mjs --cleanup` | Nothing | The saved thread deleted |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m21-question-one,m21-question-multi,m21-question-two,m21-question-worker,m21-question-stop,m21-question-killed-first,m21-question-killed-resumed --include claude-m21-worker-4`, `--cli codex --only m21-codex-plan,m21-codex-plan-stop,m21-codex-async,m21-codex-async-two,m21-codex-history`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m21-*.json` |

- **What K1 notes** is never a text of the model's: the request's keys and each question's shape, the answer the spike sent and the CLI's own words in the tool's result, the turn's bounds, the cancel frame at a Stop with what follows it, whether a worker's request named an `agent_id`, and what a resumed `initialize` reply lists as pending. `worker` did not happen — the sub-agent reported it has no question tool — and is published with `--include` for what it showed (M15, C5); `killed` is a family of two captures, the killed process's and the resumed one's, published in one `--only` call.
- **What K2 notes:** the request's fields, the reply, `serverRequest/resolved`, the status frames' `activeFlags` while a request is pending, what an interrupt resolves, the async message's questions and the empty message after it, whether the answer in fat-g's words was taken, and what a history read holds. The first `plan` run, without `--experimental`, was refused at `turn/start` and is not published; its error is in the findings.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again` in the order above (K2's `plan` first, with `--experimental`), publish, and reopen only the sheet's items the frames change.

## M22 — execution permissions and remembered rules (`spikes/m22/`)

Spec sheet: docs/planning/_archive/M22-spec-sheet.md (private), its spike items K1 and K2 (first rank) and K4 and K5 (second rank, at acceptance). Findings: chat-protocols.md §15 (private research note). K2 ran on Windows with Claude Code 2.1.268: twelve runs, all happened, twelve prompts. K1 ran with codex-cli 0.155.1: thirteen runs, twelve happened, fifteen prompts, three of them one retry. 27 prompts in all, of the sheet's 32.

K2 is a trace under M16's runner with M19's Claude driver, so the session runs under M16's launch as M20b leaves it — no `--disable-slash-commands`, `--include-partial-messages`, background tasks off — plus `AskUserQuestion`, `Bash`, `Write` and `Edit` in `--tools`, in the scratch configuration folder. K1 is a trace under M15's runner with M19's Codex driver, so the session runs under production's handshake as M19 leaves it, with no experimental API — but **in a scratch configuration folder of its own**, `.fat-g-spike-m22\codex-home` in the user's profile folder, with `CODEX_HOME` naming it (the sheet's C33): your own Codex configuration is neither read nor changed. The rules of M10 hold for both — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count. The sheet's budget is twelve prompts a spike, with eight more for retries between the two; it was raised to 50 in all, at the maintainer's word (the sheet's C33).

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K2 | `node spikes/m22/k2.mjs --list`, then `--scenario modes --confirm-turns 0`, `once` (2), `session-rule` (2), `resumed` (1), `files` (1), `accept-edits` (2), `lost` (1), `inherited` (1), `worker` (1), `permissions` (1) | 12 prompts, Claude; `modes` sends none, and `permissions` reaches no model | Raw captures under `spikes/output/m22/raw/claude/`; the sessions saved in the scratch configuration folder, the one `session-rule` left named in `spikes/output/m22/state.json`; a `shell-snapshots` folder the CLI made there |
| K2, in reserve | `--scenario destination --confirm-turns 1` | 1 prompt | Not run: `resumed` produced its case |
| K1, no prompt | `node spikes/m22/k1.mjs --list`, then `--scenario start --confirm-turns 0`, `trust` (0), and after `override`: `resume` (0), `config` (0) | Nothing | Raw captures under `spikes/output/m22/raw/codex/`; the model `start` chose, in `state.json`. `trust` removes the scratch configuration's `config.toml` first, and `config` writes one line into it and takes it out again |
| K1 | `--scenario once --confirm-turns 2`, `files` (1), `on-request` (1), `amendment` (2), `file-session` (3), `override` (2), `worker` (1) | 12 prompts, Codex | Raw captures; saved threads, a trust entry in `config.toml` and `rules/default.rules` in the scratch configuration folder |
| K1, a retry | `--scenario file-session-same --confirm-turns 3` | 3 prompts at most | The session grant again, with a second change to the same file |
| K1, in reserve | `--scenario amendment-after --confirm-turns 1` | 1 prompt | Not run: whether the amended rule answers in another process |
| K1, the maintainer's to run | `node spikes/m22/k1.mjs --scenario setup --confirm-turns 0 --mode elevated --again` (or `--mode unelevated`); `--scenario sandbox-state --confirm-turns 0` is its read-only half, which any session may run | Nothing: no thread keeps, no prompt. Run once with the Windows prompt declined: reported as failed, nothing set up | **It changes the machine**: it sends Codex's own `windowsSandbox/setupStart` for the scratch configuration, and Windows asks for an administrator's approval where the mode needs one. Run from the maintainer's own terminal, never by an agent. It records the readiness before and after, the request's reply and completion, and what a workspace-write thread reports afterwards |
| K1, with the sandbox set up | `--scenario sandbox-files --confirm-turns 1`, `sandbox-commands` (1), `sandbox-ask-first` (1), `sandbox-ask-write` (1); `start --again` for the replies | 4 prompts, Codex: 31 of the sheet's 32 spent | Raw captures; files in the scratch working folder and in two folders the scenarios make beside the scratch configuration, `outside` and `second`, which stand for what a sandbox holds back — the temp folder is writable inside one, so the other scratch folders cannot. Published as `m22-codex-sandbox-*.json`, `m22-codex-setup.json`, `m22-codex-setup-declined.json` and `m22-codex-start-ready.json`: the raw captures of the declined setup and of the second `start` were renamed so that each keeps a fixture of its own |
| K4, two cases run early | `--scenario reviewer-turn --confirm-turns 1`, then `reviewer` (0), which resumes the thread the first left | 1 prompt at most, Codex: 32 of the sheet's 50 spent. A `turn/start` that is refused spends nothing, so `reviewer-turn` tries its forms in turn and runs the first one taken | Raw captures; a saved thread, named in `state.json`; one file asked for in `outside` and declined, so not made. `reviewer` writes `approvals_reviewer = "auto_review"` at the top of the scratch configuration's `config.toml` and puts the file back as it was, also when a step fails; it names Codex's reviewer on a resume and sends no turn under it. Published in one call, being one family: `node spikes/m10/publish.mjs --cli codex --only m22-codex-reviewer-turn-main,m22-codex-reviewer-turn-resumed,m22-codex-reviewer-p1,m22-codex-reviewer-p2,m22-codex-reviewer-p3,m22-codex-reviewer-p4,m22-codex-reviewer-p5,m22-codex-reviewer-p6,m22-codex-reviewer-p7,m22-codex-reviewer-p8` |
| K4, the rest | `node spikes/m22/k1.mjs --scenario read-only-turn --confirm-turns 1`, `ask-first-files` (1), `sandbox-temp` (1), `auto-review` (2, at most), `berserk-turn` (1) | 6 prompts, Codex, run at the maintainer's word: all five happened | Raw captures; saved threads, the ones `auto-review` and `berserk-turn` left named in `state.json`; files in the scratch working folder, in M15's second scratch folder — which is under the temp folder and stands for a temporary folder outside the working one — and in `outside` and `second` beside the scratch configuration. `berserk-turn` runs one turn under full access with no approval: its prompt dictates two `echo` commands and one file, each in a scratch folder. `auto-review` accepts nothing itself: what Codex's reviewer approves is made. The two sandbox scenarios stop before their prompt where the thread does not report workspace-write. Published: `node spikes/m10/publish.mjs --cli codex --only m22-codex-read-only-turn,m22-codex-ask-first-files,m22-codex-sandbox-temp,m22-codex-auto-review-main,m22-codex-auto-review-resumed,m22-codex-berserk-main,m22-codex-berserk-p2,m22-codex-berserk-p3,m22-codex-berserk-p4` |
| K5 | `node spikes/m22/k2.mjs --scenario worker-mode --confirm-turns 1`, `auto-turn` (1), `bypass-turn` (1) | 3 prompts, Claude, run: all three happened; 41 of the sheet's 50 spent | Raw captures; three saved sessions; files in the scratch working folder and the folder outside every root. `auto-turn` and `bypass-turn` write a hook script and a settings file into the scratch configuration folder and remove them. Each launches under its mode by `--permission-mode` alone, and sends no prompt where `initialize` does not name that mode; `bypass-turn` then resumes its session twice with no prompt, under `default` and under `acceptEdits`. Published: `node spikes/m10/publish.mjs --cli claude --only m22-mode-worker,m22-mode-auto,m22-mode-bypass-main,m22-mode-bypass-resumed-default,m22-mode-bypass-resumed-acceptEdits` |
| Beside K1 | `node spikes/m22/readiness.mjs` | Nothing: one request, no thread, no prompt | Nothing. It asks **your own** Codex configuration, not the scratch one, whether the Windows sandbox is set up, and prints `ready`, `notConfigured` or `updateRequired`. Run only at the maintainer's word, since the sheet's C33 keeps the spikes to the scratch folder: `ready` |
| Publish, Codex | `node spikes/m10/publish.mjs --cli codex --only m22-codex-start,m22-codex-trust,m22-codex-once,m22-codex-files,m22-codex-on-request,m22-codex-amendment,m22-codex-file-session-main,m22-codex-file-session-resumed,m22-codex-override-main,m22-codex-override-resumed,m22-codex-resume-p1,m22-codex-resume-p2,m22-codex-resume-p3,m22-codex-resume-p4,m22-codex-resume-p5,m22-codex-config-p1,m22-codex-config-p2,m22-codex-worker,m22-codex-file-session-same-main,m22-codex-file-session-same-resumed` | Nothing | Redacted fixtures in `tests/fixtures/codex/captures/` as `m22-codex-*.json`; a family's captures share their aliases |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m22-modes-set,m22-modes-launch-acceptEdits,m22-modes-launch-auto,m22-modes-launch-dontAsk,m22-modes-launch-bypassPermissions,m22-approve-once,m22-approve-session,m22-approve-resumed,m22-approve-files,m22-mode-accept-edits,m22-mode-lost-first,m22-mode-lost-resumed,m22-inherited,m22-approve-worker,m22-cmd-permissions`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/claude/captures/` as `m22-*.json`, their deltas kept |

- **What the spike answers the CLI.** A `can_use_tool` request is allowed only for what the scenario's own prompt dictated: a `Bash` command that is the prompt's, word for word, or a `Write` or an `Edit` whose file is in a scratch folder. Any other request is denied with M16's words. Where a scenario says so the allow carries the CLI's own `permission_suggestions` back as `updatedPermissions`, at the `session` destination (`session-rule`) or unchanged (`resumed`), or the request is held unanswered (`accept-edits`, for the Stop; `lost`).
- **No flag that bypasses permissions is passed** (the sheet's C47). `modes` asks for `bypassPermissions` by `set_permission_mode` and by `--permission-mode` alone, and sends no prompt in any mode; `bypass-turn`, K5's, launches by `--permission-mode bypassPermissions` alone and sends one.
- **The writes are the point.** These scenarios make files in the scratch project folders — the working folder, the root handed over with `--add-dir` and the folder outside every root — which are rebuilt per invocation, so the runner's "scratch folders unchanged: false" is expected, and names what was made. `resumed` makes the CLI write `.claude/settings.local.json` into the scratch working folder.
- **`inherited` writes into the scratch configuration folder** a settings file, a hook script and an MCP server's script, and removes them after the run; its `.mcp.json` is one of the scratch working folder's own files. The server (`fatgspike`) has one tool, which writes one file there.
- **`modes` asks for the rule list once** and leaves what it found in `state.json`: 2.1.268 refuses `list_permission_rules` as unsupported, so the other scenarios do not send it. Run `modes` again first on a new CLI version.
- **What K2 notes** is never a text of the model's: each request's keys and what came with it (the suggestions by type, destination and rule; the CLI's reason; whether it names a worker), the reply the spike sent, the CLI's own words for a refusal, each tool call with whether a request named it, the modes the frames report, and which files the scratch folders hold afterwards. A command a request carries is noted only as whether it is the prompt's.
- **The scratch Codex configuration folder.** Made empty for this spike, with the spikes' marker in its parent, and signed in by the maintainer from their own terminal: `$env:CODEX_HOME = "$env:USERPROFILE\.fat-g-spike-m22\codex-home"; codex login` (agents never log in). It is not under the temp folder because Codex makes no helper binaries there, and says so. **And it is not under `%LOCALAPPDATA%`, where K1's runs had it:** an agent's session inside a packaged application (the Claude desktop app) has its writes there redirected to the application's private store, so the folder the agent made and filled was not the one the maintainer's terminal saw. Their login landed in the real folder, everything the spikes wrote in the private copy, and the agent's session saw the two merged; the `setup` scenario, run from the maintainer's terminal, then found no marker and launched nothing. The temp folder and the profile folder are not redirected. Both old copies can be deleted: the real one holds that first login. It holds a login, so it stays until the maintainer deletes it; everything else in it is the spike's, and the spike reads one file of it, `config.toml`, for what Codex wrote there, and the rules file an amendment made. Never `auth.json`.
- **What K1 answers the CLI.** A command's request is accepted only where its `command` holds the prompt's own command and no separator beside it, in a scratch folder; a file change's only where every path of its item is in a scratch folder. Any other is declined, and a request for more permissions is granted nothing. The decision is the scenario's: `accept`, `acceptForSession`, the amendment Codex proposed, `decline`, or none (held, for the Stop and the forced end). `windowsSandbox/setupStart` is never sent: it changes the machine.
- **On this machine the Windows sandbox is not configured**, so every thread K1 asked for as workspace-write was answered read-only, and nothing was seen of a real workspace-write thread. A run on a machine that has one would add that.
- **The frame tables grew**: Claude's by `control_request/set_permission_mode` and `control_request/list_permission_rules`, Codex's by `windowsSandbox/readiness`, `permissionProfile/list` and `configRequirements/read`. `spikes/m16/lib/common.mjs` takes a `toolPolicy` for what a capture says the spike answered, and `spikes/m15/lib/common.mjs` an environment, a readiness check and a permissions note of the spike's own. The publisher writes the git blob ids of a turn's diff as `<blob>`, and asks the scratch Codex folder's account for its values too.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again` in the order above (Claude: `modes` first, `session-rule` before `resumed`; Codex: `start` first, `override` before `resume`, `reviewer-turn` before `reviewer`; K4's and K5's scenarios in any order after those), publish, and reopen only the sheet's items the frames change.

## M100b — the question card (`spikes/m100b/`)

Spec sheet: docs/planning/_archive/M100b-spec-sheet.md (private), its spike item K1. Findings: chat-protocols.md §16 (private research note). Run on Windows with Claude Code 2.1.268: one run, one prompt.

K1 is a trace under M16's runner with M19's Claude driver, under M21's launch (`AskUserQuestion` in `--tools`), in the scratch configuration folder; M10's rules hold — one invocation is one run, three runs at most, a plan printed and nothing launched without `--confirm-turns 1`.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m100b/k1.mjs --list`, then `--scenario decline --confirm-turns 1` | 1 prompt, Claude | A raw capture under `spikes/output/m100b/raw/claude/`; one session saved in the scratch configuration folder, its id in the ledger |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m100b-question-decline`, then `--check` | Nothing | The redacted fixture `tests/fixtures/claude/captures/m100b-question-decline.json` |

- **What K1 notes** is never a text of the model's: the request's keys, the `deny` the spike sent, the CLI's own words in the tool's result, the frames after the `deny`, the turn's bounds, and whether the reply is the one word the prompt names for a declined question.

## M22b — plans (`spikes/m22b/`)

Spec sheet: docs/planning/_archive/M22b-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §17 (private research note). Run on Windows with Claude Code 2.1.268 and codex-cli 0.155.1: 18 prompts of the sheet's 24 (C46), two of them runs again.

K1 is a trace under M16's runner with M19's Claude driver, under the app's launch with each mode's tool list plus `ExitPlanMode`, in M16's scratch configuration folder; each scenario launches under one of fat-g's five modes, sets `plan` by `set_permission_mode`, sends one prompt and answers each `ExitPlanMode` request as it says. K2 is under M15's runner with M19's Codex driver, production's handshake plus `experimentalApi: true`, keeping `item/plan/delta` beside the message delta, **in M22's scratch Codex configuration** (`CODEX_HOME` = `%USERPROFILE%\.fat-g-spike-m22\codex-home`), in M15's scratch working folder. M10's rules hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m22b/k1.mjs --list`, then `--scenario read-only --confirm-turns 1`, `ask-first` (1), `edits-ok` (1), `auto-reviewed` (1), `berserk` (1) | 5 prompts, Claude; 6 spent, `read-only` run again after the CLI's token refresh failed | Raw captures under `spikes/output/m22b/raw/claude/`; five sessions saved in the scratch configuration folder. The plan file the CLI writes into the folder's `plans/` is removed after each run, unread |
| K1, in reserve | `--scenario plans-dir --confirm-turns 1` | 1 prompt | Not run: the request carries the plan's text wherever `Write` is listed |
| K2 | `node spikes/m22b/k2.mjs --list`, then `--scenario chain --confirm-turns 4`, `resumed` (2), `skip` (1, with `--model gpt-5.6-terra`), `empty` (1, the same), `modes` (3), `history` (0); `models` (0) lists the account's models | 11 prompts, Codex; 12 spent, `skip` run again on another model | Raw captures under `spikes/output/m22b/raw/codex/`; the saved thread `chain` starts, named in `spikes/output/m22b/state.json`, and the other scenarios' threads, in the scratch configuration |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m22b-plan-read-only,m22b-plan-ask-first,m22b-plan-edits-ok,m22b-plan-auto-reviewed,m22b-plan-berserk`, `--cli codex --only m22b-codex-chain,m22b-codex-resumed-first,m22b-codex-resumed-resumed,m22b-codex-skip,m22b-codex-empty,m22b-codex-modes,m22b-codex-history`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m22b-*.json`, their deltas kept |

- **What the spikes answer the CLI.** K1 answers `ExitPlanMode` as the scenario says — feedback (`deny` with the spike's words), Execute (a plain `allow`), Cancel (`deny` with `interrupt` and fat-g's words), or held for a Stop — allows a `Write` of the plan file in the plans folder and a `Write` or an `Edit` in the scratch project, and denies the rest. K2 accepts a file change whose every path is in the scratch working folder outside a plan turn, declines every command and every request during a plan turn, and answers a question as the scenario says: "No answer" under each id, or an empty list.
- **Which model asks a blocking question is the model's.** The scratch Codex account's default, `gpt-6-luna`, asked M21's plan question by a message with options; `gpt-5.6-terra` raised `item/tool/requestUserInput`. The account does not list `gpt-6-astra`, M21's model. `--model <id>` names one the account lists.
- **The tables grew**: `codex/frames.mjs` by `item/plan/delta` and `turn/moderationMetadata` (moderation flags and ids, no text), `lib/scratch.mjs` by `m22bPlans` for the reserve, and `publish.mjs` by `M22B_RAW`. `tests/fixtures/captures.test.ts` lists the new captures with message deltas and holds each plan's deltas to its completed text; `tests/fakes/replay.test.ts` leaves `m22b-codex-skip` and `-empty` out of M21's prompt check, since they ask M21's plan question again — a fake that replays them tells them apart by the reply.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again` (Codex: `chain` first, `resumed` and `history` after it), publish, and reopen only the sheet's items the frames change.
- **Run again on codex-cli 0.163.0**, at the start of the build: `chain` (4), `modes` (3), `resumed` (2), `skip` and `empty` (1 each, `--model gpt-5.6-terra`), `history` (0), each with `--again` — eleven prompts, 29 of the sheet's 32 spent in all. `chain` did not produce its case (the model answered in prose, with no plan item) and its capture stays 0.155.1's; the six others were published again, after `thread/readState/changed` joined `codex/frames.mjs`. `skip` has used its three runs. Findings in chat-protocols §17 (private research note).

## M23 — composer, attachments and busy input (`spikes/m23/`)

Spec sheet: docs/planning/_archive/M23-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §18 (private research note). Run on Windows with codex-cli 0.163.0 and Claude Code 2.1.268: 21 prompts within the sheet's budget of 50 (C70), the 20 planned and one case run three times.

K1 is a trace under M15's runner with M19's Codex driver, production's handshake with the message delta kept, read-only threads with approvals `never`, **in M22's scratch Codex configuration** (`CODEX_HOME` = `%USERPROFILE%\.fat-g-spike-m22\codex-home`), in M15's scratch working folder; its fixture images are written to `m23-images` beside that configuration for each run and removed after it. K2 is under M16's runner with M19's Claude driver, the app's launch with the reading mode's tools under `default`, in M16's scratch configuration folder. Both spikes share the launch record: one runs at a time, and a publish waits for a run to end. M10's rules hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m23/k1.mjs --list`, then `--scenario image --confirm-turns 2`, `big-image` (1), `steer` (2), `async` (2), `commands` (2), `skills` (1) | 12 prompts, Codex; `async` ran three times: the first two ended after their first prompt, the second with `--again --model gpt-5.6-terra`; the third, `--again --own-account --model gpt-6-astra`, ran on the maintainer's own Codex configuration at their word (C70) | Raw captures under `spikes/output/m23/raw/codex/`; seven threads in the scratch configuration, two of them naming image paths under `m23-images`, which is gone; one thread in the maintainer's own session store, from the astra run |
| K2 | `node spikes/m23/k2.mjs --list`, then `--scenario image --confirm-turns 1`, `big-image` (1), `steer-text` (2), `steer-tool` (2), `stop-held` (2), `skill` (1) | 9 prompts, Claude | Raw captures under `spikes/output/m23/raw/claude/`; six sessions saved in the scratch configuration. The skill `skill` writes into the folder's `skills/` is removed after the run |
| Publish | `node spikes/m10/publish.mjs --cli codex --only m23-codex-image,m23-codex-big-image,m23-codex-steer,m23-codex-async,m23-codex-commands,m23-codex-skills`, `--cli claude --only m23-claude-image,m23-claude-big-image,m23-claude-steer-text,m23-claude-steer-tool,m23-claude-stop-held,m23-claude-skill`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m23-*.json`; an image block's bytes replaced by their length, a `skills/list` reply reduced to the spike's own skill and the others' scopes |

- **The images are nobody's.** `lib/common.mjs` draws them: two 64 px squares split in two colours, and 1320 × 1323 px of random pixels stored uncompressed, 5,241,261 bytes, under the sheet's 5 MiB bound. Each run writes them anew.
- **What the spikes answer the CLI.** K1 declines every request and answers a question asked in a message by `turn/steer`, or by the next prompt; K2 denies every `can_use_tool`, and its reads inside the scratch project ask nothing.
- **The astra case.** Neither `gpt-6-luna` nor `gpt-5.6-terra` asked in a message with `questions` during a running turn; `gpt-6-astra`, which only the maintainer's own account lists, did, as in M21. `--own-account` runs a scenario under M10's clean environment with the default `CODEX_HOME` — the maintainer's own configuration, their MCP servers included — in the scratch working folder, read-only; at their word alone, never by default.
- **The tables grew**: `codex/frames.mjs` by `turn/steer` and `skills/list` among the sent methods and a `skills/list` reduction in `scrub`, `claude/frames.mjs`'s `scrub` by the image block, `lib/shipped-names.mjs` by the spike's skill, and `publish.mjs` by `M23_RAW` and the images folder. `tests/fixtures/captures.test.ts` lists the six Codex captures, which all hold message deltas.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again`, publish, and reopen only the sheet's items the frames change.

## M22e — plan review (`spikes/m22e/`)

Spec sheet: docs/planning/_archive/M22e-spec-sheet.md (private), its spike items K1 and K2. Findings: chat-protocols.md §19 (private research note). Run on Windows with Claude Code 2.1.268 and codex-cli 0.163.0: 12 prompts, the sheet's four for K1 and eight for K2 (C19), no retry.

K1 sends a review prompt — a draft of the sheet's instruction (C3), a made-up plan about the scratch project in M22b's block, the project's folder and the findings schema (C4) as a JSON Schema — and then, in the same session, one of the same kind on the plan's version 2; each answer is read by the sheet's rule (C5) in `lib/common.mjs`, which holds the draft instruction, the schema, the two plans and the reader. `claude` runs under M16's runner with M19's driver, the app's launch with the reading mode's five tools under `default`, in M16's scratch configuration folder; `codex` under M15's runner with M19's driver, a read-only thread with approvals `never`, **in M22's scratch Codex configuration**. Both share the launch record: one runs at a time. M10's rules hold — one invocation is one run, three runs at most per scenario, a plan printed and nothing launched without `--confirm-turns` equal to the count.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K1 | `node spikes/m22e/k1.mjs --list`, then `--scenario claude --confirm-turns 2`, `--scenario codex --confirm-turns 2`; `--model <id>` and `--effort <level>` name others than the saved or default model at medium effort | 4 prompts | Raw captures under `spikes/output/m22e/raw/<cli>/`; a Claude session saved in the scratch configuration, and a Codex thread in the scratch Codex configuration |
| K2 | `node spikes/m22e/k2.mjs --list`, then `--scenario claude --confirm-turns 4`, `--scenario codex --confirm-turns 4`; the same options | 8 prompts | Raw captures under `spikes/output/m22e/raw/<cli>/`; a session and a thread as K1's |
| Rounds read again | `node spikes/m22e/rounds.mjs <capture>` | Nothing | Nothing: each turn's answer as prose or a round, and each round against the one before |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m22e-claude-review,m22e-claude-rounds`, `--cli codex --only m22e-codex-review,m22e-codex-rounds`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m22e-*.json`, deltas kept: about 520, 730, 580 and 980 KB |

- **K2 runs the panels' four prompts in one session**: the review on version 2 of the draft instruction, Send notes with a note that settles a point, Send notes with a note that only asks, Show updated review, the first finding accepted and the last refused. Its round prompts, and the comparison of a round with the one before, are in `lib/common.mjs`. The comparison reads `was` only where it names a finding of the round before, since both models repeat it in later rounds; the captures' own notes for rounds 3 and 4 were made before that fix, and `rounds.mjs` reads them again with it.
- **A review takes longer than a trace.** The scenario wait is raised to eight minutes from the first prompt and the invocation's budget to nine and a half, K2's to eleven and thirteen (`deadlines({ scenario })`, `runSpike`'s `budgetMs`): run them in the background, outside an agent shell's ten-minute limit. The turns took 5–56 s.
- **What the spike answers the CLI.** Every `can_use_tool` request is denied and every Codex request declined, as the app does under the reading mode; no request came, the reads inside the scratch project asking nothing.
- **Codex says its login status on stderr.** A readiness check copied from another spike must keep `stderr` for `codexLoggedIn`; this one's first run stopped as "not logged in" before any prompt for want of it.
- **The tables grew**: `publish.mjs` by `M22E_RAW`, and `tests/fixtures/captures.test.ts` by `m22e-codex-review` and `m22e-codex-rounds` among the Codex captures with message deltas.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again`, publish, and reopen only C5 if an answer no longer closes with one block that checks, and C29 or C31 if a round no longer keeps its ids or a note that only asks is answered otherwise.

## M106 — the sub-agent stack (`spikes/m106/`)

Spec sheet: docs/planning/_archive/M106-spec-sheet.md (private), its spike items K1 and K2. Run on Windows with Claude Code 2.1.268 and codex-cli 0.163.0: 4 prompts, two per CLI, as the sheet allows (C37), no retry.

Both ask one or two sub-agents for a one-word reply on a model other than the session's, and record what names the sub-agent's model on the wire. K1 runs `claude` under M16's runner, the app's launch with `Read`, `Glob`, `Grep` and `Agent` under `default`, background tasks on, in M16's scratch configuration folder; K2 runs `codex` under M15's runner with M19's driver, a read-only thread with approvals `never`, **in M22's scratch Codex configuration**, or on the maintainer's own configuration with `--own-account`, at their word, for the one model only their account lists. K2's offline half is `codex app-server generate-ts --out <scratch>`, read for the fields that name a model. Both share the launch record: one runs at a time. M10's rules hold.

| Step | Command | Spends | Leaves behind |
|---|---|---|---|
| K2, offline | `codex app-server generate-ts --out <a scratch folder>` | Nothing | The installed CLI's protocol types, outside the repository |
| K1 | `node spikes/m106/k1.mjs --list`, then `--scenario foreground --confirm-turns 1`, `--scenario background --confirm-turns 1` | 2 prompts, Claude | Raw captures under `spikes/output/m106/raw/claude/`; two sessions saved in the scratch configuration |
| K2 | `node spikes/m106/k2.mjs --list`, then `--scenario spawn --confirm-turns 1 --model gpt-5.6-luna`, `--scenario activity --confirm-turns 1 --own-account --model gpt-6-astra`; `--worker-model <id>` names another model to ask for the sub-agent than `gpt-5.6-terra` | 2 prompts, Codex | Raw captures under `spikes/output/m106/raw/codex/`; a thread and its sub-agent's in the scratch Codex configuration, and one pair in the maintainer's own session store, from the astra run |
| Publish | `node spikes/m10/publish.mjs --cli claude --only m106-claude-foreground,m106-claude-background`, `--cli codex --only m106-codex-spawn,m106-codex-activity`, then `--check` | Nothing | Redacted fixtures in `tests/fixtures/<cli>/captures/` as `m106-*.json` |

- **What names the model.** Claude: the `Agent` tool use's input `model`, an alias, and the worker's own `assistant` frames' `message.model`, the resolved id; a worker told to use no tool sends no frame of its own, which is why `background`'s workers read a file first. Codex: a `spawnAgent` collab call's `model` at its start and its completion, and a `subAgentActivity` item's `model` on its `started` kind; the worker thread's own frames name none, and `thread/read` of the worker's thread answers its model and nickname with no prompt. The sheet's C14 and C15 hold the findings.
- **What the spikes answer the CLI.** K1 denies every `can_use_tool` request and K2 declines every request; none came, the sub-agents being told to use no tool, or to read inside the scratch project.
- **The scratch login's marker.** M16's runner refuses the scratch parent folder without its `.fat-g-spike` marker file; it was missing and was written again with the m14b spike's own text. A missing marker is not a missing login.
- **The tables grew**: `publish.mjs` by `M106_RAW`, and `tests/fixtures/captures.test.ts` by the two Codex captures, which hold message deltas.
- **For B1's re-check**, when an installed CLI's version differs from the captures': run that CLI's scenarios with `--again`, publish, and reopen only C14 or C15 if the fields that name the model move.

## M105 — tool lifetimes and waiting

Spec: M105. Findings: m105-states.md (private research note). Run on Windows with Claude Code 2.1.302 and codex-cli 0.164.0: four top-level prompts, two per provider, plus four model-created children; no retry, two reserve prompts unused. All process trees were confirmed gone and disposable fixture files unchanged. State-avatar work was deferred by the maintainer; no media/package spike ran.

Use `do-spike-m105.bat --cli claude --scenario check` (or `--cli codex`) for version and scratch-login preflight with no prompt. `--scenario tools` or `workers` prints its one-prompt plan unless `--confirm-turns 1` is supplied. Repeating a completed case also needs `--again`; the cumulative ledger refuses more than six prompts and each case retains the three-attempt cap. New runs need an announced remaining budget.

- Uses the existing prepared M14b Claude and M22 Codex scratch accounts; no credentials are read, login attempted or personal configuration edited. Disposable `fat-g-spike-m105-*` projects under `%TEMP%` contain only two synthetic text files. Claude keeps production's foreground-worker setting; Codex threads are ephemeral/read-only and requests declined. Claude allows only the exact fixed Node marker/timer command; other requests are denied.
- Raw captures and the budget ledger stay in ignored `spikes/output/m105/`. Public captures under `tests/fixtures/m105/` are allowlisted wire projections: no model text, commands, paths, identity or arbitrary tool input/output, with ids replaced by aliases. They contain no synthetic events. `--reproject` regenerates a case's public projection from its existing raw capture without launching a CLI or sending a prompt.
- `node --test spikes/m105/k1.test.mjs` checks privacy with planted private content, pairing/ordering, announcement versus execution, and the four observed captures. These synthetic test inputs are separate from the live projections.
- An anonymous Codex wait with empty targets stays generic Waiting; active children or an interacted announcement do not alone imply waiting. Retry/backoff was not observed and is not enabled. The existing stream already ramps playback rate, so M105 adds a waiting target during implementation, without another basic-speed spike.

## Codex MCP approvals (`spikes/codex-mcp/`)

Findings: codex-mcp-approvals.md (private research note); built on in [decision 0018](../docs/decisions/0018-codex-sessions.md), item 7. Run on Windows with codex-cli 0.164.0: six scenarios of one prompt each, and one rerun (`session`'s first run sent its prompt before the server was ready, and its model said the tool was unavailable; the spike now waits for the server's `ready`). 7 prompts.

| Scenario | Prompts | What it answers |
|---|---|---|
| `once` | 1 | two calls of an unannotated tool under Ask first, each approved once |
| `session` | 1 | the session's grant, then the same tool again (no request) and another tool of the server (asks) |
| `deny` | 1 | one call declined: `failed`, Codex's own words |
| `stop` | 1 | a Stop with the request pending: interrupted, then resolved |
| `form` | 1 | a server's own form refused with "method not found": Codex tells the server `decline` |
| `annotated` | 1 | under Read only, a tool marked not destructive runs with no request; an unannotated one Codex fails itself |

On Windows, run `do-spike-codex-mcp.bat --list`, then `do-spike-codex-mcp.bat --scenario <name> --confirm-turns 1 [--again]`. Elsewhere, use `node spikes/codex-mcp/k1.mjs` with the same arguments. Publish with `node spikes/m10/publish.mjs --cli codex --only codex-mcp-approval-once,codex-mcp-approval-session,codex-mcp-approval-deny,codex-mcp-approval-stop,codex-mcp-server-form,codex-mcp-annotated-read-only`.

- Runs in M22's scratch Codex configuration folder (`CODEX_HOME`), signed in by the maintainer; the maintainer's own configuration is neither read nor changed.
- Each scenario writes the spike's server (`fixture-server.mjs`) into that folder's `config.toml` before the app-server starts and puts the file back as it was afterwards, also on failure — which also takes back the trust Codex writes there at a workspace-write start. The server is synthetic, uses no network, and writes only into `spikes/output/codex-mcp/server/`.
- `publish.mjs` lists `CODEX_MCP_RAW`; the server's name is aliased in the captures like every configured name. The five captures with message deltas are in `tests/fixtures/captures.test.ts`'s list, and the replay fake plays all six (`MCP_CAPTURES`), holding each elicitation for fat-g's reply.

## Privacy

- Console output is **redacted** (emails, account/org ids, home directory) so it's safe to paste into an issue or an agent chat.
- Raw, **unredacted** results are written to `spikes/output/`, which is gitignored. Only hand-redacted copies may be committed as fixtures.
- Neither script reads credential files (`~/.claude/.credentials.json`, keychain, `~/.codex/auth.json`). The Claude spike lists *folder names* under the Claude projects dir solely to detect whether its own probe left a transcript behind.
- The M10 spikes read no CLI folder at all (not even folder names). Their fixtures pass through a redactor and an independent leak check before they are written, and a Codex `config/read` reply is reduced to two levels of key names before anything is written, raw output included.
- A reply's deltas are redacted as the one text they are, and the leak check reads them joined (M19b, C62): a path or a name that a CLI wrote across several deltas is in no one of them, and seven published captures held the trace's own folder that way until they were republished. `tests/fixtures/captures.test.ts` holds every capture's deltas to its complete frames.
