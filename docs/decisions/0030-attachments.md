# 0030 — Attachments: images fat-g keeps by their hash, in its own folder

> **Rule:** an image the user pastes or drops into a chat's composer is fat-g's to keep, as a file of its own data folder, and the CLI's to send. A supported image the CLI returns is kept by the same store as an assistant message's attachment, without another generation or a read of the CLI's files.
>
> - **What is taken:** a PNG, JPEG, GIF or WebP, known by its first bytes and its header alone, never decoded: at most 5 MiB and 8,000 pixels a side each, ten and 20 MiB a message. A folder, a file that is no such image and anything past a bound is refused in words, and nothing of it is kept.
> - **Where it is kept:** `attachments/<sha-256 of its bytes>.<png|jpg|gif|webp>` in the data folder, written under a temporary name and renamed at the end; the same bytes are one file. An active file is never renamed, moved or rewritten, Start fresh's move of the whole folder with its store excepted.
> - **Who owns it:** the conversation store names each image by its hash, and each use of it — a draft's, a queued message's, a sent message's — as a row of its own. The last use going deletes the file, after the transaction that released it; a file no row names is swept at the next compatible open. A store fat-g cannot read keeps its folder untouched.
> - **How it is shown:** through `app://media/attachments/<hash>` alone — GET, a hash the open store names, a regular file whose size, hash and header are checked again, `nosniff`, no cache, no range — and only for the page's images; the CSP admits that origin for `img-src` alone. A path is never read from a request, and the Pet asks for none.
>   An agent's read or a file reference can also show an existing attachment through a file image's run id, delegated to this same source after matching its exact owned path (item 9).
> - **Explicit copy and reveal:** Copy reads verified attachment bytes by hash for transient PNG conversion in Chromium and the system clipboard alone; Show in folder reveals the owned stored file. Neither writes another file, accepts a path from the page, or grants the Pet access (item 8).
> - **How it is sent:** with its message, in the CLI's own form — Claude's base64 image block in the user frame, Codex's `localImage` input naming the file's path, which Codex reads and keeps in its own session files.
> - **What never holds it:** `records.json`, the app state, a log (kinds and counts alone), the Pet, a project's folders.

- **Status:** Accepted with M23's plan (milestone document (private), spec sheet (private); C1–C30, C81, C84, C85, C90), built from K1's and K2's traces (chat protocols §18 (private research note)). Implemented in M23; the maintainer's acceptance is the milestone document's to record.
- **Applies to:**
  - `src/shared/contracts/attachments.ts`, the bounds, signatures and words;
  - `src/main/attachments/` (blob files, sweep, the attachments' bound on the header reader), `src/main/images/headers.ts` (the one header reader, shared since M102, C50), `src/main/media/` (the route and its sources);
  - the conversation store's `blob`, `staged`, `draft` and `queue` tables and its attachment items (format 9), and its Start fresh generation with the marker `conversations.start-fresh.json`;
  - `attachments:stage`, the preload's bound on it, `chat:draft`'s removal, and the Storage section's count;
  - both adapters' prompt encoders, Codex's history matching of a `localImage` path;
  - the composer's strip, the message's images and the `image` tab kind; `PRIVACY.md`.

  Builds on [0004](0004-never-touch-credentials.md), [0014](0014-format-compatibility-starts-at-first-release.md), [0015](0015-no-writes-into-project-folders.md), [0019](0019-conversation-store.md), [0020](0020-claude-chat-sessions.md), [0021](0021-drawing-conversation-text.md) and [0022](0022-reading-project-files.md).

## Context

- **Both CLIs take images.** K1 saw Codex take `localImage` inputs under Read only, from a folder outside the working folder, at 5 MiB, and give the paths back in its history; K2 saw Claude take a base64 image block in the user frame, a 7 MB line included, with nothing of it coming back under the app's launch.
- **The user's image is conversation content, and a file.** A draft and a queued message outlive a restart, and a sent message's image is drawn again whenever its chat is: fat-g needs the bytes where it can serve them without reading anything the user did not hand it.
- **0021 loads no image.** A message's Markdown still loads none; an attachment is drawn by fat-g's own component from fat-g's own route, never from an address a text names.

## Decision

1. **Taken by header.** The page reads a file's first bytes to refuse what is no image before anything crosses; main checks the header again, with every bound, before a byte is kept. Dimensions come from the header; nothing is decoded or converted.
2. **Named by hash.** A file's name is its bytes' SHA-256 and its type's extension. Its display name — the dropped file's, cut to 100 units — is the use's, in the store, never the file's. Pasted images ignore the clipboard's placeholder filename and are named `Pasted image 1`, `Pasted image 2`, and so on within the session. Main allocates the next number above the labels in that session's draft, queue and sent messages while staging, and saves it in the existing display-name field: queueing, sending and restarting keep it, and repeated pastes of the same bytes have their own labels. Removing an unsent image removes its label too, so a later paste may reuse its number if no higher label remains; existing labels are never renumbered.
   A sent image's caption includes its display name and compact pixel dimensions, such as `Pasted image 1, 256x49`. One with metadata but no saved name displays `Image n`, by its position among its message's images, with those dimensions; missing metadata remains explicitly unavailable.
3. **Owned by rows.** A blob row per image; a use row per draft, queued message and sent message that names it. Each change that adds or drops a use is one transaction; a blob whose last use went is deleted after that transaction commits. A failure to delete leaves a file the next open sweeps.
4. **Unlinked, not overwritten.** A deleted image is unlinked: the system frees its space, and its bytes may remain on the disk until reused. `PRIVACY.md` says so.
5. **Served confined.** The route answers GET for a hash the open store names, from a regular file, with its size, hash and header checked again at each request; anything else is refused before a read, and a refusal is counted by its kind.
6. **Moved with its store.** Start fresh moves the store, its sidecars and its images' folder aside as one generation, under a marker that a crash leaves for the next start to finish. Removing a set-aside generation deletes its images' folder, then its sidecars, its store last; a removal cut short stays listed.
7. **Sent by the provider's own form.** Claude: base64 image blocks after the text block, built for the one frame and not kept. Codex: `localImage` with the file's path, which Codex reads; its history's paths are matched to a held image by the hash in their name, never read.
8. **Explicit artifact controls.** `attachments:readForCopy` returns transient bytes to the Main window only, by a known hash, through the media source's size, hash and header checks. Chromium decodes and converts them to PNG solely for the system clipboard, at natural dimensions; an animated image copies its first frame. No converted bytes are stored. `attachments:showInFolder` reveals only a main-resolved, existing regular attachment file inside the active store. Both requests take a hash and no path, and the Pet is refused. The media route and CSP stay confined as before; ingest and provider sends still perform no decode or conversion.
9. **An agent's read can name its input attachment.** When a file reference names an active stored attachment's exact direct path, main matches the hash and extension to the store and delegates to this same verified source. It may issue a file image's run id for the existing thumbnail, tab, Copy and Show in folder flows ([0022](0022-reading-project-files.md), item 15). The file is never opened through the general project-file reader, and no other app data is admitted. Ownership and the owned file's location are checked again after the asynchronous read; links and paths to another machine serve nothing. This reuses existing bytes and writes nothing.

## Consequences

**Generated images:** Codex's returned inline images reuse these same files and ownership rows, as attachments of assistant messages. Main validates the encoding and image bounds before publication, and the source's size/hash/header checks still run at display and Copy. The stable source identity prevents duplicate live/history results. Failures are notices; a removed conversation cannot be recreated by a delayed write. Nothing is read from `savedPath`, no extra request is made to obtain a resource, and nothing changes the CLI's permissions. See the implementation note (private) for the limits and the M25 scope still pending.

- An image survives a restart as long as a draft, a queue or a chat names it, and costs disk space until then; Settings → Storage counts the folder.
- Codex holds the image's path, which names the user's folder, in its own session files; that is disclosed and not hidden.
- A third provider takes images by declaring nothing: the prompt's attachments are a field of the provider kit's turn request, and an adapter sends them in its own form.

## Revisit when

- A CLI takes another media type, or a bound proves too tight for the maintainer's use.
- An image needs a transform (resize, strip metadata) before it is sent: that would be a decode, which this record rules out.
