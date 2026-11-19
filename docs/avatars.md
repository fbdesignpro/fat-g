# Avatars of your own: the `avatars` folder

fat-g draws an avatar wherever a session or a model stands: in each capsule of the project list, the session switcher, the model column, the Sub-agents tab and the New session popup's tiles. It ships families of its own — **Claude Anime**, **Claude Gradient**, **Claude Lightning** and **Claude MTX**, **Codex Anime**, **Codex Gradient**, **Codex Lightning** and **Codex MTX** — and reads the families you put in a folder of your own. A family is a folder: its name is the folder's, its avatars are the folders in it — one of them, `Default`, required — and how they look and which models they suit is its own `family.json`.

fat-g writes a family's `family.json` (below). **Make a copy** also creates a new family there from built-in artwork, with its images and licence unchanged, and **Add avatar** a new avatar in a family from an image you drop.

## Settings → Avatars

The tab has two parts.

**Provider Avatars.** One button per provider: the avatar of its first listed model, its version and two effort marks (Medium), with the provider's name and, on the black bar, its family's — *Codex Gradient*, say. Press it to open the provider's **family assignment** popup, in two parts:

- **Assign family to** the provider:
  - **Eligible families** lists the families the provider's models can be drawn from; press one to choose it. Until you choose one it is fat-g's own — Codex Lightning for Codex, Claude Lightning for Claude — marked *(default)*; choosing the default again keeps none of your own, so it follows the art fat-g ships. Only families for that provider or Any provider are offered. A family with no `Default` folder is listed, greyed.
  - **Edit family** opens the family editor for the family chosen. Under them, that family's avatars as capsules, its `Default` first.
- **Override specific avatar**, a button under the families, opens a second popup for the provider:
  - **Detected models for** the provider: every model its accounts list, each with what it draws and why — *Override*, *Family match* and the entry that matched (`Family match: Codex Gradient / Sol (*-sol*)`), or *Family default*. **Assign avatar**, right under that heading, gives the model selected an avatar of its own, built-in or yours, whatever its family, and **Clear** removes it.
  - Under the list, **Assign by** chooses what an override follows (below).

**Avatar families.** One row per family the scan found — yours first under **Custom**, then fat-g's own under **Built-in**, each by name: its name, its author and licence, how many problems it has, and every avatar as a capsule in the family's own style, with the version of a model it suits and two effort marks. **Rescan** reads the folders again; **Show avatars folder** opens yours, making it where it is missing. Press a row to open the **family editor**.

**Drag an image here to start a new family, or press to browse** sits directly below the **Avatar families** heading. A PNG, JPEG or WebP uses the same square-image requirements and preparation as Add avatar below. Its popup previews the portrait and small image and asks for the **Family name**, initially taken from the image file. With no matches, the image becomes the required `Default` avatar alone. Adding optional **Matches** also offers an **Avatar name** and creates that named avatar from the same image, alongside `Default`. **Create family** writes the family and opens its editor; Cancel or Escape writes nothing. An existing user family name, in any case, is refused; a built-in family of the same name is separate. The provider's selected family stays as it was.

**Rescan**, **Show avatars folder** and the compact **i — Technical details** button sit on the next row. Technical details opens **Avatar families**, a reference describing the folder layout, PNG sizes and limits, and drag-and-drop image updates. The folder tree marks `Default/` as required and `family.json` as automatically created on Rescan when missing.

### The family editor

The editor has three columns: the family's avatars at the left, the one chosen beside them, and its style at the right.

- At the top left, **Provider** (Any provider, Claude or Codex). Under it, side by side, **Open content folder** opens this family's folder in the file manager, and the **i — Technical details** button opens the **Avatar families** reference.
- Below them, one **Avatars** list: **Family default** first — the family's `Default` folder, chosen when the editor opens — followed by the family's other avatars in its order, each with its match entries and a small yellow *Customized* tag where it has overrides. Up, Down, Home and End move through the whole list. An avatar `family.json` lists whose folder is gone is shown greyed as *Missing folder*; **Remove entry** takes it out of `family.json` (no file is deleted).
- Under the list, on a faint yellow, **Drag an image here to add an avatar to this family, or press to browse**: drop a PNG, JPEG or WebP on it, or press it to choose one. It may be any size up to 8,000 px a side and 5 MB, but square and at least 64 px; 512 × 512 is best. fat-g scales it down to a 512 px `portrait.png` — an image of 512 px or less keeps its size, and a PNG of it its very bytes — and makes a 64 px `small.png` from it, with the Lanczos filter fat-g's own art is made with. A popup shows both, with the new avatar's **Name**, taken from the file's, and its **Matches**. **Add avatar** writes the folder, both files and its entry in `family.json` at once, like **Make a copy**: your other unsaved changes stay unsaved, and the new avatar is kept even if you cancel them. The name may hold letters, digits, spaces and `. _ - ( ) +`, and may not be one the family holds already, in any case ([decision 0036](decisions/0036-adding-avatars.md)).
- At the right, the chosen row's style: a **Preset** for the version's look (Badge, Glow, Band or Chip), which replaces that look whole — *Custom* names none, keeping the look the row's own fields and the Default style give it — then the **Version** — the name and the version, the effect, size, colours, **Effect opacity** (0 to 100 %, for the outline, glow or chip alone), a **Glow strength** where the effect is Glow (0 to 200 % of fat-g's own), a shade behind the text and one of eight places — and the **Effort dots** — whether they are drawn, one of four edges, the **“Fast” marker position** (one of the version's eight places, for the lightning bolt a fast session shows in the marks' look), their size, spacing, colour, effect, effect opacity, glow strength and shade.
  - With **Family default** chosen it is the **Version and effort display styles**, the Default style: the `Default` folder's look, and the look every other avatar starts from. Its preview shows the `Default` folder in it, as the other avatars wear the style. The `Default` folder always says the model's name and version, since it stands for any model no avatar suits: the style's **Name** and **Version** set what the other avatars say (*Family default shows both*), and turning off both **Name** and **Version** hides the text on the other avatars. Where that makes the `Default` folder draw otherwise than its style, a second preview beside the first, *When no avatar matches*, shows it with both.
  - With an avatar chosen it is that avatar's **Version and effort display style overrides**. Each field the avatar sets otherwise than the Default style is highlighted in yellow, with a **↺** button — on those rows alone — that gives it the default again; **Reset customizations**, beside the *Customizations highlighted* note, removes them all. A field set as the Default style sets it is no override: when a change of the Default style comes to agree with one — the name taken away where an avatar had already taken it away — it ends there, and the avatar follows the Default style in that field from then on. A missing folder's overrides are shown, and cannot be changed.
- Beside the list, the chosen row under its name, **Avatar: …**, then its two images, each described at its left with its size: its **Main image** at the model column's size, and its **Small version** at the capsule's (the main image where it has none). Drag an image onto one to replace it, or press its **Browse**: an image for the main image replaces it and its small version, made from it as Add avatar makes them — the small version says so beside it, *(Autogenerated on main image change)* — and one for the small version replaces that alone. **Preview as** and **effort** share one line under the images. It is written at once, and the files it replaces go to your system's Recycle Bin or Trash. **Browse** — here and at the drop zone — opens your system's file chooser at the folder your last image came from, chosen or dragged, until fat-g quits. Both images are drawn as a model it suits — or the model and effort you pick under **Preview as** and **Effort** — and always as a fast session, so the lightning bolt shows where its place puts it, with:
  - under them, its **Matches**: a pattern each, for any provider or one, **Add match** and **Remove**; *Takes now* says which listed models the family would give it.
- Your edits are written at **Save family**. **Cancel**, Escape and the close button ask first when you have changes. If `family.json` was changed outside fat-g while the editor was open, saving says so and writes nothing: **Reload** reads it again, dropping your changes.
- Built-in avatar families cannot be changed in an installed fat-g. **Make a copy** creates **Copy of …** in your avatars folder and opens it for editing. If the name exists, it adds **(2)**, **(3)** and so on. Artwork, matches, styles and licence are copied unchanged; the copy is kept even if you cancel editing. A family whose `family.json` fat-g refuses (below) opens read-only too, saying why.
- In a development build, **Make a copy** is also beside **Cancel**. Direct editing of built-in art stays available. If you have unsaved edits, copying asks before discarding them; the copy uses the saved family.

## Which avatar a model shows

A model shows, in this order:

1. **Its override**, if you gave it one.
2. **The family's avatar its name matches**, by the family's `matches` (below). This is looked up each time the model is drawn and never saved, so a model the CLI lists tomorrow shows the family's avatar at once.
3. **The family default**, where nothing matches: the family's `Default` folder, whatever the provider.

Every session on that model, on any of the provider's accounts, and the model's tile in the New session popup show it at once. One avatar may stand on as many models as you like.

Each row of the family assignment popup shows the model by its name; Settings → Accounts shows each model's name and resolved **ID**. **Assign by** chooses what an override follows:

- **Follow CLI key** keeps it on a key such as `opus`. If the CLI changes which version `opus` means, its image follows that change.
- **This version (ID)** keeps it on the resolved id, such as `claude-opus-5-5`, even if the CLI later changes or removes its alias. Display names are not identifiers and are never matched. If the CLI reports no resolved id, the key is used.

A version override takes priority over a key override for that model. Changing **Assign by** writes nothing.

- **Kept by the folders' names.** fat-g remembers an override, and the family you chose, by the folders' names, in its preferences. Rename or move a folder and it is a new avatar or family to fat-g: after a **Rescan** an override's row says "Not found" and the model shows its family's avatar until you assign it again, or give the folder its old name back and Rescan.

## The version and the effort marks

fat-g draws a model's version — and, where a style asks for it, its short name — over its avatar in the model column and on capsules, so one image can serve every version of a model. The text comes from the model's id: `gpt-6.1-sol` reads `6.1` and `Sol`, `claude-opus-5-5` reads `5.5` and `Opus`.

Beside it, the session's effort is drawn as marks: one to five dots for Low, Medium, High, Extra high and Max, and five starbursts for Ultra. A session shows the effort in force, a new chat's tile and a preset the effort chosen; a sub-agent shows none. Neither is drawn at 36 px or less, where it could not be read.

A session at the fast speed tier shows a lightning bolt as well, in the marks' look and twice a dot's size, in a place of its own — the top left unless the family puts it elsewhere — whether or not the marks are drawn. It too is drawn only in the model column and on capsules.

Both looks are the family's: its style, then the avatar's own, over fat-g's defaults (a badge with the version at the top right; white dots outlined in black along the bottom). Where the marks stand on the version's edge, the version moves inward to make room; where the bolt stands in the version's own place, the version moves aside. Anywhere else the family may place them where they meet.

## Where it goes

In fat-g's data folder. **Show avatars folder**, in Settings → Avatars, makes it where it is missing, empty, and opens it.

| System | Folder |
|---|---|
| Windows | `%APPDATA%\fat-g\avatars\` |
| macOS | `~/Library/Application Support/fat-g/avatars/` |
| Linux | `~/.config/fat-g/avatars/` |

A development run (`npm run dev`) reads `fat-g-dev` instead of `fat-g`.

fat-g reads the folder when it starts and when you choose **Rescan**. It does not watch the folder: after a change, choose Rescan.

## The layout

```text
avatars/
├── Starry/                  a family: a folder, named as you name it
│   ├── family.json          its order, matches and look; made by fat-g if missing
│   ├── LICENSE.txt          optional: its licence, where family.json names one
│   ├── Default/             required: the family default
│   │   └── portrait.webp
│   ├── Nova/                an avatar: a folder
│   │   ├── portrait.png     required: portrait.png or portrait.webp
│   │   └── small.png        optional: small.png or small.webp
│   └── Comet/
│       └── portrait.webp
└── Another family/
```

- A family's and an avatar's names are their folders' names, exactly as written. A family of yours named like one of fat-g's stands beside it, apart.
- Every family needs a `Default` folder holding a portrait (the case of its name does not matter): the **family default**. It wears the family's style, and a model no name matches shows it. A family without one is listed, saying so, and not used until you add it and **Rescan**.
- An avatar's files are named by their role: `portrait` and `small`, then `.png` or `.webp`. The case of these names does not matter.
- Anything else in an avatar's folder is listed as not used. Other files in a family's folder are passed over, and so is any name that starts with a dot, and a folder inside an avatar's folder.
- A link is never followed: fat-g passes over a linked family or avatar, and reports a linked file.

## The images

| | Portrait | Small |
|---|---|---|
| Required | Yes | No |
| Drawn at | 60 px (capsule) and 176 px (model column) | 36 px (mini window), 30 px (completed capsule, session switcher) and 16 px (Sub-agents, New session tiles) |
| Recommended size | 512 px square | 64 px square |
| Without it | the avatar is drawn nowhere | the portrait is drawn at 36, 30 and 16 px too |

Both are **square still images**, PNG or WebP, at most **5 MiB** and **8,000 pixels a side** — the one bound fat-g sets on every image it reads. There is no minimum: one large portrait covers every size, scaled down by the page. A small is for the three smallest sizes, where a scaled-down portrait blurs; drawn by hand, it can be redrawn to stay legible at 16 px.

fat-g checks each image by its header alone, without decoding it: its type, which its name's extension must agree with, its size in pixels, its size in bytes, and whether it moves — an animated PNG or WebP is refused. A file that passes there and still fails to draw is marked *Could not be drawn* in the tab, and the next file stands in for it: the portrait for a small, and for a portrait the provider's plain square.

Leave the version out of the art where you can: fat-g draws it (above). Art with its version drawn in can hide fat-g's with `"overlay": { "version": { "parts": { "name": false, "version": false } } }`.

## `family.json`

Where a family folder holding an avatar has none, fat-g makes one at the next start or **Rescan**: version 7, fat-g's default look written out whole, and the avatars' folders in name order with no match. The family editor writes it after that; you may edit it by hand too, then **Rescan**. Without one — in a folder fat-g may not write — a family is its folders, in name order.

```json
{
  "schemaVersion": 7,
  "minReaderVersion": 7,
  "provider": "any",
  "author": "Your name",
  "licence": "CC-BY-4.0",
  "overlay": {
    "version": { "preset": "glow", "size": 20 },
    "effort": { "position": "bottom", "color": "#ffffff" }
  },
  "avatars": [
    { "folder": "Nova", "matches": ["claude-opus-*", { "provider": "codex", "key": "gpt-6-*" }], "overlay": { "version": { "effectColor": "#ff9a1f" } } },
    { "folder": "Comet", "overlay": { "version": { "parts": { "name": false, "version": false } } } }
  ]
}
```

- `schemaVersion` and `minReaderVersion` are both `7`. They are required. A file at an earlier version is refused whole, and fat-g leaves it as it is: its family stands as its folders until both are raised, or the file is removed and fat-g makes a new one at the next Rescan.
- `provider` is `"any"` (the default), `"claude"` or `"codex"`. The family is offered only to that provider, or to all of them for `"any"`, for both family and individual avatar choices. An active family whose provider no longer fits falls back to that provider's starting family; existing explicit model overrides stay as chosen. Other provider ids are kept for builds that register them.
- `author` and `licence` are shown in the tab. `licence` names the licence of the family's art; put its text in `LICENSE.txt` beside the file. A `name` is not read: the folder names the family.
- `avatars` lists the family's other avatars, by folder, in your order — the order breaks a tie between two equally strong matches. The `Default` folder is no entry of it: its look is the family's `overlay` — with the name and version always, whatever its `parts` — and it matches nothing; an entry for it is kept as written and not read. An avatar the list leaves out is still the family's, after the listed ones, by name. An avatar listed with no folder is reported, and the rest applies.
- `matches` names, for each avatar, the models it suits: a model's key, or a pattern where `*` stands for any run of characters, for any provider, or an object naming the provider too. Keys use the characters of a model's key — letters, digits and `. _ - : / @ [ ]` — with `*` added, at most 128 of them. When the family is a provider's family, a model with no override shows the avatar whose entry matches it:
  - An entry matches a model whose key, or whose resolved ID, it spells whole, the case of letters aside: Claude's key may be `opus` and its ID `claude-opus-5-5`, so `*opus*` finds both. Use `claude-opus-5-5` for that version alone, or `opus` for the CLI's alias. An entry naming another provider is passed over for this one.
  - The stronger entry wins a model: a key over a pattern, then the pattern with more characters other than `*`, then an entry naming the provider over one that does not; at equal strength, the avatar first in your order. Several models may match one avatar.
- `defaultFor` lists provider ids (`claude`, `codex`) whose starting family this is — the family a provider's models are drawn from until you choose one. It is read for fat-g's own families alone, and the editor leaves it as it is; in a family of yours it does nothing. A provider id fat-g does not have is kept, unused, and named in the tab.
- `overlay`, for the family and for each avatar, holds two styles:
  - `version`: `preset` (`badge`, `glow`, `band`, `chip`), `parts` (`{ "version": true, "name": false }`), `effect` (`plain`, `outline`, `glow`, `chip`), `size` (6 to 40, the text's height as a percentage of the square), `textColor`, `effectColor` and `backdropColor` (`#rgb` or `#rrggbb`), `effectOpacity` (0 to 100, the outline, glow or chip colour's opacity; 100 where omitted, with the text staying opaque), `glowStrength` (0 to 200, how far the `glow` effect reaches, as a percentage of fat-g's own 100), `backdrop` (`none` or `shade`), `backdropStrength` (0 to 100) and `position` (`top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right`).
  - `effort`: `show` (true or false, for the marks alone), `position` (`top`, `bottom`, `left`, `right`), `fastPosition` (one of the version's eight places, where a fast session's lightning bolt stands; `top-left` where omitted, as in a file written before it came), `size` (3 to 15, a mark's width as a percentage of the square), `spacing` (0 to 10), `color`, `effectColor` and `backdropColor`, `effect` (`plain`, `outline`, `glow`), `effectOpacity` (0 to 100, the outline or glow colour's opacity, with the marks staying opaque), `glowStrength` (0 to 200, as the version's), `backdrop` (`none` or `shade`) and `backdropStrength` (0 to 100).

  A field of the wrong form is left out and named in the tab; the rest applies.

Fields fat-g does not know are skipped at every level, do not make the file invalid, and are kept when fat-g saves the file. The file may be at most 256 KiB.

## What the tab says

| Avatars says | Why |
|---|---|
| not a PNG or WebP image, or its name says another type | The file is no PNG or WebP, or a PNG is named `.webp`, or the reverse. |
| not square | Its width and height differ. |
| larger than 5 MiB | Its size in bytes is past the bound. It is not read. |
| more than 8,000 pixels a side | Its size in pixels is past the bound. |
| animated | It is an animated PNG or WebP. |
| damaged | Its header cannot be read whole: the file was cut short, or is not what its signature says. |
| could not be read | The system refused to hand it over. Another program may be holding it. |
| a link, which fat-g does not follow | A role's file is a link. Put the file itself there. |
| two files for one role, so neither is used | Both `portrait.png` and `portrait.webp`, say, or two names differing only by case on a system that keeps both. Which one you meant is not guessed. |
| no usable portrait, so it is drawn nowhere | The avatar has no portrait, or its portrait has one of the problems above. |
| family.json … so the family stands as its folders | The manifest was refused whole, for one of the reasons the [catalog override's table](catalog-override.md#when-fat-g-ignores-the-file) gives — it could not be read, is larger than 256 KiB, is not JSON, has no valid version, needs a newer fat-g, was written for an earlier version, or holds a field of the wrong form, which is named. fat-g does not write it. |
| listed in family.json, but there is no such folder | An entry of `avatars` names no folder of the family. The editor shows it as *Missing folder*. |
| no Default folder holding portrait.png or portrait.webp, so the family is not used | The family has no `Default` folder, or its `Default` has no usable portrait. Add one and Rescan. |
| overlay fields of the wrong form, left out: … | A field of an `overlay` is not one of the values above; each is named by its place, as `avatars.1.overlay.version.size`. |
| The scan stopped at 2,000 entries, in … | fat-g reads at most 2,000 entries — folders and files, at any depth — in the folder, and stops there, so that a folder of photos dropped in by mistake costs nothing. What follows is not listed. |
| The folder could not be read | The system refused to list the folder itself. |

An empty or missing folder is no error: the tab shows no **Custom** group.

## fat-g's own families

fat-g ships its art in a folder of the same layout, beside its program: `resources/avatars/` in a package, and `assets/avatars/` in the repository. An installed fat-g never writes there; a development run edits the repository's copy ([maintaining avatar art](maintaining-avatar-art.md)). A family there that names a licence must hold its `LICENSE.txt`, and the package's `THIRD_PARTY_NOTICES.txt` credits it; the packaging audit refuses anything else in that folder, and more than 4 MiB of art in all. Adding a family is adding a folder.

## Privacy

The folder is yours: fat-g reads it, and writes in it only each family's `family.json` — made where missing, and saved from the family editor — never an image. An image is read each time a window draws it, through fat-g's own confined route, by an id fat-g gave it — never by its path — and the browser engine may keep a drawn avatar in its cache in the data folder. Its logs say only how many families, avatars and problems it found, and that a `family.json` was made or saved. The mini window (the Pet, in the code) receives the files of the avatars of the sessions it lists, by their ids, and nothing else of avatars: no folder's or family's name, and not the list of what fat-g found. See [`PRIVACY.md`](../PRIVACY.md) and decisions [0031](decisions/0031-avatars.md) and [0032](decisions/0032-avatar-overlay.md).
