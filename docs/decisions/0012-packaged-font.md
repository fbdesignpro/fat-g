# 0012 — The packaged font: Inter

> **Rule:** fat-g ships Inter 4.1 (SIL OFL 1.1): Regular, Medium, SemiBold and Bold, as the vendor's hinted WOFF2 files, unmodified, with its licence file. Scripts Inter lacks fall back to the OS's sans-serif fonts.

- **Status:** Accepted by the maintainer, who picked Inter from M10's comparison page (M10, C40–C44). Implemented in M11: the files are in `src/renderer/public/fonts/inter/`, the package audit checks them by SHA-256 (`scripts/lib/package-audit.mjs`), and `THIRD_PARTY_NOTICES.txt` carries the licence.
- **Applies to:** the renderer's typography tokens, the packaged assets allowlist, `THIRD_PARTY_NOTICES.txt`, the package audit ([decision 0007](0007-packaged-build-contents.md)).
- **Evidence:** licence readings, file hashes and the coverage table in M10.md, Font comparison (private).

## Context

The layout wants a Helvetica-like sans serif in black and white. A system font looks different on each OS, and Helvetica cannot be shipped. Four candidates were checked: Inter, TeX Gyre Heros, Liberation Sans, Nimbus Sans.

- Nimbus Sans failed the licence check: AGPL-3.0, with an exception only for embedding in documents.
- TeX Gyre Heros is the closest to Helvetica, but it drew no Greek or Cyrillic and few symbols. Its licence (LPPL) asks for complete distribution, and its OpenType archive carries no licence file.
- Liberation Sans draws Hebrew too, but has only regular and bold.
- Inter drew Latin Extended, Greek, Cyrillic and every symbol tested, has the middle weights the capsules use, and has the plainest licence.

## Decision

1. **Font:** Inter 4.1, from the official release `Inter-4.1.zip` (github.com/rsms/inter).
2. **Licence:** [SIL Open Font License 1.1](https://github.com/rsms/inter/blob/master/LICENSE.txt). `LICENSE.txt` ships beside the fonts and in `THIRD_PARTY_NOTICES.txt`.
3. **Weights:** 400, 500, 600 and 700, upright only. Italics are added when the layout needs them.
4. **Format:** the vendor's hinted WOFF2 files, `extras/woff-hinted/Inter-{Regular,Medium,SemiBold,Bold}.woff2` (about 575 KB together).
5. **The files ship unmodified**: no subsetting, renaming or re-encoding.
6. **Coverage:** Inter draws Latin Extended, Greek, Cyrillic and the symbols the UI uses. Hebrew, Arabic, Devanagari, Thai, Chinese, Japanese and Korean come from the OS, so the font stack ends in a system sans-serif family.

## Consequences

- M11 adds the four files and the licence to the packaged allowlist, the notices and the package audit.
- Text in scripts Inter lacks looks different on each OS. That is accepted.

## Revisit when

- Inter publishes a new major version, or the layout needs a second typeface (code, for example).
