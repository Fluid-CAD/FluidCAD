/**
 * The density units a material may declare. The same four the Shape
 * Properties panel converts (`ui/src/ui/shape-properties-modal.ts`); the
 * factors here and there MUST agree so a mass computed on the server
 * matches the one the browser shows.
 */
export type DensityUnit = 'g/cm³' | 'kg/m³' | 'g/mm³' | 'lbs/in³';

export const DENSITY_UNITS: readonly DensityUnit[] = ['g/cm³', 'kg/m³', 'g/mm³', 'lbs/in³'];

export const DEFAULT_DENSITY_UNIT: DensityUnit = 'g/cm³';

/** Where a material in the merged list comes from. */
export type MaterialSource = 'builtin' | 'project';

export type Material = {
  /**
   * The key `.material(id)` refers to: `fluidcad-…` for a built-in, the
   * `fluidcad.json` `materials` map key for a project material.
   */
  id: string;
  name: string;
  density: number;
  densityUnit: DensityUnit;
  source: MaterialSource;
};

/**
 * One entry of the `materials` map in `fluidcad.json`, keyed by id:
 *
 *     { "materials": { "alloy-steel": { "name": "Alloy Steel", "density": 7.7, "densityUnit": "g/cm³" } } }
 *
 * `densityUnit` defaults to g/cm³. An entry reusing a built-in id overrides
 * that built-in.
 */
export type ProjectMaterial = {
  name: string;
  density: number;
  densityUnit?: DensityUnit;
};

export type ProjectMaterials = Record<string, ProjectMaterial>;

function builtin(id: string, name: string, density: number, densityUnit: DensityUnit = DEFAULT_DENSITY_UNIT): Material {
  return { id, name, density, densityUnit, source: 'builtin' };
}

export const MATERIALS: readonly Material[] = [
  builtin('fluidcad-steel-1020',     'Steel (AISI 1020)',       7.87),
  builtin('fluidcad-stainless-304',  'Stainless Steel (304)',   8.00),
  builtin('fluidcad-aluminum-6061',  'Aluminum 6061',           2.70),
  builtin('fluidcad-aluminum-1060',  'Aluminum 1060',           2.81),
  builtin('fluidcad-aluminum-7075',  'Aluminum 7075',           2.81),
  builtin('fluidcad-brass-c260',     'Brass (C260)',            8.53),
  builtin('fluidcad-copper',         'Copper',                  8.96),
  builtin('fluidcad-titanium-6al4v', 'Titanium Ti-6Al-4V',      4.43),
  builtin('fluidcad-cast-iron-gray', 'Cast Iron (Gray)',        7.15),
  builtin('fluidcad-bronze',         'Bronze',                  8.73),
  builtin('fluidcad-pc',             'Polycarbonate (PC)',      1.20),
  builtin('fluidcad-abs',            'ABS Plastic',             1.05),
  builtin('fluidcad-pla',            'PLA',                     1.24),
  builtin('fluidcad-nylon-pa6',      'Nylon (PA6)',             1.14),
  builtin('fluidcad-carbon-fiber',   'Carbon Fiber Composite',  1.55),
  builtin('fluidcad-pine',           'Wood (Pine)',             0.53),
  builtin('fluidcad-carbon-steel',   'Plain Carbon Steel',      0.098, 'lbs/in³'),
];

export function isDensityUnit(value: unknown): value is DensityUnit {
  return typeof value === 'string' && (DENSITY_UNITS as readonly string[]).includes(value);
}

/**
 * Convert a density in `unit` to canonical g/cm³. Same factors as the
 * Shape Properties panel (`densityToGcm3`), so both sides agree on a mass.
 */
export function densityToGcm3(value: number, unit: DensityUnit): number {
  switch (unit) {
    case 'kg/m³': {
      return value * 0.001;
    }
    case 'g/mm³': {
      return value * 1000;
    }
    case 'lbs/in³': {
      return value * 27.6799;
    }
    default: {
      return value;
    }
  }
}

/** Convert a canonical g/cm³ density back into `unit` for display. */
export function densityFromGcm3(gcm3: number, unit: DensityUnit): number {
  switch (unit) {
    case 'kg/m³': {
      return gcm3 / 0.001;
    }
    case 'g/mm³': {
      return gcm3 / 1000;
    }
    case 'lbs/in³': {
      return gcm3 / 27.6799;
    }
    default: {
      return gcm3;
    }
  }
}

/** A material's density in canonical g/cm³, whatever unit it declares. */
export function materialDensityGcm3(material: Material): number {
  return densityToGcm3(material.density, material.densityUnit);
}

/**
 * The built-ins merged with a project's `materials` map, built-ins first
 * in table order, project entries after in map order. A project entry
 * that reuses a built-in id REPLACES that built-in in place (same list
 * position, `source: 'project'`). Entries are taken as given — the server
 * validates the map when it reads `fluidcad.json` (a bad entry is a
 * config error, not a material) — except `densityUnit`, which defaults to
 * g/cm³ when missing.
 */
export function mergeMaterials(project?: ProjectMaterials | null): Material[] {
  const merged = new Map<string, Material>();
  for (const material of MATERIALS) {
    merged.set(material.id, material);
  }
  if (project) {
    for (const [id, entry] of Object.entries(project)) {
      merged.set(id, {
        id,
        name: entry.name,
        density: entry.density,
        densityUnit: entry.densityUnit ?? DEFAULT_DENSITY_UNIT,
        source: 'project',
      });
    }
  }
  return [...merged.values()];
}

/**
 * The material `.material(id)` names, or undefined for an id that is
 * neither a built-in nor in the project map. Callers treat undefined as a
 * warning ("Unknown material: <id>"), never a build failure.
 */
export function resolveMaterial(id: string, project?: ProjectMaterials | null): Material | undefined {
  if (project && Object.prototype.hasOwnProperty.call(project, id)) {
    const entry = project[id];
    return {
      id,
      name: entry.name,
      density: entry.density,
      densityUnit: entry.densityUnit ?? DEFAULT_DENSITY_UNIT,
      source: 'project',
    };
  }
  return MATERIALS.find(material => material.id === id);
}

/** The merged materials list — the built-ins alone without a project map. */
export function getMaterials(projectMaterials?: ProjectMaterials | null): Material[] {
  return mergeMaterials(projectMaterials);
}
