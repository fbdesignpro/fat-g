# 0007 — What a packaged build may contain, and how it is hardened

> **Rule:** a package holds only the allowlisted build output and the runtime dependency closure (`dependencies` = what main imports), verified by `scripts/verify-package.mjs`. Release builds contain no smoke hooks and use the hardened Electron fuses. macOS app bundles are ad hoc signed after the fuse changes. Builds use no signing certificates, updater or automated publishing. Development runs use the `fat-g-dev` data folder.

- **Status:** Accepted by the maintainer (the M9 decision table, accepted as written). Implemented in M9.
- **Applies to:** `electron-builder.yml`, `scripts/package.mjs`, `scripts/verify-package.mjs`, `electron.vite.config.ts`, `src/main/app/{flavor,identity}.ts`, CI.

## Context

M9 turned fat-g into an installable app. Packaging is where "what is on the developer's disk" becomes "what ships to users":
- electron-builder's default packs the whole project folder, and a working copy can hold unredacted account captures (`spikes/output/`), fixtures and local settings.
- The app had a smoke mode that any build honored. It is driven by `FATG_SMOKE*` environment variables that make the app launch an executable and scripts of the caller's choosing — the kind of hole Electron's `runAsNode` fuse exists to close.
- Electron's default fuses leave `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` able to run code through the app's own executable, and don't check the archive's integrity.
- Release packaging uses no signing certificates.

## Decision

1. **Allowlist, then audit.** `electron-builder.yml` lists `package.json` and `out/{main,preload,renderer}`. electron-builder adds only the production `node_modules` closure. `npm run package*` is the only supported way to build, and `node scripts/verify-package.mjs` fails a package that holds anything else:
   - a file outside the allowlist, or a package outside the lockfile's runtime closure;
   - a repo folder, a source map, a secret, preferences, or updater metadata;
   - any `@anthropic-ai/*` or `@modelcontextprotocol/*` package ([0006](0006-no-agent-sdk-at-runtime.md));
   - a file over the size tripwire;
   - the smoke fixtures' private strings, or the build machine's home or checkout path;
   - fuses that differ from this record, smoke code in a release, or missing license notices.
2. **`dependencies` = what ships.** Main externalizes `dependencies`; the renderer bundles everything. So `dependencies` must equal exactly what main and shared code import at runtime (a test enforces it). The renderer's packages are devDependencies, credited in `THIRD_PARTY_NOTICES.txt` because they are bundled in.
3. **Release builds contain no smoke hooks.** `__FATG_SMOKE_HOOKS__` is false only in a release package build (`FATG_RELEASE_BUILD=1`, read at build time). The bootstrap loads the smoke modules only through dynamic imports behind that flag, so a release bundle has neither the code nor the `FATG_SMOKE*` strings. A *smoke flavor*, packaged with the identical configuration, is what automation drives.
4. **Fuses:** `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, embedded asar integrity on, only-load-from-asar on, extra `file://` privileges off. Cookie encryption stays off: fat-g stores no cookies, and on an unsigned Mac it can prompt for keychain access. A local tamper test proves integrity on Windows: a one-byte-flipped copy must fail Electron's check, after an untampered copy started in the same isolated environment.
5. **Identity:** app ID `io.github.fbdesignpro.fatg` (the Windows AppUserModelID and macOS bundle ID; development runs use `….dev`) and product name `fat-g` (also the userData folder). Unpackaged runs use `fat-g-dev`, so a development build never touches the installed app's preferences or single-instance lock.
6. **Distribution.** Windows uses an unsigned, per-user NSIS wizard with a folder chooser and a **Run fat-g** checkbox on the finish page, checked by default. The wizard keeps the existing per-user scope without elevation or an all-users choice; `build/installer.nsh` preserves that scope within electron-builder's standard installer. Linux uses AppImage. macOS uses architecture-labelled DMGs with an Applications shortcut for manual distribution. `publish: null` and `--publish never` keep uploads out of CI and local packaging. There is no electron-updater or associated `.blockmap` or `elevate.exe` file. The package script strips certificate and publishing variables and disables certificate auto-discovery.
7. **macOS signatures.** On macOS the package script passes `electronFuses.resetAdHocDarwinSignature=true`. Electron re-signs the bundle and nested code after modifying the Electron Framework, preserving existing signing metadata such as entitlements and runtime flags. The audit requires a valid ad hoc bundle signature and verifies it recursively with `codesign --verify --deep --strict`. `mac.identity: null` skips electron-builder's certificate signer, which in 26.15.3 searches the keychain for an explicit identity even when the qualifier is `-`. `mac.notarize: false` and `dmg.sign: false` disable notarization and image signing. [Electron fuses documentation](https://www.electron.build/v26/docs/tutorials/adding-electron-fuses/)

## Consequences

- A new runtime dependency means changing `dependencies`, the lockfile and the audit's expectation together — deliberately visible in review.
- A new shipped asset (an icon, for example) needs an allowlist entry; the audit names what it refuses.
- The application icon is a black circle with a white lowercase Inter SemiBold `f`, generated by
  `scripts/generate-app-icons.mjs` into `build/icon.{png,ico,icns}`. Platform packaging takes its
  matching format; main imports the PNG into `out/main/assets/icon.png` for the running window and
  macOS Dock. `icon-attention.png` beside it adds a top-right yellow circle, replacing the runtime
  icon while any active session has unacknowledged attention (0010); acknowledged notices and waits
  on other chats do not light it. Main follows state transitions, decodes the two images once, and
  releases a window's subscription when it closes. Windows loads `icon.ico` and `icon-attention.ico`
  from that same main assets folder, each carrying best-quality prefiltered 16–256 px representations,
  including intermediate DPI sizes: Electron's ICO path loads the requested native icon size, whereas
  its PNG path hands Windows a full-size bitmap. Only these four exact archive paths are allowlisted;
  renderer images remain forbidden. No stored format, tray, timer or notification permission is involved.
- *(M102, [0031](0031-avatars.md):)* the built-in avatar art ships beside the archive as `resources/avatars/`, copied by `extraResources` from `assets/avatars/`, outside `app.asar`. The audit holds it to its own rules (`scripts/lib/avatar-art.mjs`): only families' `family.json` and `LICENSE.txt` and avatars' role files; a family whose manifest names a licence must hold its `LICENSE.txt` and its line in `THIRD_PARTY_NOTICES.txt`; 4 MiB in all; and the privacy scan reads every file there, images included. No image still ships in the renderer.
- Build tooling downloads Electron and packaging toolsets at build time (checksum-verified, cached). The *app* still makes no network calls.
- License collection preserves every root license and NOTICE file for shipped/bundled npm packages, rejects missing metadata/text or empty notice files, and includes the separate audio notices. The audit checks full collected texts and fat-g's exact root license, not just package names. See [licensing and attribution](../licensing.md).
- AppImages carry an embedded update block map (electron-builder has no switch for it). Nothing reads it, since fat-g has no updater. A separate `.blockmap` or `latest*.yml` beside any installer is refused.
- Users see SmartScreen once on Windows. On macOS, an ad hoc signature allows native Apple Silicon code to execute, and a browser-downloaded DMG may require per-app approval in Privacy & Security. Linux distributions that restrict unprivileged user namespaces may refuse Electron's sandbox inside an AppImage. [Apple's first-open instructions](https://support.apple.com/en-us/102445)

## Revisit when

- Developer ID signing is introduced (then also consider `enableCookieEncryption` on macOS).
- An auto-update or release channel is proposed: that is network behavior, and needs its own decision.
- electron-builder moves to v27 (renamed keys; toolsets default to "latest"): re-run the audit and `scripts/verify-package-mutations.mjs`.
- A browser-downloaded DMG or a Linux package is first launched by a person. Record the result in the release checklist.
- **Every distributed build** must carry Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`. macOS copies them explicitly into the app's Resources folder; missing files fail the audit on every platform. Verify that layout on macOS before distribution.
