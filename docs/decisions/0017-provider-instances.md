# 0017 — A provider runs as one or more instances, each with its own configuration folder

> **Rule:** a provider instance is its provider plus one configuration folder, and the user sees it as an account. The first instance sets nothing and runs as the provider always did. An added instance runs the same CLI with the provider's folder variable set to a folder the user picked, and without the inherited variables that would put another credential or endpoint before that folder's login. fat-g never opens, lists or writes anything in an account's folder. A session stays with the instance and the folder it started in.

- **Status:** Accepted by the maintainer with M14b's final spec (S3, S4, S6, C4–C10, C15, C17, C18, C58–C62). Implemented in M14b. Items marked *(round n)* are M14b's planning amendments, which stand unless the maintainer objects. The acceptance with the installed CLIs (M14b, V17) is recorded in the milestone document. M22, amended items 5 and 7 (C55, C60–C62, C72, C73; [0027](0027-execution-permissions.md)): what a CLI answers of its sandbox, and the setup of it, are an account's own, a setup holds its account until its end, and what a CLI writes into its own folder for a mode or a setup is the CLI's.
- **Applies to:** the provider kit's declaration, the process layer, the preferences, the provider registry, the catalog, the session record and every later code that starts a provider's process for a session. Amends [0003](0003-detect-user-installed-clis.md), [0011](0011-records-store.md) and [0016](0016-model-presets.md).

## Context

- People hold more than one account with a provider: a personal one and a work one, or two plans. Each CLI keeps an account's login, settings and conversations in one configuration folder, and each lets a documented variable move that folder (multiple-accounts research (private)).
- M14b's spike traced both CLIs with the variable pointed at an empty folder beside the user's own, at once: the empty one reads as signed out, the other reads its account. With two Codex logins, the two read different accounts and different usage at the same time (the same note, "M14b spike").
- fat-g never reads credentials and presents no login of its own ([0004](0004-never-touch-credentials.md)), so the only thing it may do about a second account is start the user's CLI in the folder the user signed in to. For the sign-in itself it shows the CLI's command, and can open the user's terminal with it.
- Options considered, as other tools do it (the same note, §3 and §5): a folder per account (this decision), where the wrapper never sees a token; credential swapping, which stores each account's tokens and rewrites the CLI's login file; and proxy pooling, where a gateway holds several logins. The last two break [0004](0004-never-touch-credentials.md). T3 Code's shadow home, which lets two Codex accounts share threads, was also left out: it means creating links inside a folder the CLI owns.

## Decision

1. **An instance** is a provider plus one configuration folder. It is named by the provider's id and an instance id: a fixed word for the first, a UUID for an added one, never shown and never reused. A provider has at most eight.
2. **The first instance sets nothing.** It runs exactly as the provider did before instances, in the folder the user's own environment names, or the CLI's default.
3. **A module declares what an instance needs** ([`InstanceSupport`](../../src/shared/provider-kit/provider.ts)): the variable's name, the CLI's default folder under the home folder, and the inherited variables an added instance must not receive. A module without the declaration has one instance and no Add account. No shared code names a provider or a variable.
4. **An added instance's children** get the declared variable set to its folder, in place of any inherited value, and none of the withheld variables. The first instance's children inherit as before. No per-run override can set the variable.
   - Claude withholds every `ANTHROPIC_` variable, every `CLAUDE_CODE_USE_` selector and `CLAUDE_CODE_OAUTH_TOKEN`.
   - Codex withholds `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, every `OPENAI_` variable and `CODEX_SQLITE_HOME`, which moves a home's state out of the home *(round 2)*.
   - Proxy and certificate variables pass. An instance whose withheld variables were present says so in Settings, by name, never by value.
5. **Each instance is a whole runtime:** its own process scope, detection, account read, usage reads, model report and catalog entry. One instance's failure leaves the others running. *(M22, C60–C62, C72, C73:)* so are what its CLI answers of its sandbox, and the setup of it ([0027](0027-execution-permissions.md), items 6 and 20). That state is the configuration folder's: one account's Codex can answer that its sandbox is ready while another's, on the same machine, answers that none is set up. Readiness is asked of an account, kept for the run and dropped at a setup's end. A setup is asked of one account, on a connection of its own in that account's process scope, and holds that account alone until its end: nothing of its sessions is sent meanwhile, no session's mode is changed by it, and no other account is reached.
6. **A folder comes only from fat-g's own folder picker**, and is refused when by real path it is another instance's folder, the CLI's default folder, the folder the inherited variable names, a folder inside or around a project's root, or one inside or around fat-g's data folder. A project's root is refused the same way from its side. The rules are checked again each time an added instance starts; one that fails launches nothing.
7. **fat-g never looks inside an account's folder.** It asks two things of it, through one limiter: whether it is there, and what its real path is. It creates, reads, lists and writes nothing in it, and removing an account leaves the folder as it is. *(M22, C55, C60:)* what a CLI writes there for something fat-g asked of it is the CLI's own doing, and fat-g still opens none of it: a start under some of Codex's modes makes Codex record the session's folder as trusted in its `config.toml`, and Codex's setup writes its sandbox's own files there ([0027](0027-execution-permissions.md), items 20 and 21). Each is said where the mode or the setup is chosen, and in `PRIVACY.md`.
8. **An action reaches what it stops.** The provider's switch and a change of its executable replace every instance's runtime. An instance's own switch, its Redetect and its Remove reach its own alone. Whatever guards an action against running sessions checks that same reach.
9. **A session names its instance** in its record at create. The initial draft may change its selection through the guarded operation in [0016](0016-model-presets.md); after starting, its instance is fixed. A model preset names an instance too, and its model and level are checked against that instance's own list.
10. **A session stays with the folder it started in.** With the provider's reference, the record stores the configuration folder its instance had then. A session whose stored folder is not, by real path, the one its instance has now is held: nothing of it is started, resumed or read, and no removal is offered. A session with no reference has none stored and starts wherever its instance then points.
11. **An instance that cannot be used** — switched off, no longer configured, or blocked as an entry or by its folder *(round 4)* — holds its sessions the same way, and create refuses a preset that names it.
12. **A label and a folder stay in the Main window.** Neither reaches the Pet, a window title or a log. A folder's path is in `preferences.json` and, for a started session, in `records.json` and — *(M18, C28)* with the provider's reference, so that a session whose record lost it still resumes in its own folder — in the conversation store ([0019](0019-conversation-store.md)), and nowhere else.

## What is left out

- Sharing sessions between accounts, moving a session to another account, switching accounts when one runs out, and a pooled usage figure.
- Per-account environment variables, API keys, endpoints, launch arguments and executables: an instance differs from its provider only by its folder and by what item 4 withholds.
- Changing an instance's folder: it is removed and added again, since its sessions live in that folder.

## Consequences

- Every later start of a provider's process for a session (M15, M16) takes the session's instance scope, and asks the same gate before a start, a resume or a history read.
- Preferences are at version 4 and records at version 3, with no migration ([0014](0014-format-compatibility-starts-at-first-release.md)).
- What no variable decides is out of reach: a login a CLI keeps outside its folder (a federation profile, a machine-wide managed setting, an OS keychain entry) holds for every instance. Settings then says "Same account as" on the later of two instances that report one account.
- Where each CLI keeps a second folder's login on macOS and Linux is not verified; it is a release gate for those systems.

## Revisit when

- A CLI keeps a login outside its configuration folder on a supported OS, so two folders read as one account.
- Sessions need to be shared between accounts: that is a different mechanism, which touches the CLI's own files, and needs its own decision under [0004](0004-never-touch-credentials.md).
- An account needs something of its own beyond its folder, such as an endpoint or an executable.

## Automatic installation discovery

[Decision 0037](0037-provider-discovery.md) adds metadata-only discovery at launch and on Main focus. It preserves saved switches, blocks all discovery for unavailable preferences, permits passive installation checks of manually disabled providers without starting their CLIs, and makes missing providers inactive across their accounts without interrupting running work. Account folders and credentials are never searched.
