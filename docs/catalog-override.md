# Adjusting the model lists: `catalog.json`

fat-g lists each provider's models, their effort levels and their speed tiers in **Settings → Accounts**, under each provider. The list is the one your own CLI reports while fat-g runs: fat-g ships no list of its own, so until the CLI has reported — the provider disabled, or its CLI not found or not answering — a provider lists no model. A CLI that is not signed in still reports: Claude through a short session that asks only for its models. A file of your own, `catalog.json`, can adjust that list: rename a model, describe it, hide it, show one the CLI hides, or add one. It applies to a list the CLI has reported, so until then a provider lists nothing, the file's models included.

fat-g only reads this file. It never creates, changes, renames or deletes it.

## Where it goes

In fat-g's data folder, beside `preferences.json`. **Show data folder**, in Settings → Diagnostics, opens it, and the note beside it shows the file's full path.

| System | File |
|---|---|
| Windows | `%APPDATA%\fat-g\catalog.json` |
| macOS | `~/Library/Application Support/fat-g/catalog.json` |
| Linux | `~/.config/fat-g/catalog.json` |

A development run (`npm run dev`) reads `fat-g-dev` instead of `fat-g`.

fat-g reads the file when it starts and when you choose **Reload** in Settings → Diagnostics. It does not watch the file: after an edit, choose Reload.

## The format

```json
{
  "schemaVersion": 1,
  "minReaderVersion": 1,
  "providers": {
    "codex": {
      "efforts": {
        "xhigh": { "label": "Very high" }
      },
      "models": {
        "gpt-6-astra": { "name": "Astra" }
      }
    }
  }
}
```

- `schemaVersion` and `minReaderVersion` are both `1`. They are required.
- `providers` holds one entry per provider, by id: `claude` or `codex`.
- A provider's `models` holds one entry per model, by **key**: the exact version the CLI accepts to select it. Claude's model list names aliases, such as `fable`, `opus[1m]` and `default`, which the CLI points at a newer version when it updates; fat-g keys each Claude model by the version its alias stands for instead — `claude-fable-5-1[1m]`, `claude-sonnet-5` — so an entry here names a version, never an alias. Settings shows the id each model stands for beside its name; the key is that id, with the context mark, such as `[1m]`, of the row that offered it.
- A provider's `efforts` changes how an effort level is shown, by level id, for every model of that provider.

What a model entry may set, each field optional:

| Field | What it does |
|---|---|
| `name` | The name shown. At most 60 characters are kept. |
| `description` | A description. At most 200 characters are kept; `null` removes it. |
| `resolvedId` | The id a session reports for this model, so fat-g recognises it. |
| `efforts` | The model's effort levels, as ids, in the order to show them. `[]` means the model has no effort setting. |
| `listedDefaultEffort` | The level to mark as the default. |
| `speedTiers` | The model's speed tiers, in order. Each is an id (`"priority"`), or an object with an `id` and optionally a `name` and a `description`. A tier named by its id alone keeps the name the CLI gives it. |
| `hidden` | `true` hides the model; `false` shows one the CLI hides. |

What an effort entry may set: `label`, the name shown; and `caution`, `true` for a level fat-g should never pick by itself, such as Codex's `ultra`.

Ids — keys, effort levels, tiers — use only letters, digits and `. _ - : / @ [ ]`, at most 128 characters. A provider may list at most 200 models, a model at most 16 effort levels and 8 speed tiers.

Fields fat-g does not know are skipped, and do not make the file invalid. A provider's colour and mark belong to fat-g and cannot be changed here: a `presentation` field is skipped like any other unknown one. A provider id fat-g does not have is skipped, and Settings names it.

## Examples

**Rename a model:**

```json
{ "schemaVersion": 1, "minReaderVersion": 1,
  "providers": { "codex": { "models": { "gpt-6-astra": { "name": "Astra" } } } } }
```

**Hide a model** you never use:

```json
{ "schemaVersion": 1, "minReaderVersion": 1,
  "providers": { "codex": { "models": { "gpt-5.5": { "hidden": true } } } } }
```

**Show a model** the CLI hides:

```json
{ "schemaVersion": 1, "minReaderVersion": 1,
  "providers": { "codex": { "models": { "gpt-reserve": { "hidden": false } } } } }
```

**Add a model** the CLI does not list, at the end of the list:

```json
{ "schemaVersion": 1, "minReaderVersion": 1,
  "providers": { "codex": { "models": {
    "my-local-model": { "name": "Local", "efforts": ["low", "high"] }
  } } } }
```

**Keep a version** your CLI no longer lists. A chat keeps the version it was made with, and takes no prompt once its account's list no longer names it; if your CLI still runs that version, adding it here lets those chats go on:

```json
{ "schemaVersion": 1, "minReaderVersion": 1,
  "providers": { "claude": { "models": {
    "claude-fable-5-1": { "name": "Fable 5.1", "efforts": ["low", "medium", "high", "xhigh", "max"] }
  } } } }
```

Settings marks each model the file touched: *Changed by your catalog.json*, *Added by your catalog.json*, or *Hidden by your catalog.json*.

## A model the CLI does not know

Neither CLI checks a model when a session starts: it fails at the first turn. So a model added here that your CLI does not have — a mistyped key, or a model your plan does not include — appears in the list, and fails only once a session sends it a prompt. When a key is not taking effect, compare it with the keys Settings lists as *Reported by the CLI*.

## When fat-g ignores the file

A file fat-g cannot use is **ignored whole**: none of it applies, and the lists are what the CLIs report. The note at the top of Settings → Accounts says why, and the file stays exactly as it is until you repair or delete it. There is no Start fresh for this file: fat-g never writes it.

| What Settings says | Why |
|---|---|
| fat-g cannot open the file | The system refused to hand it over. Another program may be holding it. Try Reload later. |
| The file is larger than 256 KB | It is too large to be an override. |
| The file is not valid JSON | A comma, a quote or a brace is off. If you edited it by hand, undo the edit. |
| The file has no valid `schemaVersion` and `minReaderVersion` | Both are required, as whole numbers, with `minReaderVersion` no larger than `schemaVersion`. |
| A newer fat-g wrote this file | It needs a newer fat-g. Update fat-g to use it. |
| An earlier development version of fat-g wrote this file | It is in a format this version no longer reads. |
| A value is not what fat-g expects, at … | A known field has the wrong type, or breaks a bound above. Settings names the field, such as `providers.codex.models.gpt-5.5.hidden`. |

A missing file is no error: Settings shows where one would go.

## Privacy

The file is yours: fat-g reads it and writes nothing into it. Its logs say only how many models it changed, added and hid, or why it was ignored — never a value from it, and never its path. See [`PRIVACY.md`](../PRIVACY.md).
