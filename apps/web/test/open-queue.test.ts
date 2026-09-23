import { describe, expect, it } from 'vitest';
import { createOpenQueue } from '../src/state/open-queue.js';

/** Fix round 1, item 13: an Open that arrives before the editor exists (the
 *  launch queue can deliver that early) is held and applied once it does,
 *  instead of being dropped. */
describe('open queue', () => {
  it('applies at once when the editor is already there', () => {
    const applied: string[] = [];
    const queue = createOpenQueue<string>();
    queue.setTarget((t) => applied.push(t));
    queue.deliver('a');
    expect(applied).toEqual(['a']);
  });

  it('holds an Open that arrives before the editor, and applies it when the editor arrives', () => {
    const applied: string[] = [];
    const queue = createOpenQueue<string>();
    queue.deliver('early');
    expect(applied).toEqual([]);
    queue.setTarget((t) => applied.push(t));
    expect(applied).toEqual(['early']);
    queue.setTarget((t) => applied.push(`again:${t}`)); // applied once, not replayed
    expect(applied).toEqual(['early']);
  });

  it('several early Opens: the last one wins (each replaces the whole document)', () => {
    const applied: string[] = [];
    const queue = createOpenQueue<string>();
    queue.deliver('first');
    queue.deliver('second');
    queue.setTarget((t) => applied.push(t));
    expect(applied).toEqual(['second']);
  });

  it('an Open while the editor is gone (unmounted) waits for the next one', () => {
    const applied: string[] = [];
    const queue = createOpenQueue<string>();
    queue.setTarget((t) => applied.push(`one:${t}`));
    queue.setTarget(null);
    queue.deliver('between');
    expect(applied).toEqual([]);
    queue.setTarget((t) => applied.push(`two:${t}`));
    expect(applied).toEqual(['two:between']);
  });
});
