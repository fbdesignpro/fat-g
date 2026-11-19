// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { NdjsonDecoder, type OversizedLine, PEEK_BYTES, peekLine, SESSION_LINE_BYTES } from './ndjson';
describe('NDJSON byte framing', () => {
  it.each([1, 8, 32, 80])('uses a bounded per-line allowance and resets it after a line split at %i', (split) => {
    const values: unknown[] = []; const dropped: OversizedLine[] = []; const heads: number[] = [];
    const decoder = new NdjsonDecoder((value) => values.push(value), undefined, 32, (line) => dropped.push(line), (head) => {
      heads.push(head.length);
      return new TextDecoder().decode(head).startsWith('{"id":1,') ? 256 : undefined;
    });
    const large = new TextEncoder().encode(`${JSON.stringify({ id: 1, result: 'x'.repeat(100) })}\n`);
    decoder.push(large.subarray(0, split)); decoder.push(large.subarray(split));
    decoder.push(new TextEncoder().encode(`${JSON.stringify({ id: 2, result: 'y'.repeat(100) })}\n`));
    decoder.end();
    expect(values).toEqual([{ id: 1, result: 'x'.repeat(100) }]);
    expect(dropped).toHaveLength(1);
    expect(heads.every((length) => length <= PEEK_BYTES)).toBe(true);
  });

  const bytes = new TextEncoder().encode('\uFEFF\r\n{"text":"é🐈"}\r\n\nfalse\nnull');
  it.each(Array.from({ length: bytes.length + 1 }, (_, i) => i))('handles a split at byte %i', (split) => {
    const values: unknown[] = [];
    const decoder = new NdjsonDecoder((v) => values.push(v));
    decoder.push(bytes.subarray(0, split)); decoder.push(bytes.subarray(split)); decoder.end(); decoder.end();
    expect(values).toEqual([{ text: 'é🐈' }, false, null]);
  });
  it('skips malformed lines without retaining them', () => {
    const values: unknown[] = []; let bad = 0;
    const decoder = new NdjsonDecoder((v) => values.push(v), () => bad++);
    decoder.push(new TextEncoder().encode('secret\n1\n\uFEFF2\n')); decoder.end();
    expect(values).toEqual([1]); expect(bad).toBe(2);
  });
  it('enforces exact byte cap and a cap without newline', () => {
    const decoder = new NdjsonDecoder(() => {}, () => {}, 4);
    decoder.push(new TextEncoder().encode('null\n1234'));
    expect(() => decoder.push(new Uint8Array([32]))).toThrow('protocol-error');
  });
  it('drops a line over the cap to its newline, once, and keeps none of it, when asked to (M15, C19)', () => {
    const values: unknown[] = []; let dropped = 0; let bad = 0;
    const decoder = new NdjsonDecoder((v) => values.push(v), () => bad++, 8, () => dropped++);
    const encode = (text: string) => new TextEncoder().encode(text);
    // The long line arrives in three chunks; what follows its newline is the next line.
    decoder.push(encode('1\n"aaaaaaaa')); decoder.push(encode('bbbbbbbbbbbbbbbb')); decoder.push(encode('cc"\n2\n"dddddddddddd"\n3'));
    decoder.end();
    expect(values).toEqual([1, 2, 3]); expect(dropped).toBe(2); expect(bad).toBe(0);
  });
  it('drops an oversized line that never ends, and a line at the cap exactly is taken', () => {
    const values: unknown[] = []; let dropped = 0;
    const decoder = new NdjsonDecoder((v) => values.push(v), () => {}, 4, () => dropped++);
    decoder.push(new TextEncoder().encode('null\n12345678')); decoder.push(new TextEncoder().encode('9999')); decoder.end();
    expect(values).toEqual([null]); expect(dropped).toBe(1);
  });
  it('takes a line of up to 4 MiB at a session’s limit, where the default drops one over 1 MiB, and drops one over it (M20a, C16)', () => {
    expect(SESSION_LINE_BYTES).toBe(4 * 1024 * 1024);
    // An output of a megabyte made mostly of quotes, backslashes and newlines: JSON's escaping doubles it on the line.
    const output = '"\\\n'.repeat(Math.floor((1024 * 1024) / 3));
    const line = new TextEncoder().encode(`${JSON.stringify({ item: { aggregatedOutput: output } })}\n`);
    expect(line.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(line.byteLength).toBeLessThan(SESSION_LINE_BYTES);
    const run = (limit: number | undefined, bytes: Uint8Array): { values: number; dropped: number } => {
      let values = 0; let dropped = 0;
      const decoder = new NdjsonDecoder(() => { values += 1; }, () => {}, limit, () => { dropped += 1; });
      // In chunks, as a pipe gives them.
      for (let start = 0; start < bytes.byteLength; start += 65_536) decoder.push(bytes.subarray(start, start + 65_536));
      decoder.push(new TextEncoder().encode('7\n'));
      return { values, dropped };
    };
    expect(run(undefined, line)).toEqual({ values: 1, dropped: 1 });
    expect(run(SESSION_LINE_BYTES, line)).toEqual({ values: 2, dropped: 0 });
    const over = new Uint8Array(SESSION_LINE_BYTES + 64).fill(120);
    over[over.byteLength - 1] = 10;
    expect(run(SESSION_LINE_BYTES, over)).toEqual({ values: 1, dropped: 1 });
  });

  it('rejects malformed UTF8 and incomplete UTF8 at EOF', () => {
    for (const bytes of [[255, 10], [0xc3]]) {
      const decoder = new NdjsonDecoder(() => {});
      expect(() => { decoder.push(new Uint8Array(bytes)); decoder.end(); }).toThrow('protocol-error');
    }
  });
});

// ── A line over the limit, read for its kind and its id alone (M22, V3; C67, C71) ─────────────
describe('a line over the limit (M22, C67)', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const peek = (text: string, size = 5_000_000) => peekLine({ peek: encode(text).subarray(0, PEEK_BYTES), size }, { methods: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'], types: ['control_request'] });

  it('hands `oversized` the line’s first bytes and its size, once, at the line’s end, and keeps nothing after', () => {
    const seen: OversizedLine[] = [];
    const values: unknown[] = [];
    const decoder = new NdjsonDecoder((value) => values.push(value), () => {}, 64, (line) => seen.push(line));
    const long = `{"method":"item/fileChange/requestApproval","id":7,"params":{"pad":"${'x'.repeat(2_000)}"}}`;
    // In three chunks, as a pipe gives them: nothing is said until the newline has come.
    decoder.push(encode(`1\n${long.slice(0, 40)}`));
    decoder.push(encode(long.slice(40, 900)));
    expect(seen).toEqual([]);
    decoder.push(encode(`${long.slice(900)}\n2\n`));
    expect(values).toEqual([1, 2]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.size).toBe(encode(long).byteLength);
    expect(seen[0]?.peek.byteLength).toBe(PEEK_BYTES);
    expect(new TextDecoder().decode(seen[0]?.peek)).toBe(long.slice(0, PEEK_BYTES));
  });

  it('says one that never ends at the stream’s end, with what came of it', () => {
    const seen: OversizedLine[] = [];
    const decoder = new NdjsonDecoder(() => {}, () => {}, 8, (line) => seen.push(line));
    const unended = encode('{"id":1,"x":"aaaaaaaaaaaa');
    decoder.push(unended);
    decoder.end();
    expect(seen.map((line) => line.size)).toEqual([unended.byteLength]);
  });

  it.each<[string, string, ReturnType<typeof peek>]>([
    ['a JSON-RPC request with a number for its id', '{"method":"item/fileChange/requestApproval","id":7,"params":{"threadId":"t"}}', { request: 'yes', id: { kind: 'number', value: 7 }, size: 5_000_000 }],
    ['one with a string of the same spelling', '{"method":"item/fileChange/requestApproval","id":"7","params":{}}', { request: 'yes', id: { kind: 'string', value: '7' }, size: 5_000_000 }],
    ['one whose id comes first', '{"id":0,"method":"item/commandExecution/requestApproval","params":{}}', { request: 'yes', id: { kind: 'number', value: 0 }, size: 5_000_000 }],
    ['a request whose id is not where it is read', '{"method":"item/fileChange/requestApproval","params":{"id":9}}', { request: 'yes', id: null, size: 5_000_000 }],
    ['a notification, which waits for nothing', '{"method":"item/completed","params":{"item":{"id":"call_1"}}}', { request: 'no', id: null, size: 5_000_000 }],
    ['a method that is none of the caller’s requests', '{"method":"mcpServer/elicitation/request","id":3,"params":{}}', { request: 'no', id: null, size: 5_000_000 }],
    ['a stream-json request', '{"type":"control_request","request_id":"req_1","request":{"subtype":"can_use_tool","tool_name":"Write"}}', { request: 'yes', id: { kind: 'string', value: 'req_1' }, size: 5_000_000 }],
    ['a stream-json request whose id is past the first nested value', '{"type":"control_request","request":{"subtype":"can_use_tool","request_id":"inner"},"request_id":"req_1"}', { request: 'yes', id: null, size: 5_000_000 }],
    ['a stream-json frame that is no request', '{"type":"assistant","message":{"content":[]}}', { request: 'no', id: null, size: 5_000_000 }],
    ['a line whose kind cannot be read', '{"params":{"method":"item/fileChange/requestApproval","id":4}}', { request: 'maybe', id: null, size: 5_000_000 }],
    ['what is no object at all', '"a long string, and no line either CLI writes"', { request: 'maybe', id: null, size: 5_000_000 }],
  ])('reads %s', (_name, line, expected) => {
    expect(peek(line)).toEqual(expected);
  });

  it('reads nothing inside a payload: a key of the same name in a nested value is not the line’s own', () => {
    expect(peek('{"params":{"type":"control_request","request_id":"req_9"}}')).toEqual({ request: 'maybe', id: null, size: 5_000_000 });
    expect(peek('{"type":"user","message":{"type":"control_request","request_id":"req_9"}}')).toEqual({ request: 'no', id: null, size: 5_000_000 });
  });

  it('takes an id for a number only where it is one whole number, and an escaped string as it was written', () => {
    expect(peek('{"method":"item/fileChange/requestApproval","id":1.5,"params":{}}').id).toBeNull();
    expect(peek('{"method":"item/fileChange/requestApproval","id":"a\\"b\\u00e9","params":{}}').id).toEqual({ kind: 'string', value: 'a"bé' });
    expect(peek('{"method":"item/fileChange/requestApproval","id":-3,"params":{}}').id).toEqual({ kind: 'number', value: -3 });
  });

  it('reads no more than its first bytes, whatever it is handed', () => {
    const pad = ' '.repeat(PEEK_BYTES);
    expect(peekLine({ peek: encode(`${pad}{"type":"control_request","request_id":"late"}`), size: 9 }, { types: ['control_request'] })).toEqual({ request: 'maybe', id: null, size: 9 });
  });

  // M22b (V3; C61, C79): a tool's name, read in the request's own keys and nowhere in its input.
  describe('the one field of a request’s own object it is asked for (M22b, C79)', () => {
    const named = (text: string) => peekLine({ peek: encode(text).subarray(0, PEEK_BYTES), size: 9 }, { types: ['control_request'], name: { object: 'request', field: 'tool_name' } });

    it('reads the tool’s name where the CLI writes it, before the input', () => {
      const plan = `{"type":"control_request","request_id":"req_2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"${'p'.repeat(4_000)}"}}}`;
      expect(named(plan)).toEqual({ request: 'yes', id: { kind: 'string', value: 'req_2' }, size: 9, name: 'ExitPlanMode' });
    });

    it('takes no key inside the input for the request’s own, and none of another object', () => {
      expect(named('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","input":{"tool_name":"ExitPlanMode"}}}').name).toBeNull();
      expect(named('{"type":"control_request","request_id":"r","other":{"tool_name":"ExitPlanMode"},"request":{"subtype":"can_use_tool"}}').name).toBeNull();
      expect(named('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Write","input":{}}}').name).toBe('Write');
    });

    it('is not read where the caller names no field', () => {
      expect(peek('{"type":"control_request","request_id":"r","request":{"tool_name":"ExitPlanMode"}}')).not.toHaveProperty('name');
    });
  });
});
