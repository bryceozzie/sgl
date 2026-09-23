import type { Cancel, Schedule } from '../src/state/types.js';

/** A `Schedule` driven by hand: `advance(ms)` fires, in time order, every
 *  callback due by then — so debounce and time-to-live tests control the
 *  clock exactly instead of waiting on it. */
export interface FakeClock {
  readonly schedule: Schedule;
  readonly now: () => number;
  advance(ms: number): void;
  pendingCount(): number;
}

export function createFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const timers: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    schedule(fn, ms): Cancel {
      const timer = { at: now + ms, seq: (seq += 1), fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => now,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
      }
      now = until;
    },
    pendingCount: () => timers.filter((t) => !t.cancelled).length,
  };
}
