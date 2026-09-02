import { DEFAULT_LENGTH_UNIT, isLengthUnit } from './units';
import type { LengthUnit } from './units';

type Listener = (unit: LengthUnit) => void;

/**
 * The unit of the document currently on screen. Fed from the server's
 * `scene-rendered` message (main.ts) or by a viewing host that drives the
 * viewer directly (the hub). Everything that prints a length subscribes here
 * rather than reading the message itself. Defaults to mm, which is also what
 * an older server that omits the field means.
 */
class SceneUnitStore {
  current: LengthUnit = DEFAULT_LENGTH_UNIT;
  private listeners = new Set<Listener>();

  /** Unknown / missing values fall back to mm; listeners fire only on change. */
  set(unit: unknown): void {
    const next = isLengthUnit(unit) ? unit : DEFAULT_LENGTH_UNIT;
    if (next === this.current) {
      return;
    }
    this.current = next;
    for (const fn of this.listeners) {
      fn(next);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const sceneUnit = new SceneUnitStore();
