import { describe, expect, it } from 'vitest';
import { MaterialCatalog } from '../src/material-catalog.ts';

// The pick catalog's three tiers: built-ins, the project's fluidcad.json map
// (overriding a built-in with the same id), then the user's global list for
// the ids neither holds. A global entry never resolves a part's source —
// picking it copies it into the project first (adoptForPick).

const PROJECT = {
  'fluidcad-pla': { name: 'House PLA', density: 1.3 },
  'alloy-steel': { name: 'Alloy Steel', density: 7.7 },
};
const GLOBAL = {
  'alloy-steel': { name: 'Global Alloy Steel', density: 9 },
  'fluidcad-abs': { name: 'Global ABS', density: 2 },
  'acme-pla': { name: 'ACME PLA+', density: 1.27, densityUnit: 'kg/m³' as const },
};

describe('MaterialCatalog.merged', () => {
  it('appends only the global ids the built-ins and the project lack, in map order', () => {
    const list = MaterialCatalog.merged(PROJECT, GLOBAL);
    expect(list.find((m) => m.id === 'fluidcad-pla')).toMatchObject({ name: 'House PLA', source: 'project' });
    expect(list.find((m) => m.id === 'alloy-steel')).toMatchObject({ name: 'Alloy Steel', source: 'project' });
    expect(list.find((m) => m.id === 'fluidcad-abs')).toMatchObject({ name: 'ABS Plastic', source: 'builtin' });
    expect(list[list.length - 1]).toEqual({ id: 'acme-pla', name: 'ACME PLA+', density: 1.27, densityUnit: 'kg/m³', source: 'global' });
    expect(list.filter((m) => m.source === 'global')).toHaveLength(1);
  });

  it('defaults a global entry\'s unit to g/cm³ and copes with no project map', () => {
    const list = MaterialCatalog.merged(null, { pine: { name: 'Pine', density: 0.5 } });
    expect(list[list.length - 1]).toEqual({ id: 'pine', name: 'Pine', density: 0.5, densityUnit: 'g/cm³', source: 'global' });
  });
});

describe('MaterialCatalog.adoptForPick', () => {
  function host(project: Record<string, { name: string; density: number }> | null) {
    const adopted: { id: string; entry: unknown }[] = [];
    return {
      adopted,
      getProjectMaterials: () => project,
      adoptProjectMaterial: (id: string, entry: unknown) => {
        adopted.push({ id, entry });
        return '/ws/fluidcad.json';
      },
    };
  }

  it('copies a global entry the project lacks and answers the config path', async () => {
    const h = host(PROJECT);
    expect(await MaterialCatalog.adoptForPick(h, 'acme-pla', async () => GLOBAL)).toBe('/ws/fluidcad.json');
    expect(h.adopted).toEqual([{ id: 'acme-pla', entry: GLOBAL['acme-pla'] }]);
  });

  it('leaves a built-in, a project entry and an unknown id alone', async () => {
    const h = host(PROJECT);
    for (const id of ['fluidcad-abs', 'alloy-steel', 'unobtainium']) {
      expect(await MaterialCatalog.adoptForPick(h, id, async () => GLOBAL)).toBeNull();
    }
    expect(h.adopted).toEqual([]);
  });

  it('never resolves through the prototype chain', async () => {
    const h = host(null);
    expect(await MaterialCatalog.adoptForPick(h, 'toString', async () => ({}))).toBeNull();
    expect(h.adopted).toEqual([]);
  });
});
