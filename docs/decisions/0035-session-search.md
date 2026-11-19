# 0035 — Local session search over names and saved messages

> **Rule:** Main searches saved session names and the conversation store's normalized user and assistant messages through an index held only in memory. Search makes no network or provider call, reads no project or CLI file, changes no stored format, and persists no query, excerpt or index. Only the Main window can search; the mini window receives none of it.

- **Status:** Implemented from the maintainer's approved plan.
- **Applies to:** the conversation store's search projection, `src/main/sessions/search/`, the two Main-only search channels, `src/renderer/src/session-search/`, and `PRIVACY.md`. Extends [0019](0019-conversation-store.md) without a format change.

## Context

The session switcher opens known sessions quickly. Finding an older discussion also needs names and message text, including sessions marked Done or shelved and projects hidden from the list. The existing database already holds the needed normalized messages; providers need no new capability.

## Decision

- A search-shaped button above the project list opens a modal dialog with its search input focused. Arrows highlight, Enter opens through the ordinary session-selection path, and Escape closes. Opening a result preserves the current draft and the result's Done or shelved state; it does not jump to a message.
- Filters are Project, All/Active/Done/Shelved, Names and messages/Names/Messages, Allow typos, and Best match/Most recent. Each opening defaults to the selected session's project, or All projects when no valid project is selected; the Project filter can still select any project or All projects. Defaults include all session states and both fields, with typos allowed and Best match selected. Project names are filters, not searchable content. Hidden projects remain listed in the filter. Empty unnamed provisional sessions and detached conversations are excluded.
- The store exposes bounded, read-only pages of saved user and assistant message text and a single-message read. Side questions, worker messages, activity, questions, permission cards, unsent drafts, queues and plan-store text are excluded. Text already sent as a user message is searchable, including prompts composed for a plan or review. History imported through the ordinary store path is searchable too; search imports nothing itself.
- MiniSearch 7.2.0 is a pinned runtime dependency. The index is lazy, built from pages of at most 64 messages with a 256,000-unit batch target, and yields between batches. It retains terms and identifiers, not full message bodies; an excerpt is read from the store only for a returned hit. Query work yields between partitions of at most 128 documents so a broad prefix does not monopolize the main process.
- Unicode words are case- and accent-insensitive. All query words must match one name or one message. Prefix matching starts at two characters; typo allowance is one edit for words of four to seven characters and two for longer words. Exact terms outweigh prefix and fuzzy terms, and names receive a boost. Relevance uses the best matching document per session, with activity time and session id as tie-breakers. Most recent orders matches by saved activity time. An empty query lists recent sessions.
- A response holds at most 50 distinct sessions, with original-text highlight offsets and at most one plain-text message excerpt of 240 UTF-16 units. The dialog can request more pages. Text is rendered as DOM text, never as HTML or Markdown. Queries are limited to 200 units.
- Successful store commits notify the index with identifiers only; rollbacks notify nothing. New messages, streaming saves, history merges, renames, removals and resets invalidate affected documents or the whole index. A generation and revision check rejects results overtaken by a write or reset. A closed dialog stops polling, cancels outstanding query publication and drops the cached query and result. Filter choices live only for the window's run; Project resets to the current project on each opening.
- While the first index builds, names remain searchable. If messages cannot be read, the dialog says so and permits name search; unreadable records return no results. Failures never log query or message text. Search does not repair or modify a refused store. Main-only IPC returns bounded results and accepts an explicit close notification; neither channel is available to the mini window.

## Consequences

No search database, migration, network service or embedding model is needed. The first message search pays the index's build cost and the index consumes memory until shutdown or reset. Small partitions keep queries interruptible; relevance is an approximate ranking across partitions rather than a global corpus score. Words split across separate messages do not satisfy a multiword query unless one message contains every word. Removing content invalidates its search documents immediately, and snippets are never a second durable copy.

## Revisit when

Real archives make startup indexing, memory use or broad searches too costly; multilingual tokenization needs more than word boundaries; or users need phrase, semantic, attachment, sub-agent or plan search. A persistent index would require a new explicit privacy and removal decision.
