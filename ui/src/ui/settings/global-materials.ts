import type { ProjectMaterials, UserPreferences } from '../../api';

/**
 * The user's own materials — Settings → Materials, persisted in the
 * preferences file as a `fluidcad.json`-shaped map. The page keeps a copy so
 * the pick lists (Set material…, the properties panel's dropdown) can show
 * them without a round trip, and the Settings tab edits a draft of it.
 * Picking one for a part copies the entry into that project's
 * `fluidcad.json`; nothing here is read when a model renders.
 */
type Listener = (materials: ProjectMaterials) => void;

class GlobalMaterialsStore {
  current: ProjectMaterials = {};
  private listeners = new Set<Listener>();

  /** Replace the whole map (a copy is kept, so a caller's draft stays its own). */
  update(materials: ProjectMaterials): void {
    this.current = GlobalMaterialsStore.copyOf(materials);
    for (const fn of this.listeners) {
      fn(this.current);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A deep copy in map order — entries are small plain records. */
  static copyOf(materials: ProjectMaterials): ProjectMaterials {
    const copy: ProjectMaterials = {};
    for (const [id, entry] of Object.entries(materials)) {
      copy[id] = { ...entry };
    }
    return copy;
  }

  /** Whether two maps hold the same entries in the same order. */
  static equal(a: ProjectMaterials, b: ProjectMaterials): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

export const globalMaterials = new GlobalMaterialsStore();
export { GlobalMaterialsStore };

export function applyGlobalMaterialsPreferences(prefs: UserPreferences): void {
  globalMaterials.update(prefs.materials && typeof prefs.materials === 'object' ? prefs.materials : {});
}
