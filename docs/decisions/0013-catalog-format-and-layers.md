# 0013 — The provider, model and effort catalog: JSON in three layers

> **Rule:** the catalog is JSON validated with Zod, merged from three layers: provider module defaults, the CLI's run-time model report (which defines the list when present), and a user override file that wins over both (`"hidden": true` hides a model). The model and effort *in force* are what a session reports, not the catalog's default.

- **Status:** Accepted by the maintainer, from M10 (C45, C46, C56), after discovery. Implemented in M13, and amended there: see [Amendments (M13)](#amendments-m13). Amended again for platform colours, for effort warnings, for speed tiers asked for, and for exact versions as keys.
- **Applies to:** the catalog contract (`src/shared/contracts/catalog.ts`), each provider module's `catalog-defaults.json`, the merge and the override reader (`src/main/catalog/`), the catalog service, discovery in the adapters, Settings' Models section.
- **Evidence:** models-and-effort.md (private research note).

## Context

- Both CLIs report their models without a turn: Claude in the `initialize` reply's `models`, Codex through `model/list`. Effort levels are per model on both.
- Neither CLI rejects an unknown model at session start; the first turn fails.
- The CLIs layer their own defaults: Codex's `isDefault` model is not what a session gets when the user's config names another.
- TOML would need a parser shipped with the app. A merge that only adds or overrides could never retire a model the vendor dropped.

## Decision

1. **Format:** JSON, validated with Zod, for the defaults, the catalog and the override file.
2. **Layers, in order:** (1) provider module defaults (effort labels, presentation such as the usage bar colour — and no model list, amended by M13, C75), so a new provider is a new module; (2) the CLI's run-time report, read with no turn over a connection the adapter already holds; (3) the user override file, `catalog.json` in the user data folder.
3. **The report defines the list** when there is one: a dropped model disappears, and an unknown reported model appears with what the report says of it (amended by M13, C11). Without a report, a provider lists no model, the override's included (amended by M13, C76, then C94).
4. **Effort levels** come from the report per model when present, otherwise from the defaults; the defaults supply labels and order.
5. **The override wins**: it adjusts any field, adds a model, or hides one with `"hidden": true`. An invalid override file is reported in Settings and ignored whole. Accounts shows its banner only when the file is ignored or skips unrecognized providers; Diagnostics always offers its status, path, Reload and Show data folder controls when the catalog has arrived.
6. **Run-time layer, per CLI** (Claude Code 2.1.268, codex-cli 0.155.1): both. Claude entries are keyed by `value` and record `resolvedModel`; Codex entries by `id`, with `hidden` carried.
7. **In force** means what the session reports (Claude `get_settings` → `applied`; Codex's `thread/start` reply and `thread/read`).

## Consequences

- M13 tests: merge rules; a dropped model disappears; an invalid override leaves the defaults working; a model missing from the catalog renders as a generic entry.
- A stale override fails only at the first turn, so the error belongs in the session, not at launch.
- Claude's fast mode reports `sdk_opt_in_required` to fat-g; offering it needs a supported opt-in ([0006](0006-no-agent-sdk-at-runtime.md)). the opt-in is a chat's own flag settings: see [the speed tiers' amendment](#amendment-speed-tiers-asked-for).

## Amendments (M13)

Settled by M13's spec sheet (private), by the items named:

- **C11 — an unknown reported model** carries the report's name, description and levels, not a generic entry. The generic entry is what a lookup answers for an id the catalog does not hold, and it is never added to the list (C48).
- **C75, C94 — no model list ships.** A module's defaults hold its look, whether a speed tier can be asked for, and its effort labels; the models come only from the user's own CLI, and without a report a provider lists none: the override adjusts and adds to a reported list only, so an entry that hides or renames a model never stands as a model of its own. C94 superseded M13's C76, which listed the override's models without a report. The maintainer: a distributed fat-g must not rely on what one machine's CLIs reported once. This also settles C13, which let the report's words win over a built-in list's: there is none.
- **C15 — an empty report is none.** A report with no model, or no row that can be read, never defines the list: one bad answer must not remove every model.
- **C35 — fat-g never writes the override.** It reads `catalog.json` and never creates, writes, renames or deletes it. The file therefore has no Start fresh; unknown-field preservation and atomic writes arrive with the first write path, an editor.
- **C39 — the override never reaches the look.** A provider's colour and mark stay its module's; a `presentation` field in the file is skipped like any unknown field.
- **C47 — lookup by resolved id prefers a model that is not the listed default**, then the first in list order: Claude's `default` row resolves to the same model as the row that names it.
- **C90 — Claude can be asked.** For an account whose usage read runs no session (signed out, API key, cloud provider), a models-only session reports: the usage session's launch, sending `initialize` alone, inside [0006](0006-no-agent-sdk-at-runtime.md)'s request set.
- **C92 — when to ask.** A read during which the models arrived asks nothing, as a subscription's Claude reads report by themselves; otherwise a provider that can be asked is asked after its runtime's first read, an account change, a Refresh's read, and once the last answer is an hour old. Supersedes M13's C69, which asked Codex alone.
- **C70 — effort order.** Levels are the report's when there is one, listed in the defaults' order; a level the defaults do not know follows the one it followed in the report, or comes first.
- **C91 — the report goes with the account.** When a usage read ends in another account state than the last (signed in, signed out, API key, cloud provider), a report taken before that read is dropped and a fresh one asked for; one that arrived during the read stays. Supersedes M13's C73, whose refusal of every report until a read ended with an account would have refused C90's.

## Amendment (platform colours)

- **A module's look is its colour, its mark and its stream.** `presentation` gained an optional `stream` — the ground a running status bar warms to, and the six tones its rectangles are drawn in — so each platform has a status bar of its own: Claude's orange ramp and Codex's blue one are each their module's, and `tokens.css` declares no provider's colour at all. A module that declares none leaves its running bar black with its word in white, as a provider this build does not have is drawn. C39 is unchanged in force and now covers the stream too: the user's override file still reaches none of it.

## Amendment (status glow images)

- A provider module may supply a status stream glow image, imported inline like its logo and checked against the same image kinds and size bound. Main adds it to the stream presentation; the renderer draws it through a CSS property with the existing additive motion. A stream without an image keeps its six tones. The images belong to their provider modules, so adding a provider needs no renderer change and emits no standalone renderer image.

## Amendment (effort warnings)

- **What a level costs, said where it is chosen.** A level may carry a `warning`, from its provider module's defaults alone — Claude's `max`, "Can use substantially more tokens and take longer."; Codex's `ultra`, "Automatically delegates tasks; can increase usage." — and a `description`, the CLI's own words where it reports any: Codex's `model/list` describes each level, and the report keeps a clean one by level as `effortDescriptions`; Claude's reports none. Both reach the catalog's level, through a relabelling and the override's own list, which can set neither.
- **Shown, never deciding.** Wherever a level is chosen or listed — the model picker, a session's effort menu, a preset's editor, Accounts' model table — one that warns carries a ⚠ beside its label (a native select's option too), says its warning and description on hover and to assistive technology, and once chosen says its warning in words under the choice. `caution` stays the one flag that keeps a level from being chosen for the user; a warning changes no automatic choice.

## Amendment (speed tiers asked for)

- **fat-g asks for a speed tier.** A session's preset carries one ([0016](0016-model-presets.md)), and main takes a tier only where the instance's catalog entry says it can be asked (`speedTierRequest.possible`, from the module's `canRequestSpeedTier`). Claude's module now says it can: a chat asks for fast mode through its own flag settings ([0020](0020-claude-chat-sessions.md)), which lift the `sdk_opt_in_required` block. The reason is kept as the CLI reports it, `sdk_opt_in_required` included while the idle session's fast mode is not on; it says why the CLI does not run fast by itself, and no longer that fat-g cannot ask. Codex's tiers are asked as service tiers ([0018](0018-codex-sessions.md)).
- **What a tier costs, said where it is chosen.** A tier may carry a `warning`, from its provider module alone, as a level does: Claude's `fast`, "Billed as extra usage, at a higher rate; with none left, turns run at standard speed." Codex's tiers carry none. The override names a tier's name and description, never its warning; a tier it names by id keeps the warning its module gave it.

## Amendment (exact versions as keys)

- **A key names one version.** A model's key is the exact version its row stands for, never an alias the CLI may point at another version: Claude's list names `fable`, `opus[1m]` and `default`, and its update to a newer CLI moved `fable` from `claude-fable-5-1` to `claude-fable-5-2` under every session, preset and recent that held it (models research §7 (private)). Claude's module keys a row by its `resolvedModel`, with the value's context mark (`[1m]`) where the resolved id leaves it out, so that a launch keeps the context the row offered; a row the CLI resolves to nothing keeps its value. Codex's ids are exact already. What stores and sends the key ([0016](0016-model-presets.md)) is unchanged: it now pins a version.
- **Rows naming one version are one model.** `default` beside the row it means, or an alias beside the version's own row, merge in the first one's place, in the words of the row that names the model; the merged model is the listed default where either row was. `listedDefault` is read from the `default` value, no longer from the key. Aliases are read in the module while mapping, and never leave it.
- **The override follows.** A `catalog.json` entry names a version by its key; one that names an alias matches no reported model, and is added as a model of its own ([catalog-override.md](../catalog-override.md)).

## Revisit when

- A vendor documents a model catalog API or changes the reported fields: re-run M10's discovery spike.
- Users need per-project catalogs.

## Explicit full-data reset

[Decision 0038](0038-full-data-reset.md) adds a separate, twice-confirmed removal of all data in the current installation's data folder, followed by a normal quit and cleanup before the next startup. This explicit operation removes even unreadable files, backups, catalog overrides and user media; the ordinary read-only, retention and set-aside behavior in this record is unchanged outside that reset. No project or CLI folder is reached.
