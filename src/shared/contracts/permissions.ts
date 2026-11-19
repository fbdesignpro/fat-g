// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Execution permissions (docs/planning/_archive/M22.md, Design 1–3, 7; C1, C3, C39, C40, C43–C46, C60–C63,
// C65, C72, C89; decision 0027): what a session may do, as a mode of its chat. A provider declares
// its modes in fat-g's own names, once, in its descriptor; main resolves which one a chat has and
// says, per account, which of them that account can use; the adapter alone maps a mode's id to its
// CLI's own words and operations, in its own folder.
//
// Renderer-safe, and provider-neutral: no native mode name, no frame and no method is here. A mode
// id is a provider-scoped string the descriptor declares, checked against that provider's own list
// and never carried from one provider to another (C43).
//
// It imports `zod` and nothing of Node, the page or main.
import { z } from 'zod';

// ── A mode, as its provider declares it (C39, C63) ────────────────────────────────────────────

export const MAX_MODE_ID = 64;
export const MAX_MODES = 16;

/** A mode's id as a channel, an event and a stored row may carry it: lower-case words joined by hyphens. */
export const ModeIdSchema = z.string().min(1).max(MAX_MODE_ID).regex(/^[a-z][a-z0-9-]*$/);

export function isModeId(value: unknown): value is string {
  return ModeIdSchema.safeParse(value).success;
}

export interface PermissionMode {
  /** Provider-scoped and stable: what a chat, a default and a turn keep. */
  readonly id: string;
  /** fat-g's name for it (C63). */
  readonly label: string;
  /** One line: what runs without asking (C3). A mode that asks nothing at all names its CLI's own word for it. */
  readonly description: string;
  /** The mode sends the CLI's action requests to the user: false for a reading mode, and for one where nothing asks. */
  readonly asks: boolean;
  /** The provider's reading mode (C45): every request to act is refused, as before there were modes. */
  readonly reading: boolean;
  /** The ids a verified change with no restart reaches it from (C2); every other change closes the session's process. */
  readonly transitionsFrom: readonly string[];
}

/**
 * What a provider says of its CLI's own set-up step (C60, C72): the lines its dialog shows that are
 * the provider's to word, since they name its CLI's doing and the system's. Everything else the
 * dialog says is fat-g's, and names the provider by its display name alone.
 */
export interface SetupDeclaration {
  /** What the setup changes on the machine, by the vendor's own description: said before the press. */
  readonly changes: string;
  /** Who asks for leave to make those changes, and how: the system's own prompt, never fat-g's. */
  readonly approval: string;
  /** What may be happening while its end is waited for. */
  readonly waiting: string;
}

/**
 * What a provider's descriptor declares of its modes (C39). `fallback`: the mode a chat has where
 * nothing chose one (decision 0027). `setup`: an account may need a
 * set-up step of the CLI's own before some of them (C60), said in the provider's words; null for a
 * provider that has none. `inherited`: the one line that stands
 * under every list of these modes, saying that the user's own configuration acts as it lets it (C3).
 * `rules`: the one line beside a session's grants that says what is known of the CLI's own rules,
 * with its actual limit (C23). Both lines are the provider's, so no shared file words a provider.
 */
export interface PermissionCapability {
  readonly modes: readonly PermissionMode[];
  readonly fallback: string;
  readonly setup: SetupDeclaration | null;
  readonly inherited: string;
  readonly rules: string;
}

/** The mode a capability lists under an id, or undefined. */
export function modeOf(capability: PermissionCapability | null, id: string | null): PermissionMode | undefined {
  return id === null ? undefined : capability?.modes.find((mode) => mode.id === id);
}

/** The provider's reading mode: there is one in every list (C45). */
export function readingMode(capability: PermissionCapability): PermissionMode | undefined {
  return capability.modes.find((mode) => mode.reading);
}

// ── What an account can use (C43, C51, C60, C65, C85) ─────────────────────────────────────────

/**
 * Why an account cannot use a mode. `unvalidated`: no capture shows a turn under it on this CLI
 * (C85). `needs-setup`: the CLI's sandbox is not set up for this account (C60). `cli-refuses`: the
 * CLI takes it only with a flag fat-g never passes (C47). `platform`: not on this system.
 */
export const MODE_REASONS = ['unvalidated', 'needs-setup', 'cli-refuses', 'platform', 'pending'] as const;
export type ModeReason = (typeof MODE_REASONS)[number];

/**
 * Where a sandbox mode can write beside the session's folder, as the account's last start reply
 * said (C65): never a constant. `roots` and `network` are the account's own CLI configuration,
 * shown as such; a root is a path, so this is the Main window's only.
 */
export interface WritablePlaces {
  readonly temporary: boolean;
  readonly roots: readonly string[];
  readonly network: boolean;
}

export interface ModeAvailability {
  readonly id: string;
  readonly available: boolean;
  readonly reason: ModeReason | null;
  /** A Set up control is offered for it (C60). */
  readonly setup: boolean;
  /** Choosing it makes the CLI record the session's folder as trusted, in its own configuration (C55). */
  readonly records: boolean;
  /** The account has no sandbox for it: every write asks, and an accepted one runs unconfined (C4). */
  readonly unconfined: boolean;
  /** Null until a start reply of this account has said, and for a mode with no sandbox. */
  readonly places: WritablePlaces | null;
}

/** What is said of a mode no availability is known for yet: usable, with nothing more known. */
export function availabilityOf(modes: readonly ModeAvailability[] | undefined, id: string): ModeAvailability {
  return modes?.find((mode) => mode.id === id) ?? { id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null };
}

// ── Which mode a chat has (C1, C40, C43, C44) ─────────────────────────────────────────────────

/** Where a chat's mode came from: chosen in the chat, the project's default, the user's, or the provider's fallback. */
export const MODE_SOURCES = ['chat', 'project', 'user', 'fallback'] as const;
export type ModeSource = (typeof MODE_SOURCES)[number];

export interface ChatMode {
  readonly id: string;
  readonly source: ModeSource;
}

export function isModeSource(value: unknown): value is ModeSource {
  return typeof value === 'string' && (MODE_SOURCES as readonly string[]).includes(value);
}

export interface ModeChoices {
  /** The chat's own saved mode. */
  readonly saved: string | null;
  /** The project's default for the provider, or null: Use my default. */
  readonly project: string | null;
  /** The user's default for the provider. */
  readonly user: string | null;
}

/**
 * The hierarchy (C1): the chat's saved mode, else the project's default, else the user's, else the
 * provider's fallback — or its reading mode, where the account cannot use the fallback (C44). A
 * choice is whatever the provider lists under that id, usable or not: an unavailable one stands,
 * and blocks, since nothing substitutes for a choice (C43). An id the provider does not list is no
 * choice. Null for a provider that declares no mode.
 */
export function resolveMode(capability: PermissionCapability | null, choices: ModeChoices, usable: (id: string) => boolean = () => true): ChatMode | null {
  if (capability === null || capability.modes.length === 0) return null;
  const listed = (id: string | null): id is string => id !== null && capability.modes.some((mode) => mode.id === id);
  if (listed(choices.saved)) return { id: choices.saved, source: 'chat' };
  if (listed(choices.project)) return { id: choices.project, source: 'project' };
  if (listed(choices.user)) return { id: choices.user, source: 'user' };
  const fallback = listed(capability.fallback) && usable(capability.fallback) ? capability.fallback : readingMode(capability)?.id ?? capability.fallback;
  return { id: fallback, source: 'fallback' };
}

// ── A change of mode (C2, C74, C75) ───────────────────────────────────────────────────────────

/**
 * How a chat's mode changes from one to another on a provider. `idle`: on the live process, with
 * nothing running, by a change the CLI confirms. `restart`: the process is closed, and the next
 * start opens one under the new mode, whose check confirms it.
 */
export const MODE_TRANSITIONS = ['idle', 'restart'] as const;
export type ModeTransition = (typeof MODE_TRANSITIONS)[number];

/** What the declared lists say of a change, for a control that words it before the press: an adapter's own answer is what main acts on. */
export function declaredTransition(capability: PermissionCapability | null, from: string | null, to: string): ModeTransition {
  const target = modeOf(capability, to);
  return target !== undefined && from !== null && target.transitionsFrom.includes(from) ? 'idle' : 'restart';
}

// ── The CLI's own sandbox setup (C60–C62, C72) ────────────────────────────────────────────────

/** What a CLI answers of its sandbox for an account. */
export const SANDBOX_READINESS = ['ready', 'not-configured', 'update-required'] as const;
export type SandboxReadiness = (typeof SANDBOX_READINESS)[number];

/**
 * Where an account's setup stands, in this run alone (C72). `starting`: the request was sent.
 * `waiting`: the CLI took it, and its completion is awaited with no clock of fat-g's. `failed`: the
 * CLI refused it or said it did not succeed. `completed`: the CLI said so, and a fresh process
 * confirmed it. `unknown`: fat-g did not hear its end — it may still be changing the machine.
 */
export const SANDBOX_SETUP_STATES = ['idle', 'starting', 'waiting', 'failed', 'completed', 'unknown'] as const;
export type SandboxSetupState = (typeof SANDBOX_SETUP_STATES)[number];

/** The CLI's own words for why a setup failed (C61). */
export const MAX_SETUP_ERROR = 500;

export interface SandboxSetupView {
  readonly state: SandboxSetupState;
  /** The CLI's reason, where a setup failed and it gave one. */
  readonly error: string | null;
  /** What a fresh process last answered, or null where none was asked or none answered. */
  readonly readiness: SandboxReadiness | null;
}

/** Whether a setup holds its account (C62): nothing of that account is sent meanwhile. */
export function setupHolds(setup: SandboxSetupView | null | undefined): boolean {
  return setup?.state === 'starting' || setup?.state === 'waiting';
}

export const SETUP_ACTIONS = ['start', 'stop-waiting'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

// ── fat-g's words (C3, C46, C55, C87) ─────────────────────────────────────────────────────────
// A mode's label and description are its provider's declaration; everything else said of a mode is
// worded here, for every provider. `provider` is the provider's display name.

/** Why an account cannot use a mode, with the mode's label. */
export function modeReasonWords(reason: ModeReason, label: string, provider: string): string {
  switch (reason) {
    case 'unvalidated':
      return `${label} has not been shown to work on this version of ${provider}.`;
    case 'needs-setup':
      return `${label} needs ${provider}’s sandbox, which this account does not have.`;
    case 'cli-refuses':
      return `This version of ${provider} takes ${label} only with a flag fat-g never passes.`;
    case 'platform':
      return `${label} is not available on this system.`;
    case 'pending':
      return `${label} is being checked on this account. It can be used once ${provider} has answered.`;
  }
}

export const MODE_WORDS = {
  /** The header's control while a plan's decision waits (M22b, C58): what it says, disabled. */
  /** While the chat's plan is under review or being revised (0029); a ready plan takes a change. */
  planPending: 'This chat’s plan is under review or being revised, so its mode is held until then.',
  source: { chat: 'this chat', project: 'project default', user: 'my default', fallback: 'fat-g’s default' } satisfies Record<ModeSource, string>,
  /** Beside a saved mode no process has confirmed yet (C75). */
  atNextPrompt: 'applies at the next prompt',
  /** On the chat's own mode, where its last start did not confirm it (C46, C104): choosing it again is another try. */
  tryAgain: 'The last start did not confirm it: choose it to try again',
  restarts: 'Restarts the session’s process',
  endsGrants: (count: number): string => `Ends this session’s ${count} ${count === 1 ? 'grant' : 'grants'}`,
  records: (provider: string): string => `Choosing it makes ${provider} record this folder as trusted in its own configuration`,
  unconfined: 'This account has no sandbox: every write asks, and an accepted one runs unconfined',
  temporary: 'The temporary folders are writable beside the project’s folder',
  otherRoots: (provider: string, count: number): string => `Your own ${provider} configuration adds ${count} writable ${count === 1 ? 'folder' : 'folders'}`,
  network: (provider: string): string => `Your own ${provider} configuration lets it reach the network`,
  useMyDefault: 'Use my default',
  defaultMode: 'Default mode',
  setUp: 'Set up',
  changeMode: 'Change mode',
  /** While a turn, a worker, an aside or a change runs (C2, C90). */
  busy: 'The mode can be changed once nothing is running.',
  /** A setup holds the account (C62). */
  settingUp: (provider: string): string => `${provider}’s sandbox is being set up for this account.`,
  /** The line a chat draws before the first turn under another mode (C83). */
  line: (label: string): string => `Mode: ${label}`,
} as const;

/** "Ask first · project default", "Edits ok · this chat" (C82). */
export function modeTitle(label: string, source: ModeSource): string {
  return `${label} · ${MODE_WORDS.source[source]}`;
}
