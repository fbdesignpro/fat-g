// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure } from './process';

/**
 * A session's line limit, on both providers (M20a, C16): 4 MiB. An output the CLI cuts at 1 MiB
 * then arrives with its frame however JSON escapes it — a quote, a backslash and a newline each
 * double — and is cut to its own bound by the adapter. Every other connection keeps the default.
 */
export const SESSION_LINE_BYTES = 4 * 1024 * 1024;
/** Media-capable chat/history connections; small probes retain their own bounds. */
export const MEDIA_SESSION_LINE_BYTES = 32 * 1024 * 1024;

/** How much of a line over the limit is looked at (M22, C67): enough for the keys both CLIs write first, and nothing of what follows them. */
export const PEEK_BYTES = 512;

/** A line over the limit, as `oversized` is handed it (M22, C67): its first bytes, to be read for a kind and an id and dropped, and its size. */
export interface OversizedLine {
  readonly peek: Uint8Array;
  /** The whole line's, in bytes, its newline apart. */
  readonly size: number;
}

/** A request's id as its line wrote it: a number and a string of one spelling are two ids (M22, C10). */
export type PeekedId = { readonly kind: 'number'; readonly value: number } | { readonly kind: 'string'; readonly value: string };

/**
 * What a line over the limit is, as far as its first bytes say (M22, C67, C71). `request`: `yes`
 * for a kind that is one of the caller's requests, `no` for a kind read that is not, `maybe` where
 * no kind could be read. `id`: the request's id, where one could be read. `name` (M22b, C79): the
 * one field of the request's own object the caller names, where it could be read — a tool's name,
 * never its input. Nothing else is read.
 */
export interface PeekedLine {
  readonly request: 'yes' | 'no' | 'maybe';
  readonly id: PeekedId | null;
  readonly size: number;
  readonly name?: string | null;
}

/** What `peekLine` is told of its caller's protocol: which kinds are requests that wait for a reply. */
export interface PeekRules {
  /** JSON-RPC methods that are requests (they carry an `id`). */
  readonly methods?: readonly string[];
  /** Stream-json `type` values that are requests, their id under `request_id`. */
  readonly types?: readonly string[];
  /**
   * A stream-json request's object and the one field of it to read (M22b, C79): its keys before its
   * first nested value, as the line's own are read, so that nothing of a payload is taken for one.
   */
  readonly name?: { readonly object: string; readonly field: string };
}

const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const field = (name: string, value: string): RegExp => new RegExp(String.raw`"${name}"\s*:\s*${value}`);
const unquote = (raw: string): string | null => { try { const parsed: unknown = JSON.parse(`"${raw}"`); return typeof parsed === 'string' ? parsed : null; } catch { return null; } };

/**
 * A line over the limit, read for its kind and its request id alone (M22, C67): a bounded scan of
 * its first bytes, with no parse of the line. For a JSON-RPC line, `method` and `id`, as
 * `{"method":…,"id":…,"params":…}` is written; for a stream-json line, `type` and — for a request —
 * `request_id`, as `{"type":"control_request","request_id":…,"request":…}` is. Only what stands
 * before the first nested value is read, so nothing inside a request's payload is taken for a key.
 */
export function peekLine(line: OversizedLine, rules: PeekRules): PeekedLine {
  const { size } = line;
  const whole = new TextDecoder('utf-8', { fatal: false }).decode(line.peek.subarray(0, PEEK_BYTES));
  // The keys of the line's own object, up to its first nested value: a payload is never scanned.
  const start = whole.indexOf('{');
  if (start === -1) return { request: 'maybe', id: null, size };
  const nested = whole.slice(start + 1).search(/[{[]/);
  const head = nested === -1 ? whole.slice(start + 1) : whole.slice(start + 1, start + 1 + nested);
  const text = (name: string): string | null => { const found = field(name, QUOTED).exec(head); return found?.[1] === undefined ? null : unquote(found[1]); };
  const method = text('method');
  if (method !== null) {
    if (rules.methods?.includes(method) !== true) return { request: 'no', id: null, size };
    const number = field('id', String.raw`(-?\d{1,15})(?![\d.eE])`).exec(head);
    if (number?.[1] !== undefined) return { request: 'yes', id: { kind: 'number', value: Number(number[1]) }, size };
    const string = text('id');
    return { request: 'yes', id: string === null ? null : { kind: 'string', value: string }, size };
  }
  const type = text('type');
  if (type !== null) {
    if (rules.types?.includes(type) !== true) return { request: 'no', id: null, size };
    const id = text('request_id');
    return { request: 'yes', id: id === null ? null : { kind: 'string', value: id }, size, ...(rules.name === undefined ? {} : { name: innerField(whole.slice(start + 1), rules.name) }) };
  }
  return { request: 'maybe', id: null, size };
}

/**
 * One field of the object a line's key names (M22b, C79), where it opens before the line's first
 * nested value: read in that object's own keys, before its first nested value, and nowhere else.
 */
function innerField(after: string, rule: { readonly object: string; readonly field: string }): string | null {
  const opened = new RegExp(String.raw`^[^{[]*?"${rule.object}"\s*:\s*\{`).exec(after);
  if (opened === null) return null;
  const inner = after.slice(opened[0].length);
  const nested = inner.search(/[{[]/);
  const head = nested === -1 ? inner : inner.slice(0, nested);
  const found = field(rule.field, QUOTED).exec(head);
  return found?.[1] === undefined ? null : unquote(found[1]);
}

/**
 * Byte limits precede decoding/allocation. TextDecoder validates UTF-8 across chunk boundaries.
 *
 * A line over the limit throws, unless `oversized` is given (M15, C19): the line is then skipped to
 * its newline, none of it is kept but its first `PEEK_BYTES` (M22, C67), and `oversized` runs once
 * for it, at its end, with those bytes and its size.
 */
export class NdjsonDecoder {
  private parts: Uint8Array[] = [];
  private length = 0;
  private first = true;
  private ended = false;
  /** Inside a line that passed the limit: everything up to its newline is thrown away. */
  private skipping = false;
  /** Of the line being skipped: its first bytes, and how many it has had so far. */
  private peek: Uint8Array = new Uint8Array(0);
  private skipped = 0;
  private currentLimit: number;
  constructor(private readonly value: (value: unknown) => void, private readonly malformed: () => void = () => {}, private readonly limit = 1024 * 1024, private readonly oversized?: (line: OversizedLine) => void, private readonly limitForLine?: (head: Uint8Array) => number | undefined) { this.currentLimit = limit; }
  push(chunk: Uint8Array): void {
    if (this.ended) return;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      this.append(chunk.subarray(start, i));
      this.line();
      start = i + 1;
    }
    this.append(chunk.subarray(start));
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.skipping) { this.skip(); return; }
    if (this.length) this.line();
  }
  discard(): void { this.ended = true; this.parts = []; this.length = 0; this.peek = new Uint8Array(0); this.skipped = 0; }
  private append(bytes: Uint8Array): void {
    if (this.skipping) { this.skipped += bytes.length; return; }
    if (this.length + bytes.length > this.currentLimit && this.currentLimit === this.limit && this.limitForLine !== undefined) {
      const permitted = this.limitForLine(this.head(bytes));
      if (permitted !== undefined && Number.isSafeInteger(permitted) && permitted > this.limit) this.currentLimit = permitted;
    }
    if (this.length + bytes.length > this.currentLimit) {
      if (this.oversized === undefined) { this.discard(); throw new ProcessFailure('protocol-error'); }
      // Its first bytes are kept for the one look at them, and the rest is let go as it comes.
      this.peek = this.head(bytes);
      this.skipped = this.length + bytes.length;
      this.parts = []; this.length = 0; this.skipping = true; this.first = false;
      return;
    }
    if (bytes.length) { this.parts.push(bytes.slice()); this.length += bytes.length; }
  }
  private head(bytes: Uint8Array): Uint8Array {
    const head = new Uint8Array(Math.min(PEEK_BYTES, this.length + bytes.length));
    let offset = 0;
    for (const part of [...this.parts, bytes]) {
      if (offset >= head.length) break;
      const taken = part.subarray(0, head.length - offset);
      head.set(taken, offset);
      offset += taken.length;
    }
    return head;
  }
  /** The skipped line is over: `oversized` is told once, with its first bytes and its size, and nothing of it stays. */
  private skip(): void {
    const line: OversizedLine = { peek: this.peek, size: this.skipped };
    this.skipping = false; this.peek = new Uint8Array(0); this.skipped = 0;
    this.currentLimit = this.limit;
    this.oversized?.(line);
  }
  private line(): void {
    if (this.skipping) { this.skip(); return; }
    const bytes = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) { bytes.set(part, offset); offset += part.length; }
    this.parts = []; this.length = 0;
    this.currentLimit = this.limit;
    let line: string;
    try { line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { this.discard(); throw new ProcessFailure('protocol-error'); }
    if (this.first) { line = line.replace(/^\uFEFF/, ''); this.first = false; }
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { this.malformed(); return; }
    this.value(parsed);
  }
}
