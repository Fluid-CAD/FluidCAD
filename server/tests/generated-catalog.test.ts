import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { listCandidateFiles } from '../src/part-catalog/walk.ts';
import { GeneratedCatalog } from '../src/part-catalog/generated.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';

// The part catalog over generated definitions (generators S4), on a real
// engine over a copy of fixtures/generated-workspace: a `definePart` of the
// spur feature in parts/, a `defineAssembly` of the crate generator in
// assemblies/ — beside an exported generator class. The scan lists each from
// its schema, with the URLs of the images it declares, and never builds it:
// the generator's layout and builds, and the feature's build, count every
// call. Only the packer's scan (`renderGenerated`) builds them. Rendering a
// module that exports a generator class never calls the class.

const FIXTURE = path.resolve(__dirname, 'fixtures/generated-workspace');

let root: string;
let host: LocalSceneHost;
let server: FluidCadServer;

const at = (rel: string) => path.join(root, rel).replace(/\\/g, '/');

type Counters = { __crateLayouts?: number; __crateBuilds?: number; __spurBuilds?: number };
const counters = globalThis as Counters;

function resetCounters(): void {
  counters.__crateLayouts = 0;
  counters.__crateBuilds = 0;
  counters.__spurBuilds = 0;
}

/** The fixture's code, with a counter at the top of each body a scan must not run. */
function instrument(rel: string, marks: [string, string][]): void {
  let source = fs.readFileSync(at(rel), 'utf8');
  for (const [anchor, counter] of marks) {
    expect(source).toContain(anchor);
    source = source.replace(anchor, `${anchor}\n    globalThis.${counter} = (globalThis.${counter} ?? 0) + 1;`);
  }
  fs.writeFileSync(at(rel), source);
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return (data?.result ?? []).flatMap((row: any) => (row.hasError ? [`${row.type}: ${row.errorMessage}`] : []));
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-generated-catalog-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  instrument('features/lib/crate.js', [['layout(g) {', '__crateLayouts'], ['static build(type, inputs, ctx) {', '__crateBuilds']]);
  instrument('features/spur.feature.js', [['buildTool() {', '__spurBuilds']]);
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(root);
});

afterAll(async () => {
  await host?.server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the part catalog lists generated definitions', () => {
  it('offers both modules as candidate files (the part prefilter reads definePart)', async () => {
    const files = (await listCandidateFiles(root)).map(file => file.path);
    expect(files).toContain('parts/spur.part.js');
    expect(files).toContain('assemblies/crate.assembly.js');
  });

  it('lists a definePart export from its schema, with its images by module, and builds nothing', async () => {
    resetCounters();
    const scan = await server.scanPartsInFile(at('parts/spur.part.js'));
    expect(scan?.errors).toEqual([]);
    expect(scan?.parts).toHaveLength(1);
    const entry = scan!.parts[0];
    expect(entry).toMatchObject({
      exportName: 'spurPart',
      partName: 'Spur gear',
      kind: 'value',
      rootId: '',
      objects: [],
      params: [],
      configurations: [],
      definitionKind: 'generated',
      assetModules: { definition: at('parts/spur.part.js'), class: at('features/spur.feature.js') },
    });
    expect(entry.schema).toMatchObject({
      kind: 'part',
      definitionKind: 'generated',
      id: 'spur',
      label: 'Spur gear',
      icon: '../features/icons/spur.svg',
      connectors: ['axis'],
      assetBase: { layout: 'class' },
    });
    expect(Object.keys(entry.schema!.params)).toEqual(['teeth', 'module', 'width', 'style']);
    expect(entry.assetUrls).toEqual({
      definition: {
        '../features/icons/spur.svg': GeneratedCatalog.assetUrl(at('parts/spur.part.js'), 'spurPart', 'definition', '../features/icons/spur.svg'),
      },
      class: {
        './img/spur.svg': GeneratedCatalog.assetUrl(at('parts/spur.part.js'), 'spurPart', 'class', './img/spur.svg'),
        './img/helical.svg': GeneratedCatalog.assetUrl(at('parts/spur.part.js'), 'spurPart', 'class', './img/helical.svg'),
      },
    });
    expect(entry.assetUrls!.definition['../features/icons/spur.svg'])
      .toMatch(/^api\/part-catalog\/asset\?file=.*&export=spurPart&base=definition&path=\.\.%2Ffeatures%2Ficons%2Fspur\.svg$/);
    expect(counters.__spurBuilds).toBe(0);
  });

  it('lists a defineAssembly export from its schema, skips the exported generator class, and runs no layout or build', async () => {
    resetCounters();
    const scan = await server.scanPartsInFile(at('assemblies/crate.assembly.js'));
    // The class export (`export { Crate }`) is a declaration: never called, never an error.
    expect(scan?.errors).toEqual([]);
    expect(scan?.parts).toEqual([]);
    expect(scan?.assemblies).toHaveLength(1);
    const entry = scan!.assemblies[0];
    expect(entry).toMatchObject({
      exportName: 'crate',
      kind: 'assembly',
      exportKind: 'value',
      assemblyName: 'Crate',
      instances: [],
      mates: [],
      objects: [],
      params: [],
      definitionKind: 'generated',
      assetModules: { definition: at('assemblies/crate.assembly.js'), class: at('features/lib/crate.js') },
    });
    expect(entry.schema).toMatchObject({ kind: 'assembly', id: 'crate', label: 'Crate', connectors: [] });
    expect(Object.keys(entry.schema!.params)).toEqual(['width', 'depth', 'height', 'finish']);
    expect(Object.keys(entry.assetUrls!.definition)).toEqual(['../features/icons/crate.svg']);
    expect(Object.keys(entry.assetUrls!.class)).toEqual(['./img/open.svg', './img/closed.svg']);
    expect(counters.__crateLayouts).toBe(0);
    expect(counters.__crateBuilds).toBe(0);
  });

  it('builds them only when the packer asks (renderGenerated), schema fields kept', async () => {
    resetCounters();
    const part = await server.scanPartsInFile(at('parts/spur.part.js'), 'mm', { renderGenerated: true });
    expect(part?.errors).toEqual([]);
    expect(part?.parts[0].rootId).not.toBe('');
    expect(part?.parts[0].objects.length).toBeGreaterThan(0);
    expect(part?.parts[0].definitionKind).toBe('generated');
    expect(counters.__spurBuilds).toBe(1);

    const assembly = await server.scanPartsInFile(at('assemblies/crate.assembly.js'), 'mm', { renderGenerated: true });
    expect(assembly?.errors).toEqual([]);
    const crate = assembly!.assemblies[0];
    expect(crate.instances.map((inst: any) => inst.name)).toEqual(['Base', 'Lid']);
    expect(crate.mates).toHaveLength(1);
    expect(crate.objects.filter((o: any) => o.hasError)).toEqual([]);
    expect(crate.schema?.id).toBe('crate');
    expect(counters.__crateLayouts).toBe(1);
    expect(counters.__crateBuilds).toBe(2);
  });
});

describe('a module that exports a generator class', () => {
  it('renders on its own without calling the class', async () => {
    const data = await server.processFile(at('assemblies/crate.assembly.js'));
    expect(server.getCompileError()).toBeNull();
    expect(errorsOf(data)).toEqual([]);
    expect(data?.assembly?.instances.map(inst => inst.name)).toEqual(['Base', 'Lid']);
  });
});

describe('the engine-owned rows of a render', () => {
  it('marks a generator\'s parts and records, and the definition sites, never the user\'s insert', async () => {
    const shop = [
      `import { insert } from 'fluidcad/core';`,
      `import { crate } from './assemblies/crate.assembly.js';`,
      `import { spurPart } from './parts/spur.part.js';`,
      ``,
      `const crate1 = insert(crate, { width: 60, finish: 'closed' }).name('crate1');`,
      `const gear1 = insert(spurPart, { teeth: 30 }).name('gear1');`,
      ``,
    ].join('\n');
    fs.writeFileSync(at('shop.assembly.js'), shop);
    const data = await server.processFile(at('shop.assembly.js'));
    expect(errorsOf(data)).toEqual([]);
    const occurrence = data!.assembly!.occurrences!.find(occ => occ.generated)!;
    expect(occurrence.generated).toEqual({ definition: 'crate', values: { width: 60, depth: 30, height: 20, finish: 'closed' } });
    const owned = data!.assembly!.instances.filter(inst => inst.owner === occurrence.occurrenceId);
    expect(owned.map(inst => inst.name)).toEqual(['Base', 'Lid']);
    const gear = data!.assembly!.instances.find(inst => inst.name === 'gear1')!;
    expect(gear.generated).toEqual({ definition: 'spur', values: { teeth: 30, module: 2, width: 10, style: 'spur' } });

    const rows = server.getGeneratedRows();
    // By row: the occurrence's parts and its joint; never the occurrence itself or the definePart insert.
    expect(rows.refusal({ row: owned[0].instanceId })?.message)
      .toBe(`'Base' is made by the generated assembly 'crate1' and is read-only: change it through the values of the insert that makes it.`);
    expect(rows.refusal({ row: data!.assembly!.mates[0].mateId })).not.toBeNull();
    expect(rows.refusal({ row: occurrence.occurrenceId })).toBeNull();
    expect(rows.refusal({ row: gear.instanceId })).toBeNull();
    // By statement: the user's inserts stay editable; the definitions' calls are the parts' rows.
    expect(rows.refusal({ location: occurrence.sourceLocation })).toBeNull();
    expect(rows.refusal({ location: gear.sourceLocation })).toBeNull();
    const partRow = (test: (object: any) => boolean) => data!.result.find((row: any) => row.type === 'part' && test(row.object));
    const template = partRow(object => !!object.generatedBy);
    expect(template.sourceLocation.filePath).toBe(at('assemblies/crate.assembly.js'));
    expect(rows.refusal({ location: template.sourceLocation })?.message)
      .toBe(`The parts of the generated assembly 'crate' (crate.assembly.js) are read-only: change them through the values of the insert that makes them.`);
    const variant = partRow(object => !!object.generated);
    expect(variant.sourceLocation.filePath).toBe(at('parts/spur.part.js'));
    expect(rows.refusal({ location: variant.sourceLocation })?.message)
      .toMatch(/^'Spur gear' is made by the generated part 'spur' \(spur\.part\.js\) and is read-only/);
  });
});
