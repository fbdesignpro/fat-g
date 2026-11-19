// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The frame recorder (C9, C16): every kept frame with its index, direction and milliseconds since
// spawn. Token-level deltas are never requested; any the CLI sends anyway are counted by type and
// not stored anywhere, raw output included.
export class Recorder {
  /**
   * `isDelta(frame)` names a delta frame; `typeOf(frame)` gives the frame's type key for counts.
   * `clock()` gives milliseconds since spawn.
   */
  constructor({ isDelta = () => false, typeOf = () => 'frame', clock }) {
    this.isDelta = isDelta;
    this.typeOf = typeOf;
    this.clock = clock;
    this.frames = [];
    this.deltas = { requested: false, dropped: 0, byType: {} };
    this.garbageLines = [];
  }

  /** Returns the frame's index, or null for a dropped delta. */
  record(direction, frame) {
    if (direction === 'recv' && this.isDelta(frame)) {
      const type = this.typeOf(frame);
      this.deltas.dropped++;
      this.deltas.byType[type] = (this.deltas.byType[type] ?? 0) + 1;
      return null;
    }
    const index = this.frames.length;
    this.frames.push({ index, dir: direction, ms: this.clock(), frame });
    return index;
  }

  garbage(text) { this.garbageLines.push({ ms: this.clock(), text }); }

  /** Frame type keys seen, with counts. */
  typeCounts() {
    const counts = {};
    for (const { frame } of this.frames) {
      const type = this.typeOf(frame);
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }
}
