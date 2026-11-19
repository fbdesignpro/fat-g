# 0034 — Local audio effects, one playback owner

> **Rule:** effects are local files in fat-g's own `audio/` data folder, seeded with shipped defaults without overwriting any existing file, chosen per event or disabled in preferences. Only the Main window plays audio; either window may request fixed UI cues. Session cues come from live accepted events and successful state transitions, never from snapshots or saved history. No recording, network or provider involvement.

- **Status:** Implemented at the maintainer's request.
- **Applies to:** audio storage, preferences, Settings, session effects, both windows, local media and packaging.

## Context

The multimedia DOM interface needs quiet feedback and session notifications, with user-controlled files and an independent Off choice for each event. The mini window must not receive personal filenames or the broader preferences projection.

## Decision

- Settings → Audio follows Avatars. Master mute, volume, thirteen event selectors in Actions and Notifications with Off and Preview, Open audio data folder and Rescan. Preview honors mute and volume; the original waveforms have restrained amplitude.
- Volume uses a square-law audio taper (`gain = (percent / 100)²`) for finer control at quiet levels, a simple perceptual approximation consistent with the rationale for [audio-tapered controls](https://learn.microsoft.com/en-us/windows/win32/coreaudio/audio-tapered-volume-controls). Preferences and playback retain linear gain, so an existing setting keeps its loudness and only its displayed percentage changes. The default gain is 0.1 (the former linear slider's 10%), displayed as 32% on the new curve; 0% is silence and 100% is full gain.
- Actions: rollover, turn start, Mark Done (including Clean up done), Shelve, Restore, click and right-click. Notifications: Ready, Question, Approval needed, Plan ready, Review ready and Error. Ready uses the existing `turnFinished` preference key and is emitted only when nothing else waits on the result. A question, plan or review uses its own notification instead. A turn finishes after any running sub-agents. A failed conversation, including a failed start or lost runtime, uses Error; a recovered tool error, an account refresh problem, a stopped or interrupted turn, a secretary or an aside produces no such notification. Manual operations sound only after an actual successful change; no-op or refused actions stay silent. Unshelve uses Restore. A dedicated action replaces the generic click.
- Defaults: rollover Off; Click uses `button.wav` (supplied as `Future_Button_23.wav`), Reply starts uses `Launch-1.mp3`, and Ready uses `notification-done.wav` (supplied as `Notification_processed_4a.wav`). Shelve uses `BagOpen.mp3`; Unshelve and Restore use `BagClose.mp3`, both from Medieval Fantasy 2 SFX Pack's Inventory folder. The other seven events retain their generated WAVs. Only the twelve selected files ship; the replaced generated WAVs are removed from the source assets. The generator rebuilds only the seven retained originals and leaves imported files and notices untouched. Existing saved selections remain unchanged.
- One main-process audio module takes injected filesystem capabilities, with no Electron or provider imports. At startup it creates `audio/` and copies missing default WAV and MP3 files and their notices from the program. Existing files stay untouched; deleting a default causes it to return at next startup. No user sound is edited or removed.
- Startup and Rescan inspect only immediate filenames and bounded files, not nested directories. WAV, MP3 and Ogg candidates need an audio signature and at most 5 MiB. Links and junctions are refused. A missing or invalid selection remains selected and silent; it never silently falls back.
- The scanner mints content-hash media IDs. The `audio` source of `app://media` serves only current IDs after rechecking the root, file, bound, hash and signature. It uses `no-store`. The source is permitted only for media loads, never fetch, image, script or navigation. Chromium decodes the audio inside the sandbox.
- Both windows use delegated DOM listeners. Pointer movement within one control does not repeat rollover; rollover is throttled to one cue per 100 ms. Text editing, selection, disabled controls and cancelled actions do not click. Right-click includes keyboard context-menu invocation.
- The mini window sends only `audio:ui` with rollover, click or right-click. Main resolves mute, volume and the selected filename, then sends `audio:play` to the Main window alone. `audio:list` and `audio:rescan` are main-only. No catalog, preferences or filenames reach the mini window.
- One Main-renderer HTML audio engine preloads selected effects within the event registry's bound and plays at most four at once. Notifications take priority over action effects, which take priority over rollover. Mute stops active playback. It works without focus, never loops, and drops missed cues rather than replaying them after reload. Original effects are deterministic, generated with the repository's own script and licensed under MIT.
- Preferences revision 19 added `audio.sounds`, filename or null per event, with leaf patches preserving unknown fields. Refused preferences silence audio. Revision 20 adds five notification keys, with no migration from revision 19 (0014). Audio folder failures do not block the rest of the application.

- Live callbacks report new accepted request cards, including nonblocking message cards; a card containing several questions sounds once. Sub-agent requests use the same mechanism. New actionable plan versions are deduplicated by plan/version across all participants, and review findings by review/round. Resolving, acknowledging, selecting, restoring and reading existing items stay silent. Deferred Ready is decided after the turn's result, and after its workers finish, so it never layers over a specific notification. Only opaque identities are held for deduplication in memory; none is saved.

## Consequences

Users can edit or add effects using their file manager, then Rescan. No watcher, importing file picker, recording, notification service or dependency is needed. The package audit checks the closed default asset set, its notices and exact bytes against the repository. An audio decoder failure is shown in Settings without exposing paths in logs.

## Revisit when

Long music, streaming media, native OS notifications or more window kinds require a different playback lifecycle.
