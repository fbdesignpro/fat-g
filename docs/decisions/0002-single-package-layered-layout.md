# 0002 — Single package with lint-enforced layers (not a monorepo)

> **Rule:** one package; layers are enforced by ESLint boundary rules. Providers depend only on `src/shared`, nothing imports a provider's internals, and providers are registered in one place (`src/main/providers/index.ts`). Disabling a boundary rule is a red flag in review.

- **Status:** Accepted
- **Applies to:** repository structure, build tooling

## Context

`AGENTS.md` requires the code to be "modularized and layered, so that others may easily add new functionality, providers, etc." Two ways to enforce that were considered:

1. **Single package** — one `package.json`, electron-vite's standard `src/main` · `src/preload` · `src/renderer` split, plus `src/shared` (contracts) and `src/main/providers/<name>`. Boundaries enforced by ESLint import rules.
2. **pnpm workspace monorepo** — `packages/core`, `packages/provider-*`, `apps/desktop`, each with its own `package.json`. Boundaries enforced by package resolution.

## Decision

Start with the **single package**. Layer boundaries are enforced in CI with `eslint-plugin-boundaries` + `no-restricted-imports`. [`eslint.architecture.js`](../../eslint.architecture.js) is the source of truth and `tests/architecture` proves that an illegal import fails; in short:

- `src/shared` → itself only: no Electron, React or Node built-ins, so it loads in main, the preload and the renderer. `src/shared/provider-kit` holds the interfaces providers code against.
- `src/renderer` → `src/shared` (not its provider kit), React and its own npm dependencies; never Electron or Node. It talks to main through `window.fatg`.
- `src/preload` → a pipe that forwards allowlisted channels; type imports only from the contract, validation in main.
- `src/main/providers/<x>` → `src/shared` and its own folder: no Electron, no other provider, no `src/main`, no `child_process` (it spawns through `ctx.processes`).
- `src/main/process`, the stores, the catalog, the sessions, the conversations and the file reader → no Electron, so they test in plain Node; main hands them their folders and clock. `src/main/instances` also imports no file-system module.
- Everywhere: no network module, `fetch` or `electron.net` (decision 0004), and no Anthropic package (decision 0006).

What makes code modular is the **dependency direction**, not the number of `package.json` files: providers depend only on `src/shared`; nothing depends on a provider's internals; providers are registered in exactly one place (`src/main/providers/index.ts`).

## Consequences

- Fastest route to a running app; no per-package build/TS config; no pnpm-symlink friction with electron-builder.
- The boundary is a *fence* (a lint rule someone could visibly disable in a PR), not a *wall*. Reviewers should treat any `eslint-disable` of a boundaries rule as a red flag.
- Third parties cannot yet publish a provider as a standalone npm package.
- Extraction path stays mechanical as long as layering holds: `src/shared` → `packages/contracts`, `src/main/process` → `packages/process`, each `src/main/providers/<x>` → `packages/provider-<x>`. The `@shared/*` path alias makes this mostly a rename.

## Revisit when

- Outside contributors want to ship providers independently of app releases, or
- a second app (e.g. a headless/CLI host) needs to reuse the contracts and process layer.
