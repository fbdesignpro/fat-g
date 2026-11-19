# 0015 — fat-g never writes into a project's folders

> **Rule:** fat-g reads a project's folders and writes nothing into them, in M12 or later: no files of its own, no provider files such as `AGENTS.md` or `CLAUDE.md`, no settings. What fat-g must remember about a project — its trust answers, and later remembered permissions — is kept by fat-g, in its own data folder, or by the session, never in a project's settings files.

- **Status:** Accepted by the maintainer, from M12 (S8, C58, C59). Implemented in M12, which settled the roadmap's open point "Files written into a project".
- **Applies to:** everything fat-g does with a project's roots, from M12 on: the records store, the live slices (M15, M16), chat, and any later work that would configure a CLI for a project.

## Context

- A project's folders are the user's, often under version control and shared with others. A file fat-g left there would show up in their commits and in their colleagues' checkouts.
- Each CLI has its own project files (`AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.codex/`), with their own formats and their own rules. Writing them would couple fat-g to other programs' formats, and to every change the vendors make to them.
- Trust is the first thing fat-g must remember about a folder. Headless Claude skips its own trust check (projects research (private)), so fat-g asks itself, and keeps the answer in `records.json`, never in the CLIs' trust stores (M12, C34).

## Decision

1. fat-g creates, changes and deletes nothing under a project's roots: no file of its own, no provider file, no settings.
2. What fat-g remembers about a project lives in its data folder ([0011](0011-records-store.md)) or in the session's own state.
3. A later permission the user asks fat-g to remember — "always allow this tool here" — is kept by fat-g or by the session, never written into a project's settings files.
4. Files the agent writes during a session, under the CLI's own approvals, are the CLI's writes, not fat-g's.

## Consequences

- fat-g is a reader of existing projects: how a user sets up a CLI in a project stays between the user and that CLI.
- M12's tests prove it for records: the store writes only its own files in the data folder, and a search of the source finds no write elsewhere (M12, V14); every smoke run checks that its project folder is untouched.
- A feature that would configure a CLI for a project needs a new decision first.

## Revisit when

- Users ask for fat-g to set up a CLI in a project, and doing it through the CLI itself is not possible.
