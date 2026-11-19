# 0014 — Stored formats: no backward compatibility before the first release, full scaffolding from the start

> **Rule:** until the first public release, a stored format (preferences, records, the conversation store, the catalog override) may change without migrations: the change raises `schemaVersion` and `minReaderVersion` together, so other builds refuse the file. The envelope, the refusal of incompatible files and unknown-field preservation are complete and tested from each format's first version. Each format's baseline is recorded in `tests/fixtures/baselines/`, and a test proves every build reads it: until the release tag a raise re-records the baseline; from the tag on decision 0005 applies in full, and a raise adds a migration and a new baseline, the old kept.

- **Status:** Accepted by the maintainer, from M10 round 2 (C72–C74). M18, put the conversation store among the formats (C8, C36). Amended, preparing the 0.9.0 release: item 4 carried out — the baselines, below.
- **Applies to:** every file fat-g stores in its own format. **Amends [0005](0005-preferences-compatibility.md) and [0011](0011-records-store.md).**

## Context

- One developer, and formats that will keep changing through M11–M17: a migration per change would be work thrown away. No user's file is at stake before a release, and development runs keep their data in `fat-g-dev` ([0007](0007-packaged-build-contents.md)).
- Once fat-g ships, users' files must survive every update, and compatibility machinery bolted on late is where data loss hides.

## Decision

1. **The first public release** is the first build given to anyone other than the maintainer.
2. **Complete from the first version, pre-release included:** the version envelope; refusal of a file that needs a newer reader, or is unreadable or corrupt (left byte-identical, the reason shown, decision 0005's safety rules kept); edits that keep unknown fields; atomic writes.
3. **Pre-release:** a format change raises `schemaVersion` and sets `minReaderVersion` to the same value, with no migration and no compatibility analysis. The developer deletes the refused file (a development-only reset command may come with M11 or M12). No test proves an older pre-release format still loads.
4. **At the first public release:** each format's shipped version becomes its baseline, with a committed fixture file. From then on every build reads every baseline, by migration where needed, and a test proves it.
5. **Existing migration code stays** (preferences revision 1 → 2).
6. **The conversation store** *(M18, C8, C36–C39)* is one of these formats, and a database, not a JSON file: its envelope is SQLite's application id, which marks the file as fat-g's, and the two version numbers in the one row of its `meta` table. Item 2 holds for it as SQLite has it — the versions read on a read-only connection, a refused store left byte-identical in its main file and its log, a table, a column or a JSON key this build does not know left as it is — and item 3 too: a change raises both numbers, and an earlier store is refused as older ([0019](0019-conversation-store.md)).

### Maintainer-authorized exception: hover message times

The optional `chat.hoverMessageTimes` preference stays at revision 22 at the maintainer's explicit request, with an absent value defaulting to `true`. It requires no migration, reset or rewrite on read; older revision-22 builds preserve it as an unknown field. [0005](0005-preferences-compatibility.md#hover-message-times-still-revision-22) records the behavior and checks. This exception does not change the general pre-release versioning rule.

### Baselines (0.9.1)

Item 4, carried out for the first release, then numbered 0.9.0; the maintainer released it as 0.9.1, and the baselines are unchanged. [`tests/fixtures/baselines/`](../../tests/fixtures/baselines/README.md) holds one synthetic document of each format, named for its version (`preferences-v23.json`), recorded through the real writer under a fixed clock and fixed ids by `tests/baselines/record.ts` (`do-record-baselines.bat`, which writes the files the build has none of and replaces none); the conversation store as SQL text — its settings, its schema and its rows — since its bytes are SQLite's to arrange. `tests/baselines/baselines.test.ts` holds every build to them: a file is there for each format at the version the build writes, and nothing else; each current version's file is what the build writes, byte for byte; and every file, of the current version or an earlier one, is read by the current reader as compatible, with its content. The folder is the authority on which versions are recorded; at the recording they were: preferences 23, records 8, the conversation store 13, plans 3, reviews 2, families 7, the catalog 1, provider detection 1 and the reset marker 1.

- **Until the release tag,** item 3 holds: a raise deletes the old version's file and records the new one, with no migration, and the test fails until it has.
- **From the tag on,** item 3 is closed: a raise keeps the old file, adds the migration that reads it, and records the new version's file beside it; the test fails until both are there, and from then on fails any build that stops reading an old one.
- A baseline is never edited by hand: it is what a build wrote.

## Consequences

- M11–M13 reshape formats freely: a version bump and a line in the milestone document.
- The developer's own data files will sometimes be refused after an update; the refusal message says what to do.
- Agents write no migrations for pre-release formats, and skip none of the scaffolding.

## Revisit when

- The 0.9.1 release is tagged: item 3 closes with it, as the Baselines section says, and the files recorded for it are the ones every later build reads. Item 4 was carried out.
- Someone other than the maintainer relies on pre-release builds keeping their data.
