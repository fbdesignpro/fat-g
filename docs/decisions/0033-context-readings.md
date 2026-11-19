# 0033 — Context readings: how full a chat's context window is, as its CLI counts it

> **Rule:** a chat shows how full its model's context window is from its CLI's own counts alone, never fat-g's estimate. Claude is asked by `get_context_usage` with `detail: 'summary'` at a turn's start while no reading is held and after each turn the CLI ended, with no wait on the reply; between replies each `assistant` frame of the session's own thread gives the count. Codex's `thread/tokenUsage/updated` is read for the session's own thread. A reading holds counts and the CLI's labels for the used parts, never a path or a configured name. It lives in the session's summary in memory, and is never stored, logged beyond counts, or sent to the Pet.
>
> - **What a reading is:** tokens used, the model's window, where the CLI compacts by itself (null where it says it will not, absent where it does not say), the used parts by the CLI's own labels, what the messages hold by kind, the last call's counts and, where the CLI totals them, every call's.
> - **Where it shows:** the context meter beside the mode control, two rows of cells filled in the provider's colour, the cells past the compaction line on dark red; its tooltip a table of the parts.
> - **Who draws it:** only a provider whose descriptor says `capabilities.context`; a new provider reports one by sending `context` events, and needs no change of shared code.

- **Status:** Accepted with the maintainer's plan; implemented with it. Amends [0020](0020-claude-chat-sessions.md), item 2 (a tenth send), and [0018](0018-codex-sessions.md) (a notification read, no method added).
- **Applies to:**
  - `ContextReading`, its schema and `sameContext` (`src/shared/contracts/sessions.ts`); the `context` agent event, version 12 (`src/shared/contracts/agent-events.ts`); `ProviderCapabilities.context` (`src/shared/contracts/provider.ts`);
  - Claude: the tenth send (`chat-wire.ts`), its reader (`chat-context.ts`), and when it is asked (`chat-session.ts`);
  - Codex: `takeTokenUsage` (`session-schemas.ts`), read in `session.ts`;
  - the bridge and `SessionSummary.context` (`src/main/sessions/bridge.ts`, `summary.ts`);
  - the page's `ContextMeter`, its tooltip and words (`src/renderer/src/session-area/`).

  Builds on [0004](0004-never-touch-credentials.md), [0010](0010-pet-deferred.md), [0011](0011-records-store.md), [0019](0019-conversation-store.md), [0023](0023-cli-commands-pass-through.md) and [0024](0024-a-sessions-work.md).

## Context

- A long agentic turn fills the context window, and each CLI compacts it by itself near its end. Without a reading the user learns of it only when a compaction comes.
- Both CLIs already count it. Claude's assistant frames carry each call's usage, and its `get_context_usage` request gives the whole picture: the count, the window, the line it compacts at and the parts. Codex reports each thread's last call and running total, with its model's window, as a notification it sends anyway. The verified shapes are in the chat protocols note (private), "Context readings".
- `get_context_usage`'s full detail counts each part with the token-count API; its summary detail answers from the last response's usage and the CLI's own estimates, with no call of its own (the installed CLI's schema says so; M10's reply came in 19 ms). Its reply also lists memory files by path, MCP tools and servers, agents and skills by name.
- Codex says nothing of where it compacts: the limit is its configuration's, which no `config/` method may read ([0018](0018-codex-sessions.md)).

## Decision

1. **The CLI's count, never fat-g's.** Nothing is estimated, and no window size is shipped as a default: what a reading says is what the CLI said, in its own counts. A `/compact` shows a smaller context only once the CLI counts it so ([0023](0023-cli-commands-pass-through.md), item 3).
2. **Claude: asked, then counted between.** A chat session's tenth send is `get_context_usage` with `detail: 'summary'` and nothing else; the full detail is never written. It is sent at a turn's start while the process holds no reading — before the turn's other sends, none of which waits on it — and after each turn the CLI ended, a compaction's included; never for a process launched for an aside alone. One request is in flight at a time; a turn's end meanwhile asks once more after its reply. Nothing waits on it: a reply late past 15 s, lost or unreadable changes nothing, and a refusal ends the asking on that process. Between two replies, each `assistant` frame of the session's own thread gives the count — what its call read anew, from the cache and into it, and wrote — with the last reply's window and line; a sub-agent's frame, one whose call read nothing, and one outside a turn are not counted. A count that came after the request was written is newer than the reply's, and is kept over it.
3. **Codex: its own thread's report.** `thread/tokenUsage/updated` is subscribed beside the turn mapper, which still never parses it. The session's own thread's report is the reading: the last call's whole count against `modelContextWindow`, as Codex's own interface reads it, the last call and the running total, the cache read set apart from the input. A sub-agent's, a side thread's and an unreadable report are counted as skipped.
4. **Counts and the CLI's labels alone.** Of a Claude reply, the count, the window, the line or the word that there is none, the rows its categories class as `used` — by their `kind`, never by name — each under its label where that is letters, spaces and brackets of at most 40 characters and `Other` otherwise, at most sixteen; the messages' seven totals by kind, never their lists by tool or by attachment; and the last call's usage. Its memory files, tools, servers, agents and skills are never read: the module spells none of their keys.
5. **Said where it changed.** A session emits `context` only where the reading differs from the last it said. The bridge gives it to the summary alone; the summary keeps it until the next replaces it, through the turn's end, a Stop and the process's end, since it is the conversation's.
6. **Never kept.** A reading is a usage reading in the sense of [0011](0011-records-store.md) and [0019](0019-conversation-store.md): it is in no store, file or log. The Pet's projection carries no session ([0010](0010-pet-deferred.md)).
7. **Drawn as cells.** The meter is 15 columns of two cells — one and a half times the mode control's "Auto reviewed" — filled column by column — the share used rounded, one at least for any use — in the provider's own colour; the cell the compaction line falls in and every one after it stand on dark red. Its tooltip says the count, the window and the share in tokens, the line, then one table, a section per group the CLI counted, each row with its count and a bar of its share of its section's largest, and that sizes are in tokens. With no reading yet it stands empty, and says it shows once the chat's next turn begins.

## Consequences

- Claude's chat session sends ten things ([0020](0020-claude-chat-sessions.md)); the confinement test pins the summary detail and that no key of the reply's names is spelled.
- Each Claude process asks at most twice a turn, and its CLI answers from what it holds.
- A provider that reports nothing draws no meter; one that adds a reading declares `context` and sends the event, with no change of shared code.

## Revisit when

- Codex reports where it compacts, or its configuration's limit becomes readable without a `config/` method: its red cells follow.
- Claude's summary detail starts making calls of its own, or the reply's `kind` or field names change: item 4, after a trace.
- The user asks to keep a chat's last reading across a restart: that is a stored usage reading, and a change to [0011](0011-records-store.md) or [0019](0019-conversation-store.md).
