# 0005 — Preferences compatibility preserves user intent across versions

> **Rule:** preferences carry `schemaVersion` and `minReaderVersion`. A file that is unreadable, corrupt or needs a newer reader is left untouched, providers stay blocked, and the app says why — until the user chooses **Start fresh** and confirms it, which moves the file aside unchanged and never deletes it. Edits change known fields only and keep unknown ones. Before the first public release, format changes need no migration ([0014](0014-format-compatibility-starts-at-first-release.md)).

- **Status:** Accepted and implemented in Phase 1 M6. "When this applies" folded in from [decision 0014](0014-format-compatibility-starts-at-first-release.md), accepted. Amended by M12 (C64, C65, C81): Start fresh and Try again, below. Amended by M22 (C25, C40; [0027](0027-execution-permissions.md)): the file is at revision 6, for a provider's default mode, below. Amended by M103 (C1–C8, C33; [0031](0031-avatars.md)): the file is at revision 9, for the avatar assigned to each model, below. Amended by M104 (C24, C25): a patch of that section sets several models of one provider in one write, the revision unchanged. Amended ([0031](0031-avatars.md), [0032](0032-avatar-overlay.md)): the file is at revision 14, for each provider's active family and the avatar overlay, below; then at revision 15, the overlay's preferences removed, the families' files the one source of an avatar's look, below. Amended ([0010](0010-pet-deferred.md)): the Pet's size, then the attention flash, added at revision 16 without a raise, at the maintainer's choice, below.
- **Applies to:** preferences storage, migrations, provider admission, Settings and compatibility tests

## Context

M3 protects an unreadable or newer preferences file from writes, but uses defaults in memory. Without the M6 admission gate, the resulting empty provider map would be interpreted as enabled with automatic executable discovery. A provider the user disabled could therefore start, while read-only Settings prevents disabling it again.

M3 also discards unknown JSON fields when constructing its typed preferences. Adding optional fields without changing `schemaVersion` is currently permitted, but an older build's next write would remove those fields. Safe downgrade support needs a contract for both interpreting existing settings and preserving settings an older build does not understand.

## Decision

**Guarantee:** Within a compatible preferences format, upgrades and downgrades preserve recognized settings and unknown fields. When compatibility cannot be established, the app preserves the file and does not start providers based on fallback settings.

### When this applies

- **Before the first public release**, a format change needs no migration and no compatibility analysis: it raises `schemaVersion` and sets `minReaderVersion` to the same value, so other builds refuse the file. The envelope, the refusal rules, provider blocking and unknown-field preservation below still apply in full ([0014](0014-format-compatibility-starts-at-first-release.md)).
- **From the first public release on**, everything in this record applies, including migrations from the released baseline. The baseline is the preferences file in `tests/fixtures/baselines/`, recorded for the first release, 0.9.1 ([0014, Baselines](0014-format-compatibility-starts-at-first-release.md#baselines-091)), which the baseline test proves every build reads.

### Version envelope and rollout

- Keep `schemaVersion` as the document's format revision. Add `minReaderVersion`, the minimum preferences implementation that may safely **read and edit known fields** in this document. These are positive integer format versions, not application release numbers or the in-memory IPC `rev` counter.
- The first implementation of this contract writes `schemaVersion: 2, minReaderVersion: 2`. M3-era readers already refuse schema 2, protecting new documents from their unknown-field stripping. This does not make those old binaries honor M6's provider-admission policy; the guarantee begins with contract-aware readers.
- A valid legacy schema-1 document without `minReaderVersion` has one explicit migration to revision 2. Inspect provider control values before applying defaults; migration must not turn an invalid control into permission to launch. Preserve unknown fields during migration. Missing compatibility metadata on any other revision is not an invitation to guess.
- Validate the envelope before interpreting settings: `1 <= minReaderVersion <= schemaVersion`. A contract-aware reader may accept a newer revision when its supported preferences version is at least `minReaderVersion`. Otherwise leave the file read-only and block provider startup.
- Compatible edits to a newer document retain its `schemaVersion` and `minReaderVersion`; never stamp an older reader's version onto it or lower its compatibility requirement. Migrate older revisions through supported, explicit steps. A missing/failed migration preserves the original and blocks providers rather than silently creating fresh defaults.

For example, a future revision-3 document with `minReaderVersion: 2` can be edited by reader 2 without losing revision-3 preferences. A document with `minReaderVersion: 3` cannot. Revisions 3 here are illustrative, not an additional M6 migration.

**Revision 6 (M22, C25, C40).** The file is written 6 and 6. A provider's entry may hold `permissionMode`: the id of the user's default mode for that provider's new chats, or null for none chosen, which is the provider's fallback ([0027](0027-execution-permissions.md), item 7). It is saved from Settings by a patch of that one known field, as any preference is, and reaches no running session and no chat that exists. It is a default's id and nothing else: no chat's mode, no turn, no request, no decision and no grant is in the preferences. A value that is no mode's id at all reads as none chosen and blocks nothing; whether the provider still lists the id is asked when a chat's mode is resolved, never when the file is read. A revision-5 file is refused as incompatible, left unchanged, with Start fresh, and no migration is written ([0014](0014-format-compatibility-starts-at-first-release.md)).

**Revision 7 (M26; [0028](0028-secretary.md)).** The file is written 7 and 7. A `titles` section holds `generated`, whether a new session's title is asked of the secretary (true by default), and `models`, by provider id the catalog key of the model the user chose to write it, an entry that is no key at all being dropped as it is read. A patch sets one provider's model or clears it with null, for a registered provider alone, and the rest of the section the file holds stays as it was. Neither field reaches a running session.

**Revision 9 (M103; [0031](0031-avatars.md)).** The file is written 9 and 9. An `avatars` section holds `assignments`: by provider id, then by model key, an avatar reference — `{ "origin": "built-in" | "user", "family": "<Family>", "avatar": "<Avatar>" }`, its root's origin and its two folders' names as listed, each at most 255 characters, the key bounded as a catalog key is. As the file is read, an entry for a provider this build does not register, one whose key is no catalog id or whose value is not of that form, and a second entry referring to an avatar an earlier one refers to — in the provider registry's order, then the keys' code-unit order — are dropped from what is used, the file unchanged and nothing reported; a hand edit that breaks one entry loses that entry's effect alone. A patch sets or clears one provider's one or more models' references, no avatar twice, for a registered provider alone, each settled in the one write in the order given: setting moves a reference another model holds, that entry cleared in the same write, and settles the avatar's dropped duplicates with it, as a clear settles those of the avatar the model held; the rest of the section, unregistered providers' entries and unknown fields stay as the file holds them. Nothing of it reaches a running session, and nothing but a patch and Start fresh changes it. A revision-8 file is refused as incompatible, left unchanged, with Start fresh, and no migration is written ([0014](0014-format-compatibility-starts-at-first-release.md)).

**Revision 10 (chat speaker bars).** Both version numbers are 10. `chat.username` is a nullable local display name, normalized by the shared name rule to at most 60 grapheme clusters; missing, invalid or empty names display as “You”. Settings → General saves or clears it through `prefs:patch`. It labels existing as well as new messages without changing their stored text, and is never sent to a CLI, a log or the Pet. `chat.messageTimes` stays optional; `chat.elapsed` is retired because speaker bars always show total turn time. Revision-9 files are refused unchanged, with the existing Start fresh recovery and no migration. Unknown fields remain preserved on compatible edits.

**Revision 11 (named presets).** Both version numbers are 11. `presets` is a record by UUID of `{ name, providerId, instanceId, model, effort }`: the name follows the shared 60-grapheme name rule, the selection is decision [0016](0016-model-presets.md)'s four fields. Settings → Presets creates, edits and deletes entries through `prefs:patch`; a complete selection sets one entry, preserving its unknown fields, and null explicitly removes it. Unrelated entries, including malformed entries and those for unknown providers, remain in the retained document. Malformed entries have no effect in the normalized projection, and unknown fields never cross IPC. Availability is checked against the live account and catalog alone; a missing account, hidden or unlisted model or unsupported effort never changes or removes the selection. The new-chat screen consumes this list from revision 12. Revision-10 files are refused unchanged with the existing Start fresh recovery and no migration.

**Revision 12 (new-chat preset recency).** Both version numbers are 12, with no migration from revision 11. `presetRecency` holds only saved preset IDs, in global most-recently-used order across projects and restarts. A successful capsule selection sends one `usePreset` ID in `prefs:patch`; main merges it into its current order, deduplicating and pruning deleted entries. Manual picker choices do not touch this order. Never-used presets follow in saved-list order. Deleting a preset removes its recency entry in the same patch. Unknown-field preservation and refusal of incompatible documents remain unchanged. Neither the initial-screen flag nor a saved-preset identity is written into a session record.

**Revision 13 (recent models).** Both version numbers are 13, with no migration from revision 12. `recentModels` is an ordered list of at most twelve distinct `{ providerId, instanceId, model, effort }` selections used by accepted provider-bound prompts ([0016](0016-model-presets.md)). Only main's `noteModelUse` operation merges one use; the renderer cannot patch this field. Each valid entry is projected with its four known fields alone, duplicate entries are ignored, and malformed entries have no effect. Compatible writes preserve unknown fields on retained selections and unrelated malformed entries. The history begins empty, survives session removal and restart, and contains no conversation content or account identity. Revision-12 files are refused unchanged with the existing Start fresh recovery.

**Revision 14 (active families and the avatar overlay; [0031](0031-avatars.md), [0032](0032-avatar-overlay.md)).** Both version numbers are 14, with no migration from revision 13. The `avatars` section gains `active`, by provider id the family `{ "origin", "family" }` whose match entries a model with no override is searched in, and `overlay`: `enabled` (true by default), `families`, by `<origin>/<family>` the user's style for that family, and `models`, by provider id then by CLI key or version id the user's style and labels for that model. As the file is read, an active family or a model's entry of a provider this build does not register, an entry not of its form and a style field not of its form are dropped from what is used, the file unchanged; the rest of the section and unknown fields stay as the file holds them. One avatar may now be several models' override: the read pass drops no second reference, and a patch sets or clears one key without touching another model's. A patch sets or, with null, removes an active family, a family's style or a model's own, for registered providers alone, each value checked whole against its form; Settings' Reset sends null. Nothing of it reaches a running session. Revision-13 files are refused unchanged with the existing Start fresh recovery.

**Revision 15 (the look in the families' files; [0031](0031-avatars.md), [0032](0032-avatar-overlay.md)).** Both version numbers are 15, with no migration from revision 14. The `avatars` section holds `assignments` and `active` alone: the overlay's switch, the user's styles of a family or a model and a model's labels are gone, since an avatar's look is its family's `family.json`, edited in Settings → Avatars' family editor. An `overlay` a file still holds is an unknown field: kept as the file holds it, never read. A patch naming `overlay` is refused whole. Revision-14 files are refused unchanged with the existing Start fresh recovery.

**Still revision 16: the Pet's size ([0010](0010-pet-deferred.md); the maintainer's choice).** `windows.pet.size`, `capsule` or `compact`, is the size the Pet draws its capsules at, set by the Pet's toggle through `pet:setSize`, which main patches. It was added without raising either number, at the maintainer's choice, as an exception to [0014](0014-format-compatibility-starts-at-first-release.md): it is optional both ways — a build before it keeps it as an unknown field, and a file without it, or with a value this build does not know, reads as `compact` — so a raise would have bought only a Start fresh.

**Still revision 16: the attention flash ([0010](0010-pet-deferred.md); the maintainer's choice for the Pet's size, applied again).** `appearance.flash` holds `enabled`, `speed` (`slow`, `medium` or `fast`: two, four or six flashes a second) and `seconds` (1, 2, 3, 5 or 10): whether a session's status bar flashes when it turns to an attention, how fast and for how long, set in Settings → Appearance. Optional both ways, as the Pet's size is: a file without it flashes fast for 3 seconds, a field of a value this build does not know reads as its default alone, and unknown fields in and beside it are kept. Main carries it in the app state to both windows; the Pet still reads no preferences.

**Revision 17:** `chat.answerTimes` controls the start and end time below model answers, on by default; Copy remains available when it is off. Both envelope numbers are 17, with no migration from revision 16.

**Revision 18:** `appearance.doneAnimation` selects no animation, animation and flash (the default), or animation only. Both envelope numbers are 18, with no migration from revision 17.

**Revision 19 ([0034](0034-audio-effects.md)):** `audio.sounds` maps each of the eight event keys to a filename in fat-g's audio data folder, or null for Off. The existing `muted` and `volume` remain. A patch changes individual event entries while preserving unknown audio and mapping fields. Both envelope numbers are 19, with no migration from revision 18. Audio stays silent while preferences are refused.

**Revision 20 ([0034](0034-audio-effects.md)):** five notification keys join `audio.sounds`: `question`, `approval`, `planReady`, `reviewReady` and `error`. The existing `turnFinished` key now means Ready, an ordinary successful turn with nothing else waiting. Manual Mark Done keeps `done`. Both envelope numbers are 20, with no migration from revision 19. Unknown audio fields and event mappings remain preserved on compatible edits.

**Revision 21 ([0010](0010-pet-deferred.md)):** `windows.pet.autoHideOnMainFocus` hides an enabled Pet while the Main window has focus, true by default. Settings shows it indented beneath Show the mini window, disabled while the parent is off. Main applies the choice at once and on focus changes; automatic hiding never changes `windows.pet.visible`, and showing again never takes focus. Both envelope numbers are 21, with no migration from revision 20; older files remain untouched with the existing Start fresh recovery. Unknown window fields remain preserved on compatible edits.

**Revision 22:** `appearance.creationAnimation` selects the entrance a new chat's chat window plays at its first send, Wipe by default or None. Both envelope numbers are 22, with no migration from revision 21.

### What makes a change compatible

- Existing keys retain their meaning, type, units and missing-value semantics. Never reuse a key for a different purpose or reinterpret an explicit `false`.
- Adding an optional field can be compatible if older readers safely ignore it and their edits cannot violate the new document's invariants. Increment the format revision; leave the minimum reader unchanged only when those conditions hold.
- Renaming/removing/reinterpreting a setting, changing a behaviorally significant default, or adding a control that older readers must enforce requires a migration and an increased minimum reader. Merely having an unfamiliar field is not proof that ignoring it is safe.
- A new privacy or provider restriction cannot be marked optional-compatible if an older reader would launch something the restriction prohibits. The minimum reader covers safe writes and cross-field constraints as well as parsing.

### Storage and public projection

- Main retains the parsed persisted document privately, separately from the normalized, known preferences used by application code and exposed through Main-only preferences IPC. Unknown keys, including keys nested in known sections and provider entries, never enter renderer snapshots, diagnostic logs or provider arguments.
- Apply validated patches to the specific known fields being changed in the retained document; do not reconstruct the entire file from the normalized schema. Preserve unrelated fields, unknown provider IDs, nested unknown fields and compatibility metadata. Arrays/objects belonging to a changed known field follow that field's documented replacement semantics.
- Unknown data is preserved as JSON values, not interpreted or executed. Preservation is semantic; whitespace and key order need not be identical after a permitted write. For refused writes, the original bytes stay unchanged.
- Cosmetic defaults/clamps may be used in the normalized view without replacing unrelated stored values. Invalid provider controls remain visibly invalid until explicitly repaired; saving window bounds or audio must not silently repair them into enabled/automatic defaults.
- Keep the existing strict IPC patch allowlist, serialized atomic writes, debounce and final `will-quit` flush. Normalization and every write path, including migrations and synchronous flush, must follow this contract. The application still persists only preferences, never account data, credentials or CLI output (decision 0004).

### Missing, invalid and unavailable preferences

| Condition | Settings and persistence | Provider admission |
|---|---|---|
| File genuinely absent on first load | Initialize the current format with defaults | Existing default-enable policy applies |
| Compatible document, including a newer additive revision | Use known validated settings; preserve unknown fields on edits | Honor valid enabled/path controls; genuine missing controls use the stable documented defaults |
| Malformed existing `enabled` or `executablePath` value for one provider | Preserve the invalid value; allow explicit repair through known-field patches | Block that provider; never turn a malformed override into automatic discovery |
| Invalid whole provider section | Preserve it; show a repair requirement | Block all providers until repaired |
| Unreadable, incompatible, corrupt envelope/JSON or failed migration | Preserve the original in place, refuse writes, show recovery guidance, offer Start fresh (and Try again when unreadable) | Block all providers; no context, PATH probe, version probe, child or polling |

Malformed here means a value the preferences schema cannot accept (such as `enabled: "false"` or `executablePath: 42`), not a well-typed path whose target cannot be resolved. A preserved path string still goes through the resolver and reports `not-installed { overrideInvalid }` with no fallback when unsuitable or missing, as in decision 0003.

An unavailable file is not equivalent to an absent file. Do not rename it away and auto-save defaults: that would make a later launch treat the lost settings as a fresh installation. An optional backup copy does not authorize replacing the original.

**Start fresh and Try again (M12, C64, C65, C81).** The in-app reset M6 deferred is Settings' note for a refused file. It says the file is unchanged, why it was refused, and the remedy that keeps it: update fat-g, use the earlier version that wrote it, undo a hand edit, or wait for the program holding it. It then offers:

- **Start fresh**, only after a confirmation whose default is Cancel. The file is renamed, unchanged, to `preferences.set-aside.<UTC date and time>.json` in the same folder — never deleted, and never over an earlier copy. The defaults then apply as on a first run, and the providers go back to their default switches. A failed rename changes nothing, and the note says so.
- **Try again**, for a file that could not be opened. It is read once more; a file that reads now is loaded, and the providers are admitted by its switches.

Nothing happens to a refused file without one of these choices.

Provider eligibility must be determined from validated persisted controls and load status before defaults obscure their provenance. A valid explicit disable always prevents startup, even when another control is invalid. Publish a safe `blocked` provider status with a fixed preference-related reason when settings prevent an eligibility decision; do not label that provider as user-disabled. Refresh and redetect cannot bypass the gate. Executable selection is refused for unavailable documents; in a compatible document it may explicitly repair an invalid path, without enabling a disabled provider or silently repairing an invalid enabled flag. The app can still open its windows using safe presentation defaults, with email masking enabled.

### Required evidence

- A reader-2 fixture accepts a revision-3/minimum-2 document, edits a known leaf, and a reader-3 fixture receives all newer fields unchanged. Cover nested provider fields, unknown provider IDs, arrays, synchronous flush and debounced writes.
- Explicit provider disable and executable override values survive upgrade → downgrade → edit → upgrade. Version metadata never regresses; revision-3/minimum-3 and invalid envelopes are refused unchanged.
- Legacy revision 1 migrates to revision 2 without losing unknown fields. Test missing/failed migration and invalid provider controls before normalization.
- Unreadable, incompatible and corrupt inputs launch no processes, including through refresh/redetect actions. Restarting after refusal still blocks providers. Unrelated setting writes cannot erase invalid-control evidence; explicit valid repair can restore eligibility.
- Known safe missing values still default correctly, cosmetic corruption remains contained, and unknown persisted data never reaches preferences IPC, app-state/Pet projections, logs or process inputs.

## Consequences

- M6 extends preferences storage and validation before wiring live providers; a raw-document store and normalized view replace M3's single-schema round trip.
- M3's milestone document remains a historical account of shipped behavior. The automatic corruption recovery, blanket newer-version refusal and unknown-field stripping described there were superseded when this decision landed in M6.
- This is not a promise that arbitrary future formats work in any old release. Compatibility is explicit, and a downgrade below the declared minimum requires a compatible build or deliberate user recovery.

## Revisit when

- Preferences gain multiple concurrent writers, external live editing, import/reset UI or independently versioned plugin-owned sections.
- A format change cannot preserve the envelope or cannot express safe editing with one minimum-reader requirement.

## Hover message times, still revision 22

At the maintainer's explicit request, `chat.hoverMessageTimes` is an additive setting at revision 22: both version numbers stay 22. When absent, it reads as `true`; an explicit `false` survives writes and restarts. Reading an existing file does not write the default into it, and unrelated patches do not insert it. Earlier revision-22 readers ignore the setting and preserve it as an unknown field. This is a scoped exception to [0014](0014-format-compatibility-starts-at-first-release.md), following the revision-16 additions above, with no migration or compatibility shim.

The setting shows a user or assistant message's existing timestamp beside its hovered block in the main chat's left margin, without changing the text column. It shares Copy's and the paragraph controls' CSS reveal states. The gutter hides times that overlap the session's corner controls and clips at narrow widths. Inline message times and model answer footer times remain independent. It stores only this boolean, never a timestamp or conversation content.

## Revision 23: automatic naming models

An absent provider entry in `titles.models` means Latest small model. The reserved value `$session` explicitly selects the session's model; a catalog key still fixes a model. Both version-envelope fields are 23 so older readers cannot interpret the reserved choice as a model key. Earlier development formats are refused unchanged, with no migration, under decision 0014. Unknown-field preservation is unchanged.

## Automatic installation discovery

[Decision 0037](0037-provider-discovery.md) adds metadata-only discovery at launch and on Main focus. It preserves saved switches, blocks all discovery for unavailable preferences, permits passive installation checks of manually disabled providers without starting their CLIs, and makes missing providers inactive across their accounts without interrupting running work. Account folders and credentials are never searched.

## Explicit full-data reset

[Decision 0038](0038-full-data-reset.md) adds a separate, twice-confirmed removal of all data in the current installation's data folder, followed by a normal quit and cleanup before the next startup. This explicit operation removes even unreadable files, backups, catalog overrides and user media; the ordinary read-only, retention and set-aside behavior in this record is unchanged outside that reset. No project or CLI folder is reached.
