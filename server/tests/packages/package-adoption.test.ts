import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { FeatureCatalog } from '../../src/feature-catalog/catalog.ts';
import { FeatureScanner } from '../../src/feature-catalog/scan.ts';
import { PackageAdoption } from '../../src/packages/package-adoption.ts';
import { PackagePinError } from '../../src/packages/package-pins.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import { getFeatureMeta } from '../../../lib/dist/index.js';
import { PackageProject } from './package-project.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';

// Stage P6 on the real engine: a library package the project doesn't pin is
// offered by the catalogs (K7). Using it pins it — `{ version, integrity }`
// in `fluidcad.json`, no file copied — and the next render loads it. Its
// feature's live builder (what a dialog's ghost constructs from) and its
// parts' scan (the Insert dialog's thumbnails) read the installed files
// before any pin exists.

/** A rectangle of four pinned lines, as a fully constrained sketch body. */
function rectangle(x: number, y: number, w: number, h: number): string {
  const [a, b, c, d] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => `[${p[0]}, ${p[1]}]`);
  return [
    `  const a = line(${a}, ${b}); const b = line(${b}, ${c}); const c = line(${c}, ${d}); const d = line(${d}, ${a});`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), ${a}); fix(b.start(), ${b}); fix(c.start(), ${c}); fix(d.start(), ${d});`,
  ].join('\n');
}

/** What a dialog's create writes: the package's standoff on a 40 × 30 × 5 plate. */
const MODEL = [
  `import { standoff } from '@acme/kit';`,
  `import { sketch, extrude, line, select } from 'fluidcad/core';`,
  `import { coincident, fix } from 'fluidcad/constraints';`,
  `import { face } from 'fluidcad/filters';`,
  ``,
  `sketch('xy', () => {`,
  rectangle(0, 0, 40, 30),
  `});`,
  `extrude(5);`,
  `const top = select(face().planar().onPlane('xy', 5));`,
  `standoff(top, { height: 12 });`,
  ``,
].join('\n');

type Row = { type: string; hasError?: boolean; errorMessage?: string };

let project: PackageProject;
let host: LocalSceneHost;
let server: FluidCadServer;

function render(): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(project.at('model.part.js'), MODEL);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
  }
}

beforeEach(async () => {
  project = new PackageProject('fluidcad-package-adoption-');
  project.write('model.part.js', MODEL);
  PackageManifests.forget();
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
});

afterEach(async () => {
  await host.server?.close();
  project.dispose();
});

describe('a library package used in a project', () => {
  it('is offered unpinned, pinned on use with no file copied, and then renders', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    await server.init(project.root);
    const catalog = new FeatureCatalog({
      workspacePath: project.root,
      scan: (absPath) => server.scanFeaturesInFile(absPath),
      hasLiveBuffer: (absPath) => server.hasLiveBuffer(absPath),
    });
    const entry = (await catalog.list())!.find(e => e.id === 'acme.standoff')!;
    expect(entry).toMatchObject({ modulePath: `${dir}/standoff.feature.js`, package: { name: '@acme/kit', version: '0.1.0', availability: 'library' } });

    // Before the pin, a statement importing the package is refused.
    await expect(quietly(() => render())).rejects.toThrow('`@acme/kit` is not a dependency of this project');

    expect(await catalog.adoptForUse(entry)).toEqual({ name: '@acme/kit', version: '0.1.0', integrity, pin: 'pinned' });
    expect(readProjectConfig(project.root).dependencies).toEqual({ '@acme/kit': { version: '0.1.0', integrity } });
    expect(fs.existsSync(project.at('packages'))).toBe(false);

    const rows = (await render())!.result as Row[];
    expect(rows.filter(row => row.hasError).map(row => `${row.type}: ${row.errorMessage}`)).toEqual([]);
    expect(rows.some(row => row.type === 'acme.standoff')).toBe(true);
    const pinned = (await catalog.list())!.find(e => e.id === 'acme.standoff')!;
    expect(pinned.package?.availability).toBe('dependency');
    // Adopting again writes nothing.
    const config = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    expect(await catalog.adoptForUse(pinned)).toBeNull();
    expect((await PackageAdoption.adoptForUse(project.root, '@acme/kit')).pin).toBe('unchanged');
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(config);
  });

  it('loads a library feature’s live builder, and scans a library part, before any pin', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    await server.init(project.root);
    const builder = await FeatureScanner.loadBuilder(host, (server as any).sceneManager, `${dir}/standoff.feature.js`, 'standoff');
    expect(typeof builder).toBe('function');
    expect(getFeatureMeta(builder as Function)?.id).toBe('acme.standoff');

    const scan = await server.scanPartsInFile(`${dir}/parts/spacer.part.js`, 'in');
    expect(scan!.errors).toEqual([]);
    expect(scan!.unit).toBe('in');
    expect(scan!.parts.map(part => [part.exportName, part.partName, part.kind])).toEqual([['spacer', 'Spacer', 'value']]);
    expect(readProjectConfig(project.root).dependencies ?? null).toBeNull();
  });

  it('never switches a pinned version as a side effect of use', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0');
    await project.install('@acme/kit', '0.2.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    expect((await PackageAdoption.adoptForUse(project.root, '@acme/kit')).version).toBe('0.1.0');
    await expect(PackageAdoption.adoptForUse(project.root, '@acme/kit', '0.2.0')).rejects.toThrow(PackagePinError);
    expect(readProjectConfig(project.root).dependencies).toEqual({ '@acme/kit': { version: '0.1.0', integrity } });
    expect(PackageAdoption.refusal(new PackagePinError('version-change', 'no'))).toEqual({ status: 409, reason: 'no', code: 'version-change' });
  });

  it('pins the newest library version when none is named, and refuses a package the library lacks', async () => {
    await project.install('@acme/kit', '0.1.0');
    const newer = await project.install('@acme/kit', '0.2.0');
    project.config(null);
    expect(await PackageAdoption.adoptForUse(project.root, '@acme/kit')).toMatchObject({ version: '0.2.0', integrity: newer.integrity, pin: 'pinned' });
    await expect(PackageAdoption.adoptForUse(project.root, '@acme/other')).rejects.toThrow("@acme/other isn't in your library — install it from a file.");
  });
});
