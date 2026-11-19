# 0004 — The app never touches credentials; the CLI makes every authenticated call

> **Rule (hard):** never read credential files or keychains, never call vendor endpoints, make no network calls of fat-g's own, never present a login of fat-g's own or handle anything of one: signing in is the CLI's own flow, in the user's terminal and browser. Ask the installed CLI for everything. Account data lives in memory only and never reaches logs or the Pet.

- **Status:** Accepted. **This is a hard rule, not a preference.** Rule line amended by the maintainer (M14b, round 6): it said "never perform or present a login".
- **Applies to:** every provider adapter, present and future

## Context

Showing subscription usage allocations is Phase 1's first feature. Many community usage monitors get this data by reading the CLI's stored OAuth token (`~/.claude/.credentials.json`, the macOS Keychain, `~/.codex/auth.json`) and calling undocumented vendor endpoints directly — for Claude this additionally requires sending a spoofed `claude-code/<version>` User-Agent to avoid rate limiting.

That approach conflicts with:

- **Anthropic's terms** — third-party developers may not offer claude.ai login, route requests through Free/Pro/Max credentials, or "collect, store, or intermediate Claude.ai credentials or session tokens". What *is* explicitly permitted is an end user signing in to the **unmodified Claude Code binary** with their own subscription.
- **This project's own first principle** (`AGENTS.md`): user files, personal information and privacy are paramount.

## Decision

1. **Never read** `~/.claude/.credentials.json`, the OS keychain/credential manager, `~/.codex/auth.json`, or any other CLI-internal credential file. Tokens never enter our process.
2. **Never call** undocumented vendor HTTP endpoints, and never spoof another product's User-Agent or `clientInfo`. The Codex app-server handshake identifies us honestly (`clientInfo.name: "fat_g"`).
3. **Login is always delegated** to the CLI's own flow (e.g. `claude auth login`, `codex login`, or the app-server's `account/login/start`, which opens the vendor's own page in the system browser). The app shows the command / opens the vendor URL; it never presents its own credential form.
   - *(M14b, round 6:)* fat-g may open the user's own terminal with the CLI's login command already in it. The terminal is started detached, with no pipe: fat-g reads nothing it shows, relays no link and no code, and does not wait for it. A login run out of sight, with fat-g passing its output or a pasted code along, stays out: that would put sign-in material through fat-g.
4. All account and usage data is obtained by **asking the CLI** over its supported structured interfaces (`claude auth status`, the Agent SDK control channel, `codex app-server` JSON-RPC).
5. The app itself makes **no network calls**. This is lint-enforced (ban on `node:http(s)`, `node:net`, `electron.net`, `fetch` in app code) plus runtime guards (`webRequest` allowlist, permission requests denied, spellcheck off, no telemetry / crash reporter / auto-update).
6. Account data (email, org, plan, usage numbers) lives **in memory only** — never persisted, redacted from logs, and stripped from the always-on-top Pet window's state copy.
7. Naming: the product and its features are not called "Claude Code" or "Codex"; the README carries a "not affiliated with or endorsed by Anthropic or OpenAI" disclaimer.

## Consequences

- If a provider offers no supported way to read some data, **the feature degrades** (e.g. Claude usage falls back through the tiers in [0001](0001-claude-usage-tier.md) down to an account-only panel). We do not reach for the credential file to fill the gap.
- "We never read your credentials — the CLI does" is a verifiable claim in an open-source codebase, and it is less code.
- PRs adding a provider must follow the same rules; `docs/adding-a-provider.md` (M8) will state this.

## Revisit when

- A vendor publishes an official, documented API for third-party apps to read subscription usage with user-granted scopes. Even then: tokens would go through the OS credential store under explicit user consent, never a plain file.
