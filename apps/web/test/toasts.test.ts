import { describe, expect, it } from 'vitest';
import { createToasts, TOAST_TTL_MS, VISIBLE_TOASTS } from '../src/state/toasts.js';
import { createFakeClock } from './fake-schedule.js';

describe('toasts (DD-08 §11)', () => {
  it('an info toast shows until its time to live runs out', () => {
    const clock = createFakeClock();
    const toasts = createToasts(clock.schedule);
    toasts.push('Opened the shared diagram as a new document.');
    clock.advance(1000);
    toasts.push('Link copied.');
    expect(toasts.items.value.map((t) => [t.kind, t.message])).toEqual([
      ['info', 'Opened the shared diagram as a new document.'],
      ['info', 'Link copied.'],
    ]);
    clock.advance(TOAST_TTL_MS - 1000);
    expect(toasts.items.value.map((t) => t.message)).toEqual(['Link copied.']);
    clock.advance(1000);
    expect(toasts.items.value).toEqual([]);
  });

  it('an error toast is never dismissed by time: it stays until closed (fix round 1, item 10)', () => {
    const clock = createFakeClock();
    const toasts = createToasts(clock.schedule);
    const id = toasts.push('This share link is not valid', 'error');
    toasts.push('Link copied.');
    expect(clock.pendingCount()).toBe(1); // only the info toast has a timer
    clock.advance(10 * TOAST_TTL_MS);
    expect(toasts.items.value.map((t) => [t.kind, t.message])).toEqual([['error', 'This share link is not valid']]);
    toasts.dismiss(id);
    expect(toasts.items.value).toEqual([]);
  });

  it('dismiss removes one early and cancels its timer', () => {
    const clock = createFakeClock();
    const toasts = createToasts(clock.schedule);
    const id = toasts.push('a');
    toasts.push('b');
    toasts.dismiss(id);
    expect(toasts.items.value.map((t) => t.message)).toEqual(['b']);
    expect(clock.pendingCount()).toBe(1);
  });

  describe('at most three on screen (F13)', () => {
    it('the newest three show; older ones wait behind them, none dropped', () => {
      const clock = createFakeClock();
      const toasts = createToasts(clock.schedule);
      expect(VISIBLE_TOASTS).toBe(3);
      for (const n of [1, 2, 3, 4, 5]) toasts.push(`error ${n}`, 'error');
      expect(toasts.visible.value.map((t) => t.message)).toEqual(['error 3', 'error 4', 'error 5']);
      expect(toasts.hidden.value).toBe(2);
      // Error toasts still stay until closed: all five are kept.
      clock.advance(10 * TOAST_TTL_MS);
      expect(toasts.items.value).toHaveLength(5);
    });

    it('closing a shown one brings the next older one back', () => {
      const clock = createFakeClock();
      const toasts = createToasts(clock.schedule);
      const ids = [1, 2, 3, 4].map((n) => toasts.push(`error ${n}`, 'error'));
      toasts.dismiss(ids[3]!);
      expect(toasts.visible.value.map((t) => t.message)).toEqual(['error 1', 'error 2', 'error 3']);
      expect(toasts.hidden.value).toBe(0);
    });

    it('under the cap nothing is held back', () => {
      const toasts = createToasts(createFakeClock().schedule);
      toasts.push('a', 'error');
      toasts.push('b');
      expect(toasts.visible.value.map((t) => t.message)).toEqual(['a', 'b']);
      expect(toasts.hidden.value).toBe(0);
    });

    it('dismissAll closes every toast, shown or held, and cancels their timers', () => {
      const clock = createFakeClock();
      const toasts = createToasts(clock.schedule);
      for (const n of [1, 2, 3]) toasts.push(`error ${n}`, 'error');
      toasts.push('info 1');
      toasts.push('info 2');
      expect(clock.pendingCount()).toBe(2);
      toasts.dismissAll();
      expect(toasts.items.value).toEqual([]);
      expect(toasts.visible.value).toEqual([]);
      expect(toasts.hidden.value).toBe(0);
      expect(clock.pendingCount()).toBe(0);
    });
  });
});
