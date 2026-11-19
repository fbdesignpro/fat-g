// What tests read of the long-conversation fixture (./long-conversation.mjs; M19, C52), which is
// plain JavaScript with no import so that Node, the page and the demo source's stream form all run it.

/** A message's bound, in UTF-16 units. */
export const BOUND: number;
export const TURNS: number;
export const MIXED_UNITS: number;
/** How deep the nested message's lists and quotes go. */
export const NESTING: number;

/** Turn `n` of the conversation, 1 to `TURNS`: a prompt as it was typed, and an answer in Markdown. */
export function turn(n: number): { readonly prompt: string; readonly answer: string };
/** The items of the newest `turns` turns, oldest first: a prompt, then its answer. */
export function items(turns: number, total?: number): { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string }[];
/** The static message at the bound. */
export function largeMessage(): string;
/** Lists and quotes, each nested `depth` deep. */
export function nestedMessage(depth?: number): string;

export type StreamKind = 'mixed' | 'fence' | 'table';
export const STREAMS: readonly StreamKind[];
/** The whole text one of the three streams grows to. */
export function streamText(kind: StreamKind): string;

/** Small texts whose drawing is looked at, not timed. */
export const PROBES: Readonly<Record<'bareUrl' | 'footnote' | 'link' | 'image' | 'rawHtml' | 'taskList' | 'unclosedFence', string>>;
/** A late definition: the text before it arrives, and what arrives. */
export const LATE: { readonly before: string; readonly after: string };

// ── M20a (C44) ──
/** A turn's group of activity: this many items, one in ten with an output at the bound. */
export const ACTIVITIES: number;
/** An output's bound, in UTF-16 units. */
export const OUTPUT_BOUND: number;
/** One thing a turn did: what it was given, and what it returned. */
export interface FixtureActivity {
  readonly id: string;
  readonly type: 'read' | 'search' | 'command';
  readonly name: string;
  readonly summary: string;
  readonly input: string;
  readonly output: string;
  readonly file: string | null;
  readonly exitCode: number | null;
}
/** What turn `n` did between its prompt and its answer, in order. */
export function activities(n: number): FixtureActivity[];
/** What a worker's answer grows to. */
export function workerText(): string;
export type WorkStream = 'tools' | 'worker';
/** The two streams that hold activity: a prompt plays one only by its name. */
export const ACTIVITY_STREAMS: readonly WorkStream[];
