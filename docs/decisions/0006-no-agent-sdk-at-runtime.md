# 0006 — No Claude Agent SDK at runtime

> **Rule:** no Anthropic SDK package ships or runs. fat-g speaks the CLI's stdio control protocol itself, with fixed arguments, and never sets the SDK's identity variables. A usage or models-only session sends only `initialize` and `get_usage` and refuses every request the CLI initiates. A chat session's closed set of sends and answers is [0020](0020-claude-chat-sessions.md)'s.

- **Status:** Accepted by the maintainer, and **implemented** by M7b. Spike S2 passed with Claude CLI 2.1.268: account and usage read with no SDK and no SDK identity markers (findings (private)). Installed acceptance repeated that through the production adapter. **Amended by [0028](0028-secretary.md)** (M26): a third kind of Claude process, the secretary's, with a closed set of its own in its own writer — `initialize` carrying a task's instruction as the system prompt, one prompt, and this record's refusal of whatever the CLI asks. The usage and models-only sessions keep this record's two subtypes.
- **Applies to:** `package.json`, `src/main/providers/claude/`, `src/shared/provider-kit/`, packaging (M9) and Phase 3 design. Amends [0001](0001-claude-usage-tier.md). For chat sessions (M16) its closed request set is replaced by [0020](0020-claude-chat-sessions.md); everything else here holds for them too.

## Context

M7 read Claude usage through `@anthropic-ai/claude-agent-sdk` (pinned 0.3.278), per decision 0001. Preparing to package the app (M9) showed what shipping it means:

- **Terms.** The Agent SDK overview states that use of the SDK is governed by Anthropic's Commercial Terms, *"including when you use it to power products and services that you make available to your own customers and end users."* An installer would redistribute it inside an MIT-licensed app.
- **Third-party policy.** The same page says: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* fat-g's defensible position (decisions [0003](0003-detect-user-installed-clis.md), [0004](0004-never-touch-credentials.md)) is to launch the **unmodified binary the user installed and logged in to**, not to build a product on the SDK.
- **Small benefit.** For fat-g the SDK does three things:
  - launches the user's `claude` with documented stream-json flags;
  - sends an `initialize` control request, whose reply carries the account;
  - sends one experimental `get_usage` control request.

  fat-g's test fixture already implements the CLI side of this.
- **Large cost.**
  - 97 lockfile packages, plus optional platform binaries (227 MB on Windows) that packaging would have to exclude.
  - A synchronous external-spawn bridge, because the SDK insists on launching its own child.
  - Host-process logging suppression, because the SDK reads debug switches from fat-g's own environment and command line.
  - Runtime network/process tripwire tests, because its bundle imports `http`, `https`, `net` and `child_process`.
- **Pinning buys little stability.** The user's CLI updates itself while the SDK stays pinned, so fat-g already handles version skew (the CLI's `Unsupported control request subtype` reply).

## Decision

fat-g ships **no Anthropic SDK package**. The Claude provider speaks the minimal stdio control protocol to the user's installed `claude` through fat-g's own process layer:

- The argv and `initialize` frame are fixed and equal to what the SDK sent for fat-g's options, as recorded in `tests/fixtures/claude/sdk-0.3.278-wire.json`: stream-json in/out, `--verbose`, empty setting sources, `--strict-mcp-config`, `--permission-mode default`, `--no-session-persistence`; `initialize` carries `systemPrompt: [""]`.
- Only two request subtypes may ever be sent: `initialize` and `get_usage`. OAuth/login subtypes can never be sent; this is enforced by a closed type and a confinement test.
- fat-g never identifies itself as the SDK: it sets neither `CLAUDE_CODE_ENTRYPOINT` nor `CLAUDE_AGENT_SDK_VERSION`, and strips inherited ones.
- Control requests initiated by the CLI are refused, never acted on.
- Every other decision-0001 rule stands: the idle session, no prompt, the account guard before usage, the neutral cwd, the 60 s poll floor, and outcome C (account-only) when `get_usage` is rejected.

A `@anthropic-ai/*` import anywhere in `src/` is a lint error.

## Consequences

- fat-g owns a small, undocumented protocol dependency. When a CLI update breaks it, Claude degrades to the account-only panel, and S2 is re-run to adapt the one seam file.
- The M7 SDK-containment machinery is removed: external spawn, host-logging suppression, real-SDK tripwire tests. The child environment policy, tree cleanup, the cleanup latch and the deadlines remain.
- Packaging (M9) needs no SDK exclusions and ships no commercially licensed Anthropic code.
- **Phase 3 must not assume the SDK.** Driving Claude turns uses the CLI directly — its documented headless mode and/or this control protocol. *(M16:)* [0020](0020-claude-chat-sessions.md) is that design. The maintainer accepted the reviewed provider terms for the free, local, open-source release; the [release-policy assessment](../licensing.md#provider-policy-review) closes the previously deferred maintainer review.
- The acceptance includes proceeding with the CLI-reported subscription usage display. It is not an explicit vendor endorsement of `get_usage`; that unsupported protocol dependency and its account-only fallback remain.

## Amendments (M13)

- **C90 — a models-only session.** For an account whose usage read runs no session (signed out, an API key, a cloud provider), the catalog asks Claude for its models through a session with the same argv and `initialize` frame that sends `initialize` alone: its guard before usage declines every account, so `get_usage` is never sent. It adds no subtype, never overlaps a usage session, and runs after a runtime's first read, an account change and a Refresh, otherwise at most once an hour ([0013](0013-catalog-format-and-layers.md); M13, C92).

## Revisit when

- Anthropic documents the stdio control protocol, or publishes a supported non-SDK interface for reading usage: prefer the documented one.
- The Agent SDK becomes available under terms compatible with redistribution in an MIT app, **and** Phase 3 needs capabilities that would be unreasonable to reimplement.
- A CLI update makes the protocol unworkable without SDK identity markers. Then return to the maintainer; never impersonate the SDK.
