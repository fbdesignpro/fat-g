# 0038 - Twice-confirmed full-data reset on the next start

> **Rule:** Diagnostics shows this installation's exact data folder and asks two confirmations before writing a durable full-reset request and quitting through the normal work drain. The next launch, holding its single-instance lock, clears that folder synchronously before any profile, store or provider opens. Links are not followed; a partial failure retains the request and blocks startup until cleanup succeeds.

- **Status:** Implemented from the maintainer's explicit choice of all data and quitting.
- **Applies to:** startup, shutdown, Diagnostics, Main-only IPC and every file in fat-g's current data folder. Amends the ordinary preserve/set-aside rules of 0005, 0011 and 0019, and the ordinary read-only/user-media rules of 0013 and 0031, only for this explicit full reset.

## Context

Troubleshooting and first-install checks need a complete clean start. Resetting only preferences leaves projects, conversations, provider discovery history, overrides, custom media and browser zoom behind. Deleting live data would race stores, subprocesses and Chromium. A retained request permits cleanup only after the previous instance has exited and makes interrupted removal resumable.

## Decision

1. Diagnostics offers Reset all data, with two separate native DOM confirmations defaulting to Cancel. Both disclose the scope and exact folder. The second states that running work stops, fat-g quits now, deletion happens next start, and no backup is kept. No request is written after cancellation at either question.
2. Main owns the folder and accepts no path or file list over IPC. Data-folder information and the reset action are Main-only; the mini window receives neither. Once the request is flushed, a confirmed quit skips a third question but still performs normal draft flushing, turn stopping, process cleanup and store closure.
3. `reset-on-next-start.json` holds both envelope versions 1, scope `all`, and an opaque request id. It is created exclusively, without following a planted link or replacing an unreadable/incompatible request. Compatible future metadata is left unchanged while the existing request is reused. No preferences format change or migration is needed.
4. Reset executes synchronously immediately after the single-instance lock, before yielding to Electron startup. This keeps Electron from opening the old profile during removal. The data root itself and live SingletonLock, SingletonCookie, SingletonSocket and Windows lockfile entries are preserved, maintaining the single-instance lock throughout.
5. The entire current data folder is cleared, including settings, project/session lists, conversations, drafts/queues, plans, images, user avatars/audio, catalog overrides, backups, discovery history and browser caches/zoom. A linked root, path escape or changed identity is refused. Descendant symlinks/junctions are unlinked without following them. Conversation SQLite files and sidecars are overwritten before unlinking when they have no outside hard links; a linked copy is only unlinked to preserve the outside file.
6. The marker is removed last. A failure preserves it and remaining data and exits before opening any store or provider; a later launch retries idempotently. Malformed, oversized, linked, hard-linked or incompatible markers erase nothing and are left unchanged.
7. Project folders and provider configuration/login/history are outside this operation. Other installed/dev data folders and saved screenshot setups outside the displayed folder remain. Bundled program files and artwork are untouched. The next successful launch begins with defaults and initial automatic provider detection.

## Consequences

The existing per-store Start fresh operations still preserve their backups. Only this separately confirmed bulk removal deletes unreadable stores, catalog overrides and user media. Ordinary retention, no-project-write and no-credential-access rules remain in force. No network request, login or provider-specific reset is introduced.

## Revisit when

The product supports an external data root, distributed writers, or data held outside the installation's displayed data folder.
