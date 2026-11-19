# Licensing and attribution

fat-g's original source is licensed under the standard MIT license in [`LICENSE`](../LICENSE).
The author is **Francois Bertrand**; the copyright notice also credits the fat-g contributors.
Settings → About shows the author and version from `package.json` and the full root license,
included at build time. Reading About needs no account, preference write, network access, or IPC.

Keep the copyright and MIT permission notice with copies or substantial portions of the software.
Visible credit to Francois Bertrand and a link to the original fat-g project is appreciated, not
an additional license condition. Contributors retain their own rights; keep their notices and
submit original contributions under MIT. Identify any borrowed code or assets and their terms.

## Source notices

First-party code, styles, HTML, scripts, and workflow files carry short SPDX headers:

```ts
// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT
```

Keep executable shebangs, batch `@echo off`, and HTML doctypes in their required positions.
Use the format's comment syntax. Retain upstream notices in third-party material; never replace
them with fat-g's header. New authors can add their own copyright lines.

[`REUSE.toml`](../REUSE.toml) annotates selected first-party JSON configuration and lockfiles that
cannot take comments. Referenced dependencies keep their own licenses. It is not a declaration
that every asset or historical document has been cleared, or that the whole repository is
REUSE-compliant. Fonts and imported media are deliberately outside those MIT annotations.

## Distribution checks

The existing packaging command (`do-package.bat`) collects every root `LICENSE`, `LICENCE`,
`COPYING`, and `NOTICE` file from each shipped or bundled npm package. Local packaging fails on
missing license metadata, missing license text, or empty license/notice files. It adds no network
lookup, dependency, runtime check, or license allowlist.

The package audit checks that fat-g's distributed license matches the root license and that the
collected dependency texts and attribution lines survive in `THIRD_PARTY_NOTICES.txt`. Electron's
two notice files are required on every platform; macOS explicitly copies them inside the app's
Resources folder. The full audio notices are included, preserving their separate imported-sound
terms. These mechanical checks do not establish license compatibility or redistribution rights.

Run focused verification with `do-check.bat focused --files src/renderer/src/settings/AboutSection.tsx
src/renderer/src/settings/SettingsDialog.test.tsx scripts/lib/packages.mjs scripts/lib/packages.test.mjs
tests/packaging/package-audit.test.ts tests/packaging/audio.test.ts` (one command on one line).

## Assets and release review

Inter retains OFL-1.1 and its existing copyright/license file. Imported sounds retain the terms
described in `assets/audio/LICENSE.txt`; only the listed original synthesized effects are MIT.
The maintainer confirmed that the anime avatar artwork was generated with Google
Gemini, and the other avatar artwork with ChatGPT, from prompts alone, with no third-party
reference images; and that the MTX families' artwork was generated with Google
Gemini from prompts alone too. The MTX source files' content credentials (C2PA)
say more: each image was created with ChatGPT's image model (`gpt-image`), then
edited with Google's generative AI (Gemini), the ChatGPT image its input. The redraws
behind `MTX-Fa`, `MTX-Op`, `MTX-Ast` and `MTX-Sol` carry the same credentials, except
that `MTX-Fable.jpg` was then saved from Adobe Photoshop, and `MTX-Op.png` carries no
credentials, only Photoshop as the tool that saved it. The shipped WebP files keep none of this
metadata. The maintainer directed this record brought into line with the files.

The maintainer directed that redistribution rights be considered settled for
the planned binary release and public source snapshot, including the intended shipped code
and assets. The redistribution review is closed. Preserve the existing asset terms,
attribution and distributed notices when preparing both outputs.

Keep the flagged layout mockup and private captures out of the public snapshot and history.
Preserve Electron/Chromium component terms and include any required source-availability
material with the distribution. Provider service and trademark terms remain separate from
fat-g's MIT source license.

## Provider-policy review

The [OpenAI app-server authentication guidance](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
expressly permits continued use by local or open-source applications and excludes commercial or
hosted services from that route. This supports fat-g's planned free, local, open-source release;
revisit the review if its distribution or authentication model changes. It is not vendor approval
of every feature.

[Anthropic's integration guidance](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)
requires its [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) for running Claude
Code in a product, an unmodified binary, each user's own authentication and billing, and no resale
or intermediation of usage. It also permits users to sign into that unmodified CLI with their own
subscriptions. fat-g's detect-only, CLI-owned-authentication design matches those stated
conditions. The maintainer accepted the reviewed provider terms and directed release
preparation to proceed for fat-g as a free, local, open-source application with no commercial
aims. The maintainer's provider-policy review is closed on that basis. This records the
maintainer's decision, not a vendor approval or a new agreement executed by the agent. The
internal usage-query protocol remains an unsupported dependency whose availability may change.
