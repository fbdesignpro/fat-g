// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The remaining original deterministic effects. Imported sounds and their notices stay untouched.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../assets/audio/', import.meta.url));
const rate = 44100;
const cues = {
  'right-click': [[380, 0.04], [510, 0.045]],
  'done': [[523.25, 0.075], [659.25, 0.075], [783.99, 0.16]],
  'question': [[587.33, 0.08], [783.99, 0.14]],
  'approval': [[440, 0.08], [554.37, 0.08], [440, 0.1]],
  'plan-ready': [[523.25, 0.08], [698.46, 0.12], [880, 0.12]],
  'review-ready': [[659.25, 0.08], [783.99, 0.08], [987.77, 0.14]],
  'error': [[349.23, 0.12], [261.63, 0.16]],
};
mkdirSync(root, { recursive: true });
for (const [name, notes] of Object.entries(cues)) {
  const samples = [];
  for (const [frequency, duration] of notes) {
    const count = Math.round(duration * rate);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      // Smooth attack and release prevent clicks. Peak amplitude stays below 0.14.
      const envelope = Math.sin(Math.PI * i / count) ** 2 * Math.exp(-t * 6);
      const wave = Math.sin(2 * Math.PI * frequency * t) + 0.15 * Math.sin(2 * Math.PI * frequency * 2 * t);
      samples.push(Math.round(32767 * 0.12 * envelope * wave));
    }
    samples.push(...Array(Math.round(0.012 * rate)).fill(0));
  }
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, 44 + i * 2));
  writeFileSync(path.join(root, `${name}.wav`), bytes);
}
console.log(`Generated ${Object.keys(cues).length} original audio effects.`);
