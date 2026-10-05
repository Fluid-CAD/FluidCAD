import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import { FeatureScanner, type FeatureScanSceneManager } from '../src/feature-catalog/scan.ts';
import { RawOcctUse } from '../src/feature-catalog/raw-occt.ts';

// Which custom features reach raw OpenCascade: read from the module's source
// and the workspace modules it imports — never evaluated — and recorded on
// the catalog entry the editor marks the feature by.

const FIXTURES = path.resolve(__dirname, 'fixtures/custom-features');

let root: string;
let workspace: string;

const at = (rel: string) => path.join(workspace, rel).replace(/\\/g, '/');

/** Write a file and move its mtime forward, so a same-tick rewrite still reads as changed. */
function write(rel: string, content: string): void {
  const file = at(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 2000 + Math.random() * 1000);
  fs.utimesSync(file, later, later);
}

/** A tool feature module whose `buildTool()` body is `body`, after `header`. */
function featureModule(id: string, exportName: string, header = '', body = 'return [];'): string {
  return [
    `import { Feature, defineFeature } from 'fluidcad/sdk';`,
    header,
    `class F extends Feature.with({ size: { type: 'length', default: 4 } }) {`,
    `  static id = '${id}';`,
    `  buildTool() { ${body} }`,
    `}`,
    `export const ${exportName} = defineFeature(F, { label: '${exportName}', group: 'create', call: ['size'] });`,
    ``,
  ].join('\n');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-raw-occt-'));
  workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(FIXTURES, 'standoff.feature.js'), at('standoff.feature.js'));
  fs.copyFileSync(path.join(FIXTURES, 'twist.feature.js'), at('twist.feature.js'));
  fs.copyFileSync(path.join(FIXTURES, 'dangling.feature.js'), at('dangling.feature.js'));
  write('geometry/helix.js', `import { getOC } from 'fluidcad/sdk/occt';\nexport const turns = () => getOC();\n`);
  write('geometry/index.js', `export { turns } from './helix.js';\n`);
  write('thread.feature.js', featureModule('acme.thread', 'thread', `import { turns } from './geometry';`, 'turns(); return [];'));
  write('lazy.feature.js', featureModule('acme.lazy', 'lazy', '', `void import('fluidcad/sdk/occt'); return [];`));
  write('reexport.js', `export * from 'fluidcad/sdk/occt';\n`);
  write('plain.feature.js', featureModule('acme.plain', 'plain',
    `// fluidcad/sdk/occt is only named in this comment\nconst note = 'fluidcad/sdk/occt';`,
    'const tool = { occ: () => [] }; return tool.occ();'));
  write('outside.feature.js', featureModule('acme.outside', 'outside', `import { nothing } from '../escape.js';`));
  fs.writeFileSync(path.join(root, 'escape.js'), `import 'fluidcad/sdk/occt';\nexport const nothing = 0;\n`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RawOcctUse: whether a module reaches raw OpenCascade, from its source', () => {
  it('sees an import of fluidcad/sdk/occt, a scope opened with this.occ(), a dynamic import and a re-export', async () => {
    expect((await RawOcctUse.scan(at('dangling.feature.js'), workspace)).usesOcct).toBe(true);
    expect((await RawOcctUse.scan(at('twist.feature.js'), workspace)).usesOcct).toBe(true);
    expect((await RawOcctUse.scan(at('lazy.feature.js'), workspace)).usesOcct).toBe(true);
    expect((await RawOcctUse.scan(at('reexport.js'), workspace)).usesOcct).toBe(true);
  });

  it('follows the workspace modules a feature imports, an extension and an index left off', async () => {
    const scan = await RawOcctUse.scan(at('thread.feature.js'), workspace);
    expect(scan).toEqual({
      usesOcct: true,
      files: [at('thread.feature.js'), at('geometry/index.js'), at('geometry/helix.js')],
    });
  });

  it('reads nothing into a comment, a string, another object\'s occ() or a module outside the workspace', async () => {
    expect(await RawOcctUse.scan(at('plain.feature.js'), workspace)).toEqual({ usesOcct: false, files: [at('plain.feature.js')] });
    expect((await RawOcctUse.scan(at('outside.feature.js'), workspace)).usesOcct).toBe(false);
    expect((await RawOcctUse.scan(at('standoff.feature.js'), workspace)).usesOcct).toBe(false);
  });
});

describe('the feature catalog discloses raw OpenCascade', () => {
  let host: LocalSceneHost;
  let catalog: FeatureCatalog;

  const manager: FeatureScanSceneManager = {
    startScene: () => ({}),
    setCurrentFile: () => {},
    disposeScene: () => {},
  };

  beforeAll(async () => {
    host = new LocalSceneHost();
    await host.init(workspace);
    catalog = new FeatureCatalog({
      workspacePath: workspace,
      scan: (absPath) => FeatureScanner.scanFile(host, manager, absPath),
      builtIns: async () => ({}),
    });
  });

  afterAll(async () => {
    await host?.server.close();
  });

  async function usesOcct(): Promise<Record<string, boolean>> {
    const entries = await catalog.list();
    expect(entries).not.toBeNull();
    return Object.fromEntries(entries!.filter(e => e.id !== null).map(e => [e.id!, e.usesOcct]));
  }

  it('marks every feature whose module, or a module it imports, reaches it — and no other', async () => {
    expect(await usesOcct()).toEqual({
      'acme.dangling': true,
      'acme.lazy': true,
      'acme.outside': false,
      'acme.plain': false,
      'acme.standoff': false,
      'acme.thread': true,
      'acme.twist': true,
    });
  });

  it('follows an edit of the imported helper, though the feature module itself never changed', async () => {
    write('geometry/helix.js', `export const turns = () => 3;\n`);
    expect(catalog.noteFileChange(at('geometry/helix.js'))).toBe(true);
    expect((await usesOcct())['acme.thread']).toBe(false);

    write('geometry/helix.js', `import { getOC } from 'fluidcad/sdk/occt';\nexport const turns = () => getOC();\n`);
    catalog.noteFileChange(at('geometry/helix.js'));
    expect((await usesOcct())['acme.thread']).toBe(true);
  });
});
