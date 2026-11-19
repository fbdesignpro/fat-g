# Stored-format baselines

One synthetic document of each format fat-g keeps in its own format, at the version a released build writes ([decision 0014](../../../docs/decisions/0014-format-compatibility-starts-at-first-release.md), item 4). `tests/baselines/baselines.test.ts` holds every build to them: each current version's file is what the build writes, byte for byte, and every file here, of this version or an earlier one, is read by the build as compatible, with its content.

| File | The format | Written by |
|---|---|---|
| `preferences-v<n>.json` | `preferences.json` | the preferences store, from a patch of every section |
| `records-v<n>.json` | `records.json` | the records store: two projects and three sessions |
| `conversations-v<n>.sql` | `conversations.sqlite` | the conversation store, dumped as SQL text: its settings, its schema and every row of a chat, an aside and a second chat |
| `plan-v<n>.json` | `plans/<id>/plan.json` | the plan record's writer: four versions and a workflow |
| `review-v<n>.json` | `plans/<id>/reviews/<id>.json` | the review record's writer: two rounds, marks and an integration |
| `family-v<n>.json` | `avatars/<family>/family.json` | the family editor's writer, after Add avatar |
| `catalog-v<n>.json` | `catalog.json` | by hand, every field of the user-written format |
| `provider-detection-v<n>.json` | `provider-detection.json` | the discovery history |
| `reset-on-next-start-v<n>.json` | `reset-on-next-start.json` | by hand, as the reset writes it, its random id fixed |

`tests/baselines/record.ts` makes them under a fixed clock and fixed ids, from invented names and paths: nothing here is anyone's data. To record a new version's file, run `do-record-baselines.bat` (elsewhere, `FATG_RECORD_BASELINES=1 npx vitest run tests/baselines/record.test.ts`): it writes each file this build has none of, and replaces none; `do-check.bat focused --area baselines` then runs the test. Until the first release a format's raise deletes the old version's file first. From the first release on, the old file stays, read by migration, and the new one joins it. A file here is never edited by hand: it is what a released build wrote.
