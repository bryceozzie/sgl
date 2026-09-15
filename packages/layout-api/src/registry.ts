import type { LayoutEngine } from './contract.js';
import { LAYOUT_API_VERSION } from './contract.js';

/** The set of engines the host may run. MVP registers the two built-ins;
 *  ⟶ B17 adds third-party registration behind the iframe sandbox. */
export class EngineRegistry {
  readonly #engines = new Map<string, LayoutEngine>();

  register(engine: LayoutEngine): void {
    if (engine.apiVersion !== LAYOUT_API_VERSION) {
      throw new Error(
        `Engine ${engine.id} targets layout API version ${String(engine.apiVersion)}; this host implements ${LAYOUT_API_VERSION}.`,
      );
    }
    this.#engines.set(engine.id, engine);
  }

  get(id: string): LayoutEngine | undefined {
    return this.#engines.get(id);
  }

  /** Sorted by id, so the picker order is deterministic (DD-00 §3). */
  list(): readonly LayoutEngine[] {
    return [...this.#engines.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/** The default engine (ADR-0005). */
export const DEFAULT_ENGINE_ID = 'sgl.elk';
