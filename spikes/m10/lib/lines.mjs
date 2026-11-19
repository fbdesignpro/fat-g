// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Newline-delimited JSON off a child's stdout. A line that is not JSON is counted and kept aside
// (raw output only); it is never fatal.
const MAX_LINE = 16 * 1024 * 1024;

export function decodeLines(stream, onFrame, { onGarbage = () => {} } = {}) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const flush = (line) => {
    const text = line.replace(/\r$/, '').replace(/^﻿/, '');
    if (!text.trim()) return;
    let frame;
    try { frame = JSON.parse(text); } catch { onGarbage(text.slice(0, 500)); return; }
    onFrame(frame);
  };
  stream.on('data', (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      flush(line);
    }
    if (buffer.length > MAX_LINE) { onGarbage(`<line over ${MAX_LINE} bytes dropped>`); buffer = ''; }
  });
  stream.on('end', () => { buffer += decoder.decode(); if (buffer) flush(buffer); buffer = ''; });
}

export const writeFrame = (stdin, frame) => new Promise((resolve, reject) => {
  if (!stdin || stdin.destroyed || stdin.writableEnded) { reject(new Error('stdin closed')); return; }
  stdin.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : resolve()));
});
