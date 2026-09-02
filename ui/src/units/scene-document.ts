import type { LengthUnit } from './units';

export type SceneDocumentKind = 'part' | 'assembly';

export type SceneDocument = {
  /** Absolute path of the model the scene is rendered from. */
  absPath: string;
  kind: SceneDocumentKind;
  /**
   * The unit the file declares with `unit()`, or null when it declares none
   * and follows the project unit. Always null for an assembly.
   */
  declaredUnit: LengthUnit | null;
  /** The project unit (`fluidcad.json`, else mm) — what an undeclared file follows. */
  projectUnit: LengthUnit;
};

type Listener = (doc: SceneDocument | null) => void;

/**
 * Which document is on screen — the file, its kind, and how its unit came
 * about — fed from the server's `scene-rendered` message (main.ts). The
 * unit chip decides on it whether a unit pick rewrites the file (a part
 * declares `unit()`) or the project config (an assembly is measured in the
 * project unit), and which menu entry is the current one. Null until the
 * first render, and in viewing hosts that never set it.
 */
class SceneDocumentStore {
  current: SceneDocument | null = null;
  private listeners = new Set<Listener>();

  set(
    absPath: string | null | undefined,
    kind: SceneDocumentKind,
    declaredUnit: LengthUnit | null,
    projectUnit: LengthUnit,
  ): void {
    const next = absPath ? { absPath, kind, declaredUnit, projectUnit } : null;
    if (
      next?.absPath === this.current?.absPath
      && next?.kind === this.current?.kind
      && next?.declaredUnit === this.current?.declaredUnit
      && next?.projectUnit === this.current?.projectUnit
    ) {
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

export const sceneDocument = new SceneDocumentStore();
