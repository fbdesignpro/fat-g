# 0001 — Which mechanism supplies Claude usage allocations

> **Rule:** Claude usage comes from the CLI's `get_usage` control request, sent by fat-g's own client ([0006](0006-no-agent-sdk-at-runtime.md)) in a short-lived idle session: no prompt, empty setting sources, strict MCP configuration, a neutral working folder, polled no faster than every 60 s. If the CLI rejects the request, show the account-only panel (outcome C).

- **Status:** Accepted, decided by spike S1 (`spikes/claude-usage.mjs`). **Mechanism amended by [0006](0006-no-agent-sdk-at-runtime.md) (implemented by M7b):** the same Tier 1 `get_usage` control request is now sent by fat-g's own client instead of the Agent SDK. The SDK-specific text below — `query()`, `accountInfo()`, the method name, probe option names, the SDK pin — is historical. The outcome rules, the isolation requirements (as the equivalent CLI flags) and outcome C are unchanged. See "M7b amendment" under Constraints.
- **Applies to:** `src/main/providers/claude/`

## Context

There is no `claude usage` subcommand. Within the rules of [0004](0004-never-touch-credentials.md), the candidate mechanisms were:

| Tier | Mechanism | Pros | Cons |
|---|---|---|---|
| **1** | Agent SDK control request `get_usage`, exposed as `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` | Full `/usage` data incl. per-model weekly windows and extra-usage | Explicitly unstable; name *will* change; absent from public docs (typings only) |
| **2** | Send `/usage` as a prompt; read `usage_report` off the resulting assistant message | Same data | Requires a "turn"; unknown whether it is local/free |
| **3** | Statusline hook `rate_limits` JSON | Documented, first-party | Lacks per-model window; needs a real API response first; would touch user settings → deferred to Phase 3 |

## Decision

**Outcome A — Tier 1.** A short-lived SDK probe per poll: open an idle streaming-input `query()`, call `accountInfo()` and the usage method, close. Poll no faster than 60 s.

Probe options (all four are required):

```ts
{
  pathToClaudeCodeExecutable: <resolved user binary>,   // decision 0003
  cwd: <userData>/probe-cwd,                            // never a user project
  settingSources: [],                                   // skip user/project/local settings files
  strictMcpConfig: true, mcpServers: {},                // see "MCP servers" below
}
```

**M7 implementation amendment:**

- **Outcome C** also covers a pinned SDK whose method exists while the separately updated CLI answers `get_usage` with its fixed `Unsupported control request subtype: get_usage` rejection — compared exactly, and only in `usage-experimental.ts`. Any other failure is transient.
- A recognized response with `rate_limits_available: false` or `rate_limits: null` is the neutral `not-applicable { usage-unavailable }`, not `api-key`. API-key and cloud sessions are classified earlier, from `claude auth status`, and re-checked from `accountInfo()` before any usage request. Both usage-level outcomes keep an account-only panel.
- The probe also passes `persistSession: false`, `env: {}`, the session's `abortController` and a tracked `spawnClaudeCodeProcess` (the user's binary, launched and cleaned up by fat-g's process layer). Bootstrap disables the SDK host's own debug logging first. Details: phase-1-m7.md (private).

## Spike evidence

Environment: Windows 11, Claude Code 2.1.268 (winget), `@anthropic-ai/claude-agent-sdk` 0.3.278, a claude.ai subscription.

| Question | Result |
|---|---|
| Works on an idle query, before any prompt? | **Yes.** |
| Spends model tokens? | **No model turn observed.** The session emitted zero messages while idle (no `assistant`, no `result`) across 10 probes. `five_hour.utilization` stayed at 8 throughout; 5 distinct `as_of` timestamps show the CLI was genuinely re-reading the usage endpoint rather than serving one cached value. |
| SDK/CLI version skew tolerated? | Yes — SDK 0.3.278 drove CLI 2.1.268 without issue. |
| Latency | `accountInfo()` ≈ 675 ms (includes process start). Usage reads 15–270 ms each. |
| Clean exit | `close()` → process gone in ≈ 220–290 ms, no orphan. |
| Transcript written for the probe cwd? | **No.** |
| `utilization` scale / `resets_at` format | **0–100**; ISO 8601 with microseconds and offset (`2020-01-12T17:50:00.118418+00:00`). `Date.parse` accepts it. `resets_at` may be `null`. |
| `claude auth status` | Exit 0, JSON: `loggedIn, authMethod ("claude.ai"), apiProvider ("firstParty"), subscriptionType (a slug), email, orgId, orgName, configDirectory, projectsDirectory, analyticsDisabled`. |
| `accountInfo()` | `{ email, organization, subscriptionType, apiProvider: "firstParty" }` — note `subscriptionType` is a *display string* here but a slug in `auth status` and in the usage response's `subscription_type`. Prefer the slug. |

### MCP servers

`settingSources: []` isolates settings **files**, not the **account**: without further options the probe session had 4 MCP servers attached, all `scope: "claudeai"` (connectors on the user's claude.ai account; statuses `pending` / `needs-auth`). With `strictMcpConfig: true, mcpServers: {}` the count is **0** and usage still works. A background probe must never start connecting to a user's connectors, so this option is mandatory.

### Response shape (what to normalize from)

`rate_limits` contains far more than the typings describe:

- Named windows `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, … each `{ utilization, resets_at, limit_dollars, used_dollars, remaining_dollars, locked_reason } | null`.
- ~15 unexplained codename keys (`tangelo`, `nimbus_quill`, `cinder_cove`, …), mostly `null`. **Ignore unknown keys** (`z.looseObject`); never render them.
- **`limits[]`** — a server-ordered array: `{ kind: "session" | "weekly_all" | "weekly_scoped", group, percent, severity: "normal" | …, resets_at, scope: { model: { display_name } } | null, is_active }`.
- `model_scoped[]`, `extra_usage`, `spend`, `seven_day_breakdown` (per-surface share of the weekly window).

**Normalize from `limits[]` first** (it is already ordered, labelled by `kind`, and severity-graded; `is_active` marks the binding limit), falling back to `five_hour` / `seven_day` / `model_scoped` when `limits` is absent. Mapping: `session` → `rolling-5h`, `weekly_all` → `weekly`, `weekly_scoped` → `weekly-model` with `scope.model.display_name`. Classify on `kind`, never on a label.

Redacted fixtures: `tests/fixtures/claude/`.

## Not tested

- **Logged-out and API-key sessions** (would require the maintainer to log out). Expected per typings: `rate_limits_available: false`, `rate_limits: null` → render `not-applicable`. Gate on `claude auth status` exit code first. Cover with synthetic fixtures; verify manually before release.
- **Tier 2** (`--try-slash-usage`) — not run: it may spend tokens and Tier 1 made it unnecessary.
- `getHooksListing()` — CLI 2.1.268 answers `Unsupported control request subtype`, so hook isolation is inferred from `settingSources: []` rather than observed.
- macOS / Linux.

## Constraints

- The experimental method name appears in exactly one file, `src/main/providers/claude/usage-experimental.ts`: feature-detected (`typeof q[name] === 'function'`), try/catch, 10 s timeout. If it is missing → **outcome C**: account-only panel + `not-applicable { unsupported-cli-version }`.
- `@anthropic-ai/claude-agent-sdk` pinned to an exact version; SDK import confined to `claude/sdk-session.ts`.
- The `Query` object also exposes `claudeAuthenticate`, `claudeOAuthCallback` and `claudeOAuthWaitForCompletion`. **These must never be called** — offering claude.ai login from a third-party app is prohibited ([0004](0004-never-touch-credentials.md)). Login stays delegated to `claude auth login`.
- Show `not-applicable` (not a broken meter) for API-key / Bedrock / Vertex sessions (`apiProvider !== "firstParty"` or `rate_limits_available === false`).

**M7b amendment**, replacing the SDK-specific constraints above:
- The request goes over fat-g's own client (`claude/control-client.ts`, `claude/session.ts`). The session uses the argv the SDK passed for these options: `--setting-sources=` for `settingSources: []`, `--strict-mcp-config` with no `--mcp-config` for the empty strict MCP set, `--no-session-persistence`, `--permission-mode default`, stream-json in and out. It sends the SDK's `initialize` frame, whose reply's `account` replaces `accountInfo()`. The reference is `tests/fixtures/claude/sdk-0.3.278-wire.json`.
- `get_usage` is sent only by `claude/usage-experimental.ts`, the only file that knows the exact rejection text. The client's closed subtype type allows `initialize` and `get_usage` only, so the login/OAuth requests the SDK exposed (`claude_authenticate`, `claude_oauth_*`) cannot be sent.
- Outcome C is the exact CLI rejection of `get_usage`. There is no longer a JavaScript method to feature-detect.
- No `@anthropic-ai/*` package may be imported or depended on ([0006](0006-no-agent-sdk-at-runtime.md)).

**M13 amendment (M13 C97):** the 60 s floor spaces the reads fat-g starts on its own — the poll, a reconnect, an account change. A new provider runtime and the user's Refresh read at once, one read at a time: a Refresh during a read joins it. The CLI's own machine-wide cache of about a minute still applies, so a Refresh soon after a read may return the same figures.

**Wake amendment (the maintainer's report: a machine woken from sleep showed "Usage not applicable"):** a machine that has just woken answers before its network does, and the CLI then reports no allocations — the same `rate_limits_available: false` or `rate_limits: null` as a signed-out or API-key session. That is not the account's word, so for **five minutes after a wake or an unlock** such an answer, and a failed read alike, leaves the readings on screen under the `waking` status — "Rechecking after sleep", with the bars drawn hollow as any historical reading — and the next read comes 10 s, 20 s, 40 s and then 60 s later, under the floor above, which spaces only the reads that trust their answer. The window's first read still waits for the floor, so an unlock never reads twice within a minute.

The window closes early on an answer the network cannot explain — a reading, a signed-out account, an API key, a cloud provider, the CLI's own rejection of `get_usage` — and on an account that is no longer the one the readings belong to. When it closes on its own, that read's answer stands exactly as it would without a wake: the error backoff, or the account-only panel of `not-applicable { usage-unavailable }`. Where the answer is honest, the user waits about two minutes longer than before for it.

Not taken: asking the machine whether it has a network before reading. `electron.net` is a banned import in main (`tests/architecture/boundaries.test.ts`) and fat-g makes no network calls of its own ([0004](0004-never-touch-credentials.md)), so the recovery is spaced by time alone.

## Revisit when

- The method is renamed/stabilized (expected — update the one file), or removed (fall to outcome C, reconsider Tier 3 as per-session statusline injection in Phase 3).
