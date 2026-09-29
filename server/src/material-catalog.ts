import { getMaterials, resolveMaterial, type Material } from '../../lib/dist/common/materials.js';
import { loadPreferences } from './preferences.ts';
import type { ProjectMaterial, ProjectMaterials } from './project-config.ts';

/** What adopting a picked material needs from the engine: the project map and a write into it. */
export type MaterialAdoptionHost = {
  getProjectMaterials(): ProjectMaterials | null;
  adoptProjectMaterial(id: string, entry: ProjectMaterial): string | null;
};

/**
 * The three tiers a material id resolves through, in the order a part's
 * `.material(id)` and the pick dialog see them: the built-ins, the project's
 * `fluidcad.json` map (which overrides a built-in with the same id), and the
 * user's global list from Settings → Materials. The global tier is a
 * catalog for picking only — the source never resolves against it: the
 * moment a global entry is picked for a part, it is copied into the project
 * map, so `fluidcad.json` carries exactly the custom materials the project
 * uses and a teammate's render resolves the same way.
 */
export class MaterialCatalog {
  /** The user's global map — read fresh, since the Settings dialog writes the file. */
  static async loadGlobal(): Promise<ProjectMaterials> {
    return (await loadPreferences()).materials;
  }

  /**
   * The merged list `GET /api/materials` answers: built-ins and project
   * entries as the lib merges them, then every global entry whose id
   * neither of those already has, flagged `source: 'global'`.
   */
  static merged(project: ProjectMaterials | null, global: ProjectMaterials): Material[] {
    const list = getMaterials(project);
    const known = new Set(list.map((m) => m.id));
    for (const [id, entry] of Object.entries(global)) {
      if (known.has(id)) {
        continue;
      }
      list.push({
        id,
        name: entry.name,
        density: entry.density,
        densityUnit: entry.densityUnit ?? 'g/cm³',
        source: 'global',
      });
    }
    return list;
  }

  /**
   * Before a pick is written into the source: an id that resolves through
   * neither the built-ins nor the project map, but is one of the user's
   * global materials, is copied into `fluidcad.json` first. Answers the
   * config path it wrote, or null when nothing needed copying (or no
   * workspace is open to copy into).
   */
  static async adoptForPick(host: MaterialAdoptionHost, id: string, loadGlobal = MaterialCatalog.loadGlobal): Promise<string | null> {
    if (resolveMaterial(id, host.getProjectMaterials()) !== undefined) {
      return null;
    }
    const global = await loadGlobal();
    if (!Object.prototype.hasOwnProperty.call(global, id)) {
      return null;
    }
    return host.adoptProjectMaterial(id, global[id]);
  }
}
