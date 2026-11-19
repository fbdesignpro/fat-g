# 0011 — Records store: projects and sessions in one versioned JSON file

> **Rule:** projects and sessions live in one `records.json` beside `preferences.json`, read and written only by the main process, atomically, under decision 0005's version envelope. A session stores the provider's reference, never the conversation: what was said is in the conversation store ([0019](0019-conversation-store.md)). Project names are clamped to 60 grapheme clusters; session titles to 160. A file this build cannot read safely is left untouched and records become read-only, until the user chooses Start fresh and confirms it, which moves the file aside unchanged.

- **Status:** Accepted by the maintainer, from M10 (C30–C33, C37–C39, C50, C51, C71, C72, C75). Projects implemented in M12, which amended items 8 and 11 (C65, C80). Sessions implemented in M14, which settled items 4, 7, 8 and 10 for them (C1, C3, C9, C12). M14b, added a session's instance and configuration folder and raised the version to 3 (C26, C61; [0017](0017-provider-instances.md)). M18, added the last turn's id and raised the version to 4 (C29), and moved conversation content to a store of its own ([0019](0019-conversation-store.md)). M22, added a project's default mode for each provider and raised the version to 5 (C25, C40; [0027](0027-execution-permissions.md)). A session's speed tier later raised it to 8 ([0016](0016-model-presets.md)). Before the first public release, [0014](0014-format-compatibility-starts-at-first-release.md) relaxes item 7.
- **Applies to:** the main process's records store, its IPC channels, `PRIVACY.md` (M12). Extends [decision 0005](0005-preferences-compatibility.md) to a second file.

## Context

- The providers already keep the conversations (Claude's session store, Codex's thread store), so fat-g needs only enough to list, find and resume its sessions. M10's traces show what a reference holds: Claude's `session_id`, Codex's thread id (turn-tracing.md (private research note)).
- The atomic writer covers one file per write, so projects and sessions in two files could not change together.
- Records number in the hundreds; a database would be a new shipped dependency ([0007](0007-packaged-build-contents.md)).
- Claude keeps sessions per working folder, and a project's roots can change after a session starts.

## Decision

1. **File:** `records.json` in the user data folder (`fat-g`, or `fat-g-dev` for development runs), holding projects and sessions. JSON, written by the preferences' atomic writer. No database.
2. **Ids:** a random UUID per project and per session, never reused. A session names its project by id.
3. **Per project:** id, name, colour from a fixed set, root folders (absolute, in the user's order), position, hidden flag, saved session-list fold, enabled providers, and the trust answer per root with its time. *(M22, C25, C40:)* and its default mode for each provider's new chats, by provider id: the id of one of that provider's modes, a provider with no entry using the user's own default ([0027](0027-execution-permissions.md), item 7). An entry that reads as a mode's id is kept, whether or not this build knows its provider or the provider still lists the mode: whether it is one is asked when a chat's mode is resolved.
4. **Per session:** id, project id, provider id, the provider's session reference, the folder it started in, model, effort, name and its source (`user`, `generated`, `provider`, `first-message`), starred, completed, created and last-active times. *(M14, C2, C9, C10:)* and its last turn: when it started, when it ended and how. *(M18, C29:)* and that turn's id, the runtime's own: the record and the conversation store are reconciled by it. The last turn is the session's alone — when it stopped running for the turn — and never the provider's end of it (M18, C54). A name replaces the stored one only when its source ranks the same or higher, `user` above `generated` above `provider` above `first-message`. The reference and the folder are stored together, once, when the provider's session first exists. *(M14b, C26, C55, C61:)* and which of the provider's instances runs it, stored at create and never changed, as its model is; and, in the same write as the reference, the configuration folder that instance had then, kept from then on. A change may set neither the instance nor the model. *(The session flags and the shelf:)* the star is one of three flags, each a boolean of its own — `starred`, `toDo`, `toVerify` — and `shelvedAt`, when the session was put on its project's shelf, is never set beside `completedAt`. A turn clears both times, in the same write as its start, and so do Unshelve and Restore; shelving a completed session clears its completion; Done clears every flag but the star. *(The speed tier; [0016](0016-model-presets.md):)* and `speed`, the speed tier its turns ask for — the id its model lists for one, or null for standard speed — stored at create and by a draft's change of preset beside the model and the effort, and changed after the start as the effort is.
5. **Never stored:** transcripts, message text other than the name, tool output, account identity, credentials, usage readings. *(M18, C27:)* `records.json` holds no conversation: what was said, and each turn's ends, are in the conversation store ([0019](0019-conversation-store.md)), and neither file is rebuilt from the other but by the reconciliation that decision describes. *(M22, C25:)* nor a chat's own mode, the mode a turn ran under, a request for leave, a decision or a grant: those are the conversation store's ([0027](0027-execution-permissions.md), item 23). Of what a session may do the file holds a project's default ids and nothing else, and a session's entry gained no field.
6. **Names** are clamped to **60 grapheme clusters for projects** and **160 for session titles**, whatever their source, after trimming, collapsing whitespace and removing control characters. A cut name ends with "…". The maintainer explicitly requested that widening the session title bound keep records version 6 unchanged, an exception to [0014](0014-format-compatibility-starts-at-first-release.md) for this change alone. *(M26, [0028](0028-secretary.md):)* the sources in use are three of four: `first-message`, the first prompt's first line; `generated`, a title the session's own account wrote from that prompt; and `user`, a name typed in the session's menu and saved by `sessions:rename`, which refuses one that is empty once normalized. A name replaces another of the same rank or lower, so a typed name is never replaced by a generated one. `provider` is not yet reported.
7. **Compatibility:** decision 0005's envelope (`schemaVersion`, `minReaderVersion`) from the first version, which writes 1 and 1. An older build that may read a newer file edits known fields and keeps every field it does not know. *(M14, C1:)* the file is at version 2, written 2 and 2, with `sessions` beside `projects`; a version-1 file is refused as older, with Start fresh, and no migration is written ([0014](0014-format-compatibility-starts-at-first-release.md)). *(M14b, C26:)* the file is at version 3, written 3 and 3, and a version-2 file is refused the same way. *(M18, C29:)* the file is at version 4, written 4 and 4, and a version-3 file is refused the same way. *(M22, C25:)* the file is at version 5, written 5 and 5, with `permissionModes` on a project, and a version-4 file is refused the same way. *(The session flags and the shelf:)* the file is at version 6, written 6 and 6, with `toDo`, `toVerify` and `shelvedAt` on a session, and a version-5 file is refused the same way. *(Project folds:)* the file is at version 7, written 7 and 7, with `collapsed` on each project; new projects are expanded, and a missing or invalid flag within the supported format reads as expanded. A version-6 file is refused unchanged with the existing recovery and no migration. Selecting a session expands its project before the selection, and creating one saves the expansion with it. Folding never closes the selected chat or changes whether the project is hidden. *(The speed tier:)* the file is at version 8, written 8 and 8, with `speed` on a session; an entry without one cannot be read, and a version-7 file is refused unchanged the same way, with no migration.
8. **Failure:** an unreadable, corrupt or newer-reader file is left byte-identical; the app shows no projects, refuses every change to records and says why. A missing file is a fresh start. *(M12, C61–C67:)* the note offers Start fresh, taken only after a confirmation whose default is Cancel: the file is renamed, unchanged, to `records.set-aside.<UTC date and time>.json` in the same folder — never deleted, never over an earlier copy — and the list starts empty. For a file that could not be opened it also offers Try again, which reads it once more. One unreadable project entry does not refuse the file: it keeps its place and its value through every write. *(M14, C3, C107:)* so does a session entry that cannot be read, or whose project cannot: it is shown nowhere and counted in the log. An entry no project's removal reaches is counted in a row at the foot of the project list, whose Remove deletes those entries after a confirmation.
9. **Deletion:** deleting a session removes its record. Deleting a project removes its sessions' records too, after a confirmation naming how many. The provider's threads and transcripts are never touched. *(M18, C21, C42:)* each removal takes the sessions' saved chats with it, and is refused while the conversation store is ([0019](0019-conversation-store.md), item 11). *(M14, C13, C96:)* a project's removal matches sessions on the ids the file stores, readable or not, and both removals are refused while a session runs.
10. **Atomic change:** a change to a project and its sessions is one write of the whole file. *(M14, C12, C14:)* each change to a session is one such write; what a session is doing lives in memory only and never writes.
11. **Access:** only the main process reads and writes records; the Main window asks through typed IPC channels. Logs and diagnostics may hold counts and error kinds, never names, paths or references. *(M12, C79, C80:)* the one exception is a development run (not packaged), whose IPC dispatcher logs the full error and the request's faults to the developer's own terminal.

12. **Session ordering (promotion on viewing removed).**

The session array is the durable display order for active, shelved and completed sessions. Each
project's three lists keep starred sessions first, and preserve saved order within each star group.
A drag, or Alt+Up/Down, moves a session within that group; accepted user work in
it puts it first there. Later work naturally displaces manual placements: there are no
numeric offsets or decay values.
Entering another lifecycle list places the session first in its destination group in the same
atomic write. A star-only change keeps the underlying saved position.

Accepted work includes sending or queueing a prompt (including Send now, a queued edit or an explicit
queue resume), answering or declining a question, deciding an approval or plan, explicitly stopping,
and sending an aside or review prompt. The receiving session is promoted: the parent for an aside,
the reviewer for a review submission, the target for integration.

Choosing a session — a capsule's press, Ctrl+Tab, a link to a chat or the mini window — preserves
its saved position (the maintainer). Ctrl+Tab keeps its own in-memory visit history,
across projects. After a pointer press on a capsule the list keeps its order on screen until the pointer
leaves it, so nothing moves under the pointer; a move made meanwhile saves the group as shown,
with the fewest moves. Reading, draft and note editing, finding marks, flag and setting changes,
background output and automatic queue delivery leave the order alone.

Shelf and completed capsules support the same pointer and keyboard moves as active capsules. A
move names its expected lifecycle and star group; main checks it against the latest queued state.
Cross-project and cross-group moves are refused. A visible page's end is before its hidden tail.
Failed explicit moves leave the previous saved order and report the existing change failure; a
failed automatic promotion logs only a generic failure and never changes an accepted action's result.

This reuses version 6's array without new fields, a migration or a historical re-sort. Activity,
shelving and completion timestamps retain their own meaning and are never fabricated for ordering.

**Opening a project folder.** Each folder row in Add/Edit project has **Open folder** beside **Remove**. Main-only `projects:openFolder` admits only a root saved on that project or returned by the native picker in this run, before any lookup. It checks that the path is still a directory and resolves it before handing it to the existing file-manager actions. A macOS bundle is revealed instead of launched, including through a symlink. Opening changes no draft, trust answer or stored record; a failure is shown beside the row, without native error text or paths in logs.

## Consequences

- M12 builds the store beside the preferences store, sharing the atomic writer and the envelope code.
- A session whose provider history was deleted elsewhere keeps its record; resuming fails, and the UI offers to remove it.
- The one write that starts at quit — the running turns ended as `stopped` (M14, C75) — is awaited in the shutdown's drain; a record left without an end reads the same at the next launch.
- Root paths, session names and, for a started session, its account's configuration folder path are personal data on disk; `PRIVACY.md` lists the file and how to delete it.

## Revisit when

- Records reach thousands of sessions, or need queries a whole-file read makes slow.
- fat-g starts storing other content (plans, reviews): that is a separate store with its own retention decision, as conversations have theirs ([0019](0019-conversation-store.md)).
- A second process needs to write records.

## Explicit full-data reset

[Decision 0038](0038-full-data-reset.md) adds a separate, twice-confirmed removal of all data in the current installation's data folder, followed by a normal quit and cleanup before the next startup. This explicit operation removes even unreadable files, backups, catalog overrides and user media; the ordinary read-only, retention and set-aside behavior in this record is unchanged outside that reset. No project or CLI folder is reached.
