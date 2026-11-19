# 0009 — Session data: trace the providers first, keep simulation thin

> **Rule:** session contracts are shaped by captured provider traces. Simulation is limited to fixture summaries, a development-only demo source and fakes that replay captures. A read-only live slice comes early, Codex first. No automated test uses a real account.

- **Status:** Accepted by the maintainer. Implemented for both providers: the traces (M10), the fixture summaries and the demo source (M14), then for each its replay fake and its live slice — Codex's read-only one in M15, with [0018](0018-codex-sessions.md), and Claude's in M16, with [0020](0020-claude-chat-sessions.md), held to tools that read since Claude has no sandbox to make it read-only.
- **Applies to:** session contracts, provider adapters, test fixtures, the demo data source.

## Context

The new layout shows live facts about each session: status, time since the turn started, number of active workers, and what needs the user's attention. All of them come from the providers' event streams. The normalized agent-event union is not designed yet, and `capabilities.sessions` is still `false`.

Two ways to feed the UI before chat exists were discussed:
1. Build a detailed simulated session source first, and connect the providers later.
2. Connect a provider early with a very primitive chat, and simulate only what is needed.

Points that weigh on the choice:
- Most of the uncertainty is in the providers. The protocol research (private) lists ten items still to verify by tracing.
- A simulator written before tracing encodes guesses, and contracts shaped by it would need rework.
- The connections to both CLIs already exist from Phase 1.
- Automated tests cannot use a real account: CI cannot log in, agents never perform logins, and live turns cost subscription usage and differ between runs.

## Decision

1. **Trace first.** Before the session contracts are written, a spike captures a basic turn from each CLI. The captures are redacted and saved as fixtures, as S1 and S2 did.
2. **Simulation is limited to three things:**
   - fixture summaries for component tests, including states that are hard to produce live (errors, several questions, many workers);
   - a small demo source for development, left out of release builds the way smoke hooks are ([decision 0007](0007-packaged-build-contents.md));
   - fake CLIs that replay captured frames, for adapter tests and smoke runs.
3. **A live slice comes early.** One session in a trusted project root, read-only, showing whole messages as plain text in a primitive chat area. Read-only means the agent never has to ask for approval, so the slice needs no approval UI.
4. **Codex first, then Claude.** Codex needs no existing decision reopened. Claude needs a new decision record in place of [decision 0006](0006-no-agent-sdk-at-runtime.md)'s closed request set.
5. **No automated test uses a real account.** Live providers are for tracing and for the maintainer's manual acceptance.

## Consequences

- The session contracts are shaped by captured evidence, not by the research notes alone.
- The fakes protect against regressions in fat-g's code. They do not detect provider changes: those are caught by re-running the capture spike against a new CLI version.
- Live tracing and acceptance spend a little subscription usage, and leave real threads and sessions in the user's Codex and Claude history.
- Approvals and questions are the next slice after the read-only one. They are also what drives the attention states (READY, 3 QUESTIONS).

## Revisit when

- The demo source grows beyond a small development aid.
- A provider publishes a documented, stable session protocol: prefer it, and re-capture.
