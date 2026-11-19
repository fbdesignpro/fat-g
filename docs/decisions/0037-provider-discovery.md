# 0037 - Automatic provider installation discovery

> **Rule:** main checks registered providers' installed CLI files at launch and on Main focus, at most once a minute, with a manual rescan; presence activates enabled accounts and absence makes them inactive, without changing saved switches or interrupting running work. A first summary and later batched changes are Main-only notices, remembered as installation booleans in a separate versioned history file.

- **Status:** Implemented from the approved plan.
- **Applies to:** provider discovery, process resolution, provider registry, session availability, usage strip, Accounts, Main-only IPC and privacy. Amends 0003, 0005 and 0017 only as described below.

## Context

A provider not installed still occupied a usage box, and a missing or disabled runtime was never automatically checked again. Reusing full runtime detection on focus would restart processes, read accounts and usage, and could interrupt active sessions. Writing automatic results into the user's enable switch would lose the distinction between a deliberate disable and an absent installation.

## Decision

1. Installation availability is separate from saved provider and account switches and from account/usage health. Signed-out CLIs, unsupported usage and connection/version-probe failures remain detected. All accounts share their provider's executable availability; account folders are never searched or imported.
2. Resolution uses the same explicit override, PATH and known-directory order as launch. An invalid override never falls back. Known-directory checks include bounded provider-declared desktop runtime folders, with the same ordering as launch (0003). Metadata-only scans need no provider factory, instance scope or CLI invocation; the process service reuses its cached environment preparation. Unavailable preferences block even discovery; an explicit off permits passive discovery but no provider startup (0005).
3. Main owns discovery, coalesces overlapping scans, ignores stale settings/shutdown results, bounds checks to three seconds and reuses still-pending OS lookups. Access failures are inconclusive, preserving a previous result. Focus checks have a one-minute cooldown; the manual rescan bypasses it. No background polling or new shell PATH probe is introduced.
4. Missing providers lose usage boxes and cannot start new work. Runtime disposal waits for affected turns, workers, asides and sandbox setup to finish. Rediscovery starts enabled accounts normally; a return before deferred disposal keeps the existing runtime. No switch, account folder, session or project is removed or rewritten.
5. A DOM dialog summarizes first detection; later dialogs batch availability changes alone. Got it and Escape acknowledge the displayed revision; Accounts settings acknowledges then opens Accounts. Other modals take priority. The mini window receives no discovery state or notices and cannot invoke discovery or acknowledgment.
6. `provider-detection.json` in fat-g's data folder stores an acknowledged-first-notice flag and provider-id booleans, with both envelope versions 1. Writes are atomic and preserve unknown fields and compatible future metadata. Unreadable/incompatible history stays untouched; detection continues in memory with an Accounts diagnostic. A failed save is dismissible for this run, with a diagnostic. No preferences format change or migration is needed.

## Consequences

A third provider participates through its registered definition, without shared provider-specific branches. Installed CLIs use the existing authentication and process paths; discovery itself reads no configuration or credential file. Newly installed software visible only through a changed system PATH may need an app restart. Focus checks do not refresh models, usage or account identity.

## Revisit when

Providers cannot be discovered through executable files, or the product needs independent user configuration for automatic checks.
