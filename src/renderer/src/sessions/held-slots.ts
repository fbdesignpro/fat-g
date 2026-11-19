// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** A leaving session's place: its id, and the id drawn just before it in its list when it left — a capsule's or another slot's — or null when it was first. */
export interface HeldPlace {
  readonly id: string;
  readonly after: string | null;
}

/**
 * A part's ids as drawn while some sessions' slots hold their places (the Done effect): the part's
 * own ids, and each held place that has left it put back after the id it followed — once that one
 * is placed, when it is a slot too. A place whose neighbour is gone from the list goes last. The
 * part is in stored order, and a session marked done has moved to another list in the records, so
 * its place is known only from what was drawn when it left.
 */
export function withHeldSlots(current: readonly string[], held: readonly HeldPlace[]): readonly string[] {
  const out = [...current];
  let waiting = held.filter((place) => !out.includes(place.id));
  while (waiting.length > 0) {
    const ready = waiting.filter((place) => place.after === null || out.includes(place.after));
    if (ready.length === 0) {
      const [lost, ...others] = waiting;
      if (lost !== undefined) out.push(lost.id);
      waiting = others;
      continue;
    }
    for (const place of ready) out.splice(place.after === null ? 0 : out.indexOf(place.after) + 1, 0, place.id);
    waiting = waiting.filter((place) => !ready.includes(place));
  }
  return out;
}
