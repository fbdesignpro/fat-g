# Maintaining built-in avatar art

This is the maintainer recipe for turning artwork in the gitignored `raw_assets/` folder into art shipped from `assets/avatars/`. The public avatar format and its user-facing rules are in [`avatars.md`](avatars.md); the architectural rule is [decision 0031](decisions/0031-avatars.md).

## Before processing

- Treat `raw_assets/` as maintainer-owned input. Do not rename, move, edit or delete its files unless the maintainer explicitly asks.
- Inspect the source image and the existing family. Do not infer a crop for a non-square source; ask which square crop to use.
- Never overwrite an existing avatar merely because new artwork depicts the same model. Replace files only when the maintainer explicitly asks for replacement. Otherwise create the requested new family or avatar folder.
- Keep folder names exactly as requested: they are stable avatar references. A new built-in family goes at `assets/avatars/<Family>/` and an avatar at `assets/avatars/<Family>/<Avatar>/`.

## Deterministic conversion recipe

Built-in portraits use a 512 px square WebP. Small roles use a separate 64 px square WebP resized directly from the raw source, not from the 512 px portrait. The established conversion is:

- open the source and convert it to RGB;
- resize independently to 512 x 512 and 64 x 64 with Pillow's Lanczos resampler;
- encode each as lossy WebP with `quality=90` and `method=6`;
- do not copy source metadata into the output.

With Pillow installed, this script performs the conversion. Set the three paths for the asset being processed.

```python
from pathlib import Path
from PIL import Image

source = Path("raw_assets/<source image>")
destination = Path("assets/avatars/<Family>/<Avatar>")
destination.mkdir(parents=True, exist_ok=True)

image = Image.open(source).convert("RGB")
for size, name in ((512, "portrait.webp"), (64, "small.webp")):
    image.resize((size, size), Image.Resampling.LANCZOS).save(
        destination / name,
        "WEBP",
        quality=90,
        method=6,
    )
```

Do not add Pillow as an application dependency just for this maintainer operation. If Pillow is unavailable, stop and tell the maintainer instead of silently choosing a different encoder; different encoders and settings produce different shipped bytes.

## Family manifest

Every built-in family needs `assets/avatars/<Family>/family.json` with the format documented in [`avatars.md`](avatars.md): schema version 7, its avatars in intended family order, and model `matches` only where the intended pairing is known — a provider's family draws them on every model they match, with no assignment ([decision 0031](decisions/0031-avatars.md)). The family's name is its folder's.

The easiest way to make and edit it is fat-g itself, in a development run (`do-run-dev.bat`), which treats `assets/avatars/` as the source of fat-g's own families:

1. Put the new family's avatar folders in `assets/avatars/<Family>/`, then **Settings → Avatars → Rescan**. fat-g writes a `family.json` with its defaults where the family has none.
2. Press the family's row to open the **family editor**: set the Default style, each other avatar's matches and own style, then **Save family**. It writes `assets/avatars/<Family>/family.json` directly, keeping fields it does not know.
3. Review the result with `git diff -- assets/avatars/<Family>/family.json` before committing.

A smoke or stream run, and an installed or packaged fat-g, never write `assets/avatars/` or `resources/avatars/`.

The development editor also offers **Make a copy** beside **Cancel** to open an editable user family while retaining direct editing of the repository's built-in family.

Set **Provider**, just below Family default, to Claude or Codex for provider-specific art; leave Any provider for shared art. This setting is separate from `defaultFor`, which still chooses the starting family.

Every family needs a `Default` folder holding a portrait: it is the family default, wearing the family's `overlay` style, and what a model nothing matches shows. It is not listed in `avatars`; the other avatars' styles are overrides of the Default style. Do not add `defaultFor` to a variant family unless the maintainer explicitly makes it a provider's starting family. The first built-in family by folder name whose `defaultFor` names a provider is that provider's starting family, so a second family naming the same provider and sorting first would take it over. Claude Lightning and Codex Lightning declare their respective providers; the Gradient, Anime and MTX families have no `defaultFor`.

Art that spells the model's name sets the family's `"parts": { "name": false, "version": true }`, so its avatars say the version alone; the `Default` folder says the name too, whatever the family's `parts`. Art with its version drawn in sets `"overlay": { "version": { "parts": { "version": false } } }` on that avatar, so fat-g's own version text is not drawn over it ([decision 0032](decisions/0032-avatar-overlay.md)); the effort marks still draw. Art without one leaves the version to the overlay and may set the family's look — a preset, a size — and an avatar's colour; the marks' look is the family's `overlay.effort`.

Example:

```json
{
  "schemaVersion": 7,
  "minReaderVersion": 7,
  "provider": "codex",
  "overlay": {
    "version": { "preset": "band", "size": 14, "parts": { "name": true, "version": true } },
    "effort": { "show": true, "position": "bottom" }
  },
  "avatars": [
    { "folder": "Astra", "matches": ["*-6-astra*"], "overlay": { "version": { "preset": "glow", "size": 20, "parts": { "name": false }, "effectColor": "#b98cff" } } }
  ]
}
```

The Anime families were the maintainer's own user families, `Claude - Anime` and `Codex - Anime`, and ship as those folders held them: their WebP files are copied byte for byte, not converted by the recipe above, and their manifests carry the families' styles in the shipped manifests' form. Their sources in `raw_assets/anime/` include images that are not square, so converting them again needs the maintainer's crops. Their `Default` portraits are a flat colour; drawn art replaces one by the recipe.

The MTX families are one per provider, so each `Default` wears its provider's colour. Their avatars are converted by the recipe above from the square art in `raw_assets/matrix/`, made with ChatGPT and then Gemini ([licensing](licensing.md#assets-and-release-review)), named for the letters each spells: `MTX-Fa`, `MTX-Op`, `MTX-So` and `MTX-Ha` in Claude MTX, `MTX-Ast`, `MTX-Sol`, `MTX-Te` and `MTX-Lu` in Codex MTX. The maintainer's bolder redraws later replaced four of them, at the maintainer's request: `MTX-Fa`, `MTX-Op`, `MTX-Ast` and `MTX-Sol` come from `MTX-Fable.jpg`, `MTX-Op.png`, `MTX-Ast.jpg` and `MTX-Sol.jpg` there, the others still from the `Gemini_Generated_Image_*` files. Each `Default` is letter-free code rain cropped from one of them before the recipe: Claude MTX's the top-left 600 px square of the `Ha` art (orange), Codex MTX's the top-left 900 px square of the `Lu` art (blue).

The Gradient and Lightning families' `Default` portraits come from no raw image: each is the radial gradient of its provider's art with no letters, measured ring by ring around the centre from the no-glow Gradient art (`So` and `Ha` for Claude, `Lu` for Codex) with the letters masked out, then converted by the recipe above; a Gradient family and its Lightning one share it. Drawn art for a `Default` replaces it by the recipe, as any other avatar.

If the family declares a licence, add its `LICENSE.txt` and the corresponding generated third-party notice as required by the packaging audit. Do not invent authorship or licence metadata.

## Verification

1. Visually inspect both outputs. In particular, view `small.webp` at its native 64 px and confirm that the face or identifying mark remains legible.
2. Confirm both files are square, still WebP images: 512 x 512 for `portrait.webp` and 64 x 64 for `small.webp`.
3. Confirm the existing family was not modified when the request was for a new version (`git diff -- assets/avatars/<existing family>`).
4. Run the focused checks:

   ```powershell
   npm.cmd test -- tests/packaging/avatar-art.test.ts src/main/avatars/manifest.test.ts src/main/avatars/scan.test.ts src/main/avatars/catalog.test.ts
   ```

5. Ensure the complete `assets/avatars/` tree still obeys the 4 MiB packaging bound and contains only family manifests, optional licence files, avatar folders and role images. Packaging performs the authoritative audit.

## Seeing new art in a running app

- A development run reads `assets/avatars/` directly. After adding art, use **Settings -> Avatars -> Rescan**.
- A packaged run reads the copied snapshot at `resources/avatars/` beside its packaged application. Rescan does not read the repository and cannot see art added to `assets/avatars/` after that package was built. Rebuild and start the unpacked app with `do-package-and-run.bat`, then use Rescan if the Settings dialog was already open.
- For a temporary check of an already running unpacked build, the new family may be copied unchanged from `assets/avatars/<Family>/` into that build's `resources/avatars/<Family>/`, provided the destination does not already exist. This is generated output only; the repository's `assets/avatars/` remains the source of truth, and the next package rebuild replaces the copied snapshot.

Report the source path, destination family/avatar, final dimensions, encoder settings and verification result. Do not commit or push unless explicitly asked.
