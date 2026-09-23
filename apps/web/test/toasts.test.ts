import { describe, expect, it } from 'vitest';
import { createToasts, TOAST_TTL_MS } from '../src/state/toasts.js';
import { createFakeClock } from './fake-schedule.js';

describe('toasts (DD-08 §11)', () => {
  it('push shows a toast until its time to live runs out', () => {
    const clock = createFakeClock();
    const toasts = createToasts(clock.schedule);
    toasts.push('This share link is not valid', 'error');
    clock.advance(1000);
    toasts.push('Link copied.');
    expect(toasts.items.value.map((t) => [t.kind, t.message])).toEqual([
      ['error', 'This share link is not valid'],
      ['info', 'Link copied.'],
    ]);
    clock.advance(TOAST_TTL_MS - 1000);
    expect(toasts.items.value.map((t) => t.message)).toEqual(['Link copied.']);
    clock.advance(1000);
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
});
