# 0028 — The secretary: small requests a session's own account answers

> **Rule:** a short judgment fat-g makes about a session — from M26 its title, and what the text standing unsent in a session that has run nothing is about — is asked of the session's own instance. It goes in a process of its own, started for the one request in fat-g's probe folder, never a project's.
>
> - **On Claude:** a `claude` process with fixed arguments. It loads none of the user's settings, hooks or MCP servers, offers no tool, does not think and saves no session. It sends `initialize` with the task's instruction as the system prompt, then one prompt.
> - **On Codex:** an app-server of its own, with a fourth fixed method set. One ephemeral thread is started read-only, with `never`, the task's instruction as its base instructions in place of Codex's own, and overrides that switch off its sub-agents, hooks, plugins, apps and web search. It is checked against Read only before its one turn.
> - **What is sent:** the task's fixed instruction and the text the task names, each cut at 2,000 characters and nothing else. For a title, that is the first prompt; for a description, the draft the user has typed and not sent, which goes at the one moment they leave the session for another.
> - **What the CLI asks:** every request it makes is refused.
> - **What is kept:** the answer is bounded, and only what the task makes of it is kept. Both answers are names of the `generated` source, which replace the first prompt's name and never one the user typed; a description is shown behind "New session: " until the first turn, and the title replaces it then. Nothing of it reaches a log, the app state beyond that name, or the Pet.
> - **The user's choice:** titles can be switched off, and Settings names the model that writes them. No model name ships with fat-g.

- **Status:** Accepted by the maintainer, with M26's plan (milestone document (private)), built from the research note's §7 (session naming (private research note)). Implemented in M26. A second task — a description of a session no turn has run, from its unsent draft — was added at the maintainer's word (M26, round 2), which is the first text fat-g sends that the user has not pressed Send on. Amends four records:
  - [0006](0006-no-agent-sdk-at-runtime.md): a third kind of Claude process, with a closed set of its own;
  - [0018](0018-codex-sessions.md), item 2: a fourth method set; and item 4, at the maintainer's word: base instructions and a `config` of overrides that switch things off, for the secretary's thread alone;
  - [0011](0011-records-store.md), items 4 and 6: the `generated` and `user` names in use, and the rename;
  - [0005](0005-preferences-compatibility.md): revision 7.

  M22e, added a sentence to item 5 (C2, C26; [0029](0029-plans.md), item 12): a reviewer's first prompt asks no title.
- **Applies to:**
  - the secretary's service and its tasks (`src/main/sessions/secretary/`);
  - the facet member `SessionFacet.secretary` (`src/shared/provider-kit/sessions.ts`);
  - Claude's `secretary.ts` and `secretary-wire.ts`, and Codex's `secretary.ts` and `methods.ts`;
  - the preferences' `titles` section and the `sessions:rename` and `sessions:describeDraft` channels;
  - `PRIVACY.md`.

  Builds on [0004](0004-never-touch-credentials.md), [0015](0015-no-writes-into-project-folders.md), [0017](0017-provider-instances.md), [0019](0019-conversation-store.md), [0020](0020-claude-chat-sessions.md) and [0025](0025-asides.md).

## Context

- **What a session was named by.** A session was named by the first line of its first prompt. The ladder that lets a better name replace it — `user > generated > provider > first-message` — existed from M14, and nothing reported a `generated` name.
- **The providers' own names do not reach fat-g** (research §7). Claude Code generates an `aiTitle` and writes it only to its transcript, which [0017](0017-provider-instances.md) and [0020](0020-claude-chat-sessions.md) forbid fat-g to read. Codex's app-server names no thread.
- **How Codex's own app names a thread.** Codex's IDE extension makes its names itself: a one-shot ephemeral thread on a small model, from the first message alone, cut at 2,000 characters.
- **M26's spike traced both routes** (milestone document, Findings).
  - **Claude:** no transcript was written, the instruction took the place of Claude Code's own system prompt (about 500 to 700 input tokens), and thinking had to be switched off.
  - **Codex:** the ephemeral thread was read-only and absent from the thread list afterwards. With the instruction as developer instructions it cost about 13,100 input tokens, Codex's own agent instructions among them; with it as the base instructions, in their place, about 9,600; and with the overrides Codex's own extension sends its titles beside them, about 5,500, its `codex_apps` server not started at all.

## Decision

1. **One process per request, on the session's own account.** The request goes to the instance the session runs on, in that instance's process scope: its configuration folder and its environment policy, so the text reaches no account it was not already sent to. The process runs in fat-g's probe folder (`probe-cwd`), never the project's, and is ended when its answer is in, or when it is let go of.
2. **On Claude.**
   - **The arguments:** `--output-format stream-json --verbose --input-format stream-json --setting-sources= --strict-mcp-config --no-session-persistence --tools "" --thinking disabled --model <key>`, with `--effort <level>` where the model takes one. No text of the request goes on the command line.
   - **The sends**, from one writer (`secretary-wire.ts`) with a closed set of three: `initialize` carrying `systemPrompt: [instruction]`; one `user` frame holding the text; and the usage client's refusal, `unsupported`, to whatever the CLI asks.
   - **What is read:** the session's own final text that a model wrote, up to the `result` frame. A `result` that is an error, or no text, is no answer.
   - **The end:** the end of its input, two seconds' grace, then its tree confirmed gone, through a held process, so a failed cleanup latches nothing of the instance.
   - `--bare` is not used: it reads no OAuth login.
3. **On Codex.**
   - **The method set:** a fourth connection kind, `secretary`, holding `initialize`, `initialized`, `thread/start` and `turn/start`. Its handshake is the client's name and an opt-out of every delta.
   - **The thread:** `thread/start` sends the probe folder, the mode table's read-only policy (`sandbox: "read-only"`, `approvalPolicy: "never"`), `ephemeral: true`, the instruction as `baseInstructions` — in place of Codex's own agent instructions, which a title needs none of — the model, and `config`: `SECRETARY_CONFIG`, the overrides Codex's own IDE extension sends its title threads, every one of which switches something off (sub-agents, hooks, plugins, the shell snapshot, tool suggestions, apps and their connectors, web search) and none of which sets anything of the user's. A start Codex refuses with them is asked once more without them, so a key a later Codex no longer takes costs the saving and not the title. Its reply is held to Read only, as an aside's fork is, before the one `turn/start`, which sends the text, the model and the level.
   - **The answer:** the turn's last `agentMessage`, at a `turn/completed` that says `completed`.
   - **What the CLI asks:** every request is "method not found".
   - **What is not switched off:** the user's own MCP servers, which no override names, and the shell and file tools, which no stable key reaches. The guard is the aside's three ([0025](0025-asides.md)): read-only, `never`, and an instruction to act on nothing.
4. **The model and its level.** Settings defaults to **Latest small model**: the newest visible, CLI-reported member of the provider's small family, selected per account from its current catalog. Claude's module recognizes Haiku and Codex's Luna, comparing numeric versions and dated revisions; no fixed model identifier is shipped. Catalog reports at startup and later refreshes recompute the choice in memory, and each naming request uses that current choice. With none available, the session's own model writes the name. An explicit session-model choice or a concrete model remains available; a concrete model the account does not list falls back to the session's own. A catalog that lists nothing yet names the session's model with no level, and one that no longer lists either asks nothing. The level is the model's lightest without the caution mark, or none for a model with no levels. fat-g ships no model identifier: the choices are what the instance's CLI lists.
5. **What is sent and kept.**
   - **What is sent:** a task's fixed instruction and the text it names, trimmed and cut at 2,000 UTF-16 units on a code point, under one line that says what it is. The title task's text is the first accepted prompt. The draft task's is what stands unsent in the composer of a session that has no provider session, no turn and no name of the user's, sent when the selection moves away from it and never for the same text twice; the page cuts it before it leaves the page. A bare `/` command or skill ([0023](0023-cli-commands-pass-through.md)) is sent for neither; one followed by non-whitespace text is eligible for both, including its command and arguments in the text sent. *(M22e:)* nor is a reviewer's first prompt, which fat-g composes: the session is named "Review of Plan: <title> v<N>" at its creation, as a `generated` name, and its prompt names nothing.
   - **What the reply becomes:** its first line, cut at the message bound. The task strips quotes, Markdown marks, a "Title:" label and closing punctuation, cuts it at a word within the session title's 160 grapheme clusters, and normalizes it as every session title is. The title instruction asks for a concise title of three to six words and at most 36 characters, Codex's own app's cap, well inside that bound, since a model aims for the length it is given and a shorter title reads better; the draft instruction still asks for a shorter phrase. The top heading wraps over at most four lines, while capsules fit the same title to two lines using the actual font and available width.
   - **Language:** both tasks explicitly follow the user's own request, ignoring the language of quoted text, code, file paths and logs. An English request gets an English name; an unclear language defaults to English.
   - **Prompt discipline:** both tasks describe a UI labeling operation, treat the supplied message as source text rather than instructions, explicitly exclude reasoning and commentary about the model or naming assignment, and show concrete input/output examples, including an English request quoting a German error. A final instruction repeats that the label alone is returned. These are prompt constraints, not a guarantee that a model's language or subject is correct.
   - **What is kept:** that name alone, as `name-reported` with the source `generated`. The ladder lets it replace the first prompt's name and nothing above it, so a name the user typed is never replaced. A description is kept as the name itself, without the "New session: " the page shows before it while nothing has run; the first prompt of a session named that way asks for a title all the same, and writes no first-prompt name over it.
   - **What is logged:** counts and failure kinds — empty, failed, timeout, no model — never a prompt, a reply or a title ([0019](0019-conversation-store.md), item 13).
   - **Before the answer:** a draft with no name shows its opening text in the renderer, behind "New session: ", until the secretary supplies its description. That preview is bounded by the session-name limit, stays out of records and app state, and changes no saved format. The capsule uses regular-weight 13 px type.
6. **Limits.** At most two requests run at once for an instance, and the others wait their turn. A request has 30 seconds from its start, the launch included. A session's request is let go of when the session is removed, when the user names it, and at the quit; an answer that comes after is nobody's.
7. **Tasks and providers are modules.** A task is its instruction, its input and its parse, in a file of its own beside the title's (`title.ts`, `draft.ts`), over the bound, the cut and the one parse they share (`task.ts`); the service takes a task and knows no title from a description. A provider takes part by its facet's optional `secretary` member, which needs no capability flag to be called. The descriptor's optional `titles` flag only tells Settings to offer the model choice, and a provider without the member keeps the names fat-g gives it.
8. **The user's three controls.**
   - **Name sessions automatically**, in Settings → General, on by default.
   - **Titles written by**, per provider: Latest small model (the default), the session's own model, or one of the models its instances list. Preferences revision 23 stores the explicit session choice as `$session` in `titles.models`; an absent entry means Latest small model, and a concrete key pins that choice.
   - **Rename**, in a session's menu: the name as a field, kept as `user` through `sessions:rename`, normalized, and refused when nothing is left.

## What is left out

- **Keeping names in step with the providers' own apps** — pushing a name with `rename_session` or `thread/name/set`, and pulling theirs back (research §5 (private)). That is later work.
- **Titles for sessions that already exist**: there is no backfill.
- **Any task but those two.**
- **Any override that sets something rather than switching it off**, and any `config` for a session's thread or an aside's.

## Consequences

- **A draft leaves the page before Send.** Until round 2 a composer's text went to main at Send alone. It now also goes, at most 2,000 characters of it, when the user leaves a session that has run nothing — to the session's own account, in a process with no tool that saves nothing, and only to give the capsule a name worth reading. It is not written to the conversation store: a prompt is recorded when it is sent, and this text has not been sent.
- **The first prompt is sent twice.** Its first 2,000 characters go a second time to the same account, in a session the CLI does not save. That spends a little of the user's plan: Claude's request costs about $0.0005 to $0.0025 in the spike's account. Codex's is about 5,500 input tokens each time (K2).
- **The title comes a few seconds after the first-prompt name** — about one second on Claude with a small model, and two on Codex — and never at all when the request fails.
- **The fakes pin both launches.** The Claude fake starts the secretary only for exactly its fixed arguments, and the Codex replay answers its turn from K2's capture. A new CLI version runs K1 and K2 again before the captures are trusted.
- **The probe folder holds the secretary's processes too.** It is still empty: neither CLI writes there in the spike's runs.

## Revisit when

- A CLI sends its own generated title over the stream fat-g reads: take it as the `provider` source, and ask the secretary nothing for that provider.
- A Codex version refuses or ignores an override: the retry without them keeps titles, and K2 runs again to find the key.
- A task needs more than the first prompt — the first answer too, say. The aside route ([0025](0025-asides.md)) has the session's context, at the cost of its whole context.
