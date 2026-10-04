import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import { line } from '../../lib/core/2d/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { ShapeProps } from '../../lib/oc/props.js';
import { FeatureSlotSynthesizer } from '../../lib/selection/feature-slots.js';
import {
  applyFeatureEdit,
  CustomFeatureStatement,
  makeProducerBindable,
  makeProducerNamer,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type CustomFeatureOptions,
} from '../src/apply-feature-edit/index.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import { FeatureScanner } from '../src/feature-catalog/scan.ts';
import { createFeatureGhostRouter } from '../src/routes/feature-ghost/index.ts';

// Draft is the engine's own feature on the custom-feature path: its builder
// in `fluidcad/core` carries metadata, so the catalog lists it beside the
// workspace's modules, and its statements are written, read back and edited
// by its call shape `draft(angle, ...faces)` — with no Draft-specific code
// on the server.

const MODEL = '/ws/model.part.js';

function src(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** The workspace's catalog: no feature modules, the engine's own builders from this server's kernel. */
function catalog(workspacePath = '/ws'): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath,
    scan: async (absPath) => ({ file: absPath, features: [], error: `no module ${absPath}`, deps: [] }),
  });
}

const BLOCK = src(
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
);

/** A draft of `e.sideFaces()` — the faces the slot synthesis names — with `values` beside the faces. */
async function createSpec(values: CustomFeatureOptions['values'] = {}): Promise<ApplyFeatureEditSpec> {
  const entry = (await catalog().list())!.find(e => e.id === 'draft')!;
  return {
    feature: 'custom',
    filePath: MODEL,
    producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'sideFaces', indices: null, filterArgs: null }],
    imports: [],
    custom: {
      id: 'draft',
      exportName: entry.exportName!,
      modulePath: entry.modulePath,
      shape: CustomFeatureStatement.shapeOf(entry.meta!),
      values: { faces: { kind: 'picks', items: [{ kind: 'part', part: 0 }] }, ...values },
    },
  };
}

function editSpec(code: string, line: number, values: CustomFeatureOptions['values']): ApplyFeatureEditSpec {
  return {
    feature: 'custom',
    filePath: MODEL,
    producers: [],
    parts: [],
    imports: [],
    edit: { line, column: 0, custom: { id: 'draft', values } },
  };
}

describe('the catalog lists draft as a built-in', () => {
  it('beside the workspace modules, imported from the core', async () => {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'draft-catalog-'));
    try {
      const entries = await catalog(workspace).list();
      const draft = entries!.find(e => e.id === 'draft');
      expect(draft).toMatchObject({
        id: 'draft',
        exportName: 'draft',
        modulePath: 'fluidcad/core',
        builtIn: true,
        meta: {
          label: 'Draft',
          group: 'modify',
          kind: 'modifier',
          operations: [],
          ghost: true,
          call: ['angle', '...faces'],
          params: { angle: { type: 'angle', default: 5 }, faces: { picker: 'face', multiple: true } },
        },
      });
      expect(draft!.error).toBeUndefined();
      // Built-ins serve no assets: their icons are the product's own.
      expect(await catalog(workspace).asset('draft', './draft.svg')).toMatchObject({ status: 404 });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('as the callee a core import of draft names, read and written by its shape', async () => {
    const callees = await catalog().calleesFor(src(`import { draft as taper, extrude } from 'fluidcad'`), MODEL);
    expect(callees.feature('taper')).toEqual({
      id: 'draft',
      kind: 'modifier',
      shape: {
        call: ['angle', '...faces'],
        operations: [],
        params: { angle: { type: 'angle', list: false, default: 5 }, faces: { picker: 'face', list: true } },
      },
    });
    expect(callees.feature('extrude')).toBeNull();
    // A repeat may take a draft, as it always could.
    expect(callees.produces('feature', 'taper')).toBe(true);
  });

  it('hands a ghost its builder from the engine\'s own core namespace', async () => {
    const dist = await import('../../lib/dist/core/index.js');
    const host = { loadModuleRaw: async () => { throw new Error('a built-in never loads through the workspace'); } };
    const builder = await FeatureScanner.loadBuilder(host as never, {} as never, 'fluidcad/core', 'draft');
    expect(builder).toBe(dist.draft);
    expect(await FeatureScanner.loadBuilder(host as never, {} as never, 'fluidcad/core', 'nope'))
      .toEqual({ error: `fluidcad/core exports no 'nope'` });
  });
});

describe('writing a draft statement', () => {
  it('writes the faces after the angle, its default when the dialog left it alone, and imports it from the core', async () => {
    const result = await applyFeatureEdit(BLOCK, await createSpec(), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { draft, sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `draft(5, e.sideFaces())`,
    ));

    const angled = await applyFeatureEdit(BLOCK, await createSpec({ angle: { kind: 'value', value: 'taper * 2' } }), { callees: catalog() });
    expect(angled.newCode).toContain(`\ndraft(taper * 2, e.sideFaces())\n`);
  });
});

describe('reading a draft statement back', () => {
  const CODE = src(
    `import { sketch, rect, extrude, select, draft } from 'fluidcad/core'`,
    `import { face } from 'fluidcad/filters'`,
    `sketch('xy', () => { rect(40, 40) })`,
    `const e = extrude(10)`,
    `draft(5, e.sideFaces(0), e.sideFaces(2))`,
    `const front = select(face().onPlane('front'))`,
    `draft(-3)`,
    `draft()`,
    `draft(front)`,
  );

  async function parse(line: number) {
    return parseFeatureStatement(CODE, line, await catalog().calleesFor(CODE, MODEL));
  }

  it('reads the angle and each face as written', async () => {
    expect(await parse(5)).toMatchObject({
      ok: true,
      parsed: {
        feature: 'custom',
        id: 'draft',
        callee: 'draft',
        values: { angle: 5 },
        picks: { faces: [{ text: 'e.sideFaces(0)' }, { text: 'e.sideFaces(2)' }] },
      },
    });
  });

  it('opens the forms that take the last selection with no faces written', async () => {
    const implicit = await parse(7);
    expect(implicit).toMatchObject({ ok: true, parsed: { values: { angle: -3 } } });
    expect(implicit.ok && implicit.parsed.feature === 'custom' && implicit.parsed.picks.faces).toBeUndefined();
    const bare = await parse(8);
    expect(bare).toMatchObject({ ok: true, parsed: { values: {} } });
  });

  it('refuses the old angle-less form, whose first argument is no angle, as not editable', async () => {
    const legacy = await parse(9);
    expect(legacy.ok).toBe(false);
    expect(legacy.ok === false && legacy.reason).toContain(`draft()'s 'angle' is not a plain number or expression`);
    expect(legacy.ok === false && legacy.reason).toContain('not editable in the dialog');
  });

  it('is no feature statement without the catalog', async () => {
    const parsed = await parseFeatureStatement(CODE, 5);
    expect(parsed.ok === false && parsed.reason).toBe('draft() is not an editable feature statement');
  });
});

describe('editing a draft statement', () => {
  it('changes the angle and keeps the faces as written', async () => {
    const code = src(
      `import { sketch, rect, extrude, draft } from 'fluidcad/core'`,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `draft(5, e.sideFaces(0), e.sideFaces(2))`,
    );
    const result = await applyFeatureEdit(code, editSpec(code, 4, { angle: { kind: 'value', value: 8 }, faces: { kind: 'keep' } }), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(code.replace('draft(5, ', 'draft(8, '));
  });

  it('keeps a draft of the last selection taking it, or writes the faces the dialog picked instead', async () => {
    const code = src(
      `import { sketch, rect, extrude, select, draft } from 'fluidcad/core'`,
      `import { face } from 'fluidcad/filters'`,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `select(face().onPlane('front'))`,
      `draft(5)`,
    );
    const angled = await applyFeatureEdit(code, editSpec(code, 6, { angle: { kind: 'value', value: 2 } }), { callees: catalog() });
    expect(angled.error).toBeUndefined();
    expect(angled.newCode).toBe(code.replace('draft(5)', 'draft(2)'));

    const picked = await applyFeatureEdit(code, {
      ...editSpec(code, 6, { faces: { kind: 'picks', items: [{ kind: 'part', part: 0 }] } }),
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [1], filterArgs: null }],
    }, { callees: catalog() });
    expect(picked.error).toBeUndefined();
    expect(picked.newCode).toContain(`\ndraft(5, e.sideFaces(1))\n`);
  });
});

describe('a draft from its dialog, end to end', () => {
  setupOC();

  /** The catalog over the kernel these tests build with: its core is this run's lib sources. */
  function sourceCatalog(): FeatureCatalog {
    return new FeatureCatalog({
      workspacePath: '/ws',
      scan: async (absPath) => ({ file: absPath, features: [], error: `no module ${absPath}`, deps: [] }),
      builtIns: async () => core,
    });
  }

  const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

  function run(source: string): Scene {
    getSceneManager()!.startScene();
    const globals: Record<string, unknown> = { ...core, ...filters };
    const names = Object.keys(globals);
    new Function(...names, `"use strict";\n${source.replace(IMPORT_LINE_RE, '')}`)(...names.map(n => globals[n]));
    return render();
  }

  function volumeOf(scene: Scene): number {
    expect(scene.getAllSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
    const solid = scene.getAllSceneObjects().flatMap(o => o.getShapes()).find(s => s.getType() === 'solid');
    expect(solid).toBeDefined();
    return ShapeProps.getProperties(solid!.getShape()).volumeMm3;
  }

  const rect = `line([-20, -20], [20, -20]); line([20, -20], [20, 20]); line([20, 20], [-20, 20]); line([-20, 20], [-20, -20])`;

  it('drafts the faces picked in the viewport, and edits its angle', async () => {
    const code = src(
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rect} })`,
      `const e = extrude(30)`,
    );
    sketch('xy', () => {
      line([-20, -20], [20, -20]);
      line([20, -20], [20, 20]);
      line([20, 20], [-20, 20]);
      line([-20, 20], [-20, -20]);
    });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: MODEL, line: 4, column: 10 });
    const scene = render();
    const block = scene.getAllSceneObjects().flatMap(o => o.getShapes()).find(s => s.getType() === 'solid') as Shape;
    // The front wall, y = -20.
    const front = Explorer.findFacesWrapped(block).findIndex(face =>
      face.getEdges().every(edge => Math.abs(EdgeOps.getEdgeMidPoint(edge).y + 20) < 1e-6));
    expect(front).toBeGreaterThanOrEqual(0);

    const cat = sourceCatalog();
    const entry = (await cat.list())!.find(x => x.id === 'draft')!;
    const callees = await cat.calleesFor(code, MODEL);
    const synthesis = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { faces: { picker: 'face', entities: [{ shapeId: block.id, sub: { type: 'face', index: front } }], options: { multiple: true } } },
    }, { bindable: await makeProducerBindable(code, callees), namer: await makeProducerNamer(code, callees) });
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    const created = await applyFeatureEdit(code, {
      feature: 'custom',
      filePath: MODEL,
      producers: synthesis.producers,
      parts: synthesis.parts,
      imports: synthesis.imports,
      custom: {
        id: 'draft',
        exportName: entry.exportName!,
        modulePath: entry.modulePath,
        shape: CustomFeatureStatement.shapeOf(entry.meta!),
        values: { faces: { kind: 'picks', items: synthesis.slots.faces.parts.map(part => ({ kind: 'part' as const, part })) } },
      },
    }, { callees: cat });
    expect(created.error).toBeUndefined();
    const statement = created.newCode.split('\n').find(l => l.startsWith('draft('))!;
    expect(statement).toMatch(/^draft\(5, \S.*\)$/);
    expect(created.newCode).toContain(`import { draft, sketch, line, extrude } from 'fluidcad/core'`);

    // The statement the dialog wrote tilts the front wall out by 5° about
    // the bottom: the block gains a wedge 40 wide, 30 high, 30·tan 5° deep.
    const wedge = (angle: number) => 40 * 30 * 30 * Math.tan(angle * Math.PI / 180) / 2;
    expect(volumeOf(run(created.newCode))).toBeCloseTo(40 * 40 * 30 + wedge(5), 3);

    // Double-click: read back by the call shape, the angle changed, the faces kept.
    const row = created.newCode.split('\n').indexOf(statement) + 1;
    const parsed = await parseFeatureStatement(created.newCode, row, await cat.calleesFor(created.newCode, MODEL));
    expect(parsed).toMatchObject({ ok: true, parsed: { feature: 'custom', id: 'draft', values: { angle: 5 } } });
    const edited = await applyFeatureEdit(created.newCode, editSpec(created.newCode, row, {
      angle: { kind: 'value', value: 10 }, faces: { kind: 'keep' },
    }), { callees: cat });
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(statement.replace('draft(5, ', 'draft(10, '));
    expect(volumeOf(run(edited.newCode))).toBeCloseTo(40 * 40 * 30 + wedge(10), 3);
  });
  it('draws the tilted face its dialog picked, the server reaching the builder in the core', async () => {
    sketch('xy', () => {
      line([-20, -20], [20, -20]);
      line([20, -20], [20, 20]);
      line([20, 20], [-20, 20]);
      line([-20, 20], [-20, -20]);
    });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: MODEL, line: 4, column: 10 });
    const scene = render();
    const block = scene.getAllSceneObjects().flatMap(o => o.getShapes()).find(s => s.getType() === 'solid') as Shape;
    const front = Explorer.findFacesWrapped(block).findIndex(face =>
      face.getEdges().every(edge => Math.abs(EdgeOps.getEdgeMidPoint(edge).y + 20) < 1e-6));

    const asked: unknown[] = [];
    const fakeServer = {
      getCurrentCode: () => src(`import { sketch, line, extrude } from 'fluidcad/core'`, ``, `sketch('xy', () => { ${rect} })`, `const e = extrude(30)`),
      getCurrentFileName: () => MODEL,
      getParamDefinitions: () => [],
      getRenderedInstances: () => [],
      getRenderedParts: () => [],
      featureGhost: async (request: any) => {
        asked.push(request);
        // The kernel these tests build with: its core's own builder.
        const { modulePath: _m, exportName, unbounded: _u, ...rest } = request;
        const result = getSceneManager()!.buildFeatureGhost(scene, { ...rest, builder: (core as Record<string, unknown>)[exportName] });
        return result.ok ? { status: 200, solids: result.solids } : { status: 422, reason: result.reason };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createFeatureGhostRouter(fakeServer as never, { catalog: sourceCatalog() }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    try {
      const answer = await (await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/feature-ghost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'custom', id: 'draft',
          values: { angle: 'a + 1' },
          refs: { faces: [{ kind: 'entities', entities: [{ shapeId: block.id, index: front, kind: 'face' }] }] },
          valueScope: { kind: 'append', filePath: MODEL, line: 4, column: 0 },
        }),
      })).json();
      // `a` is no name the preview can resolve: no ghost, quietly, and the kernel is never asked.
      expect(answer).toEqual({ success: false, reason: 'That value is not a number the preview can resolve.' });
      expect(asked).toEqual([]);

      const drawn = await (await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/feature-ghost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'custom', id: 'draft',
          values: { angle: 10 },
          refs: { faces: [{ kind: 'entities', entities: [{ shapeId: block.id, index: front, kind: 'face' }] }] },
          valueScope: { kind: 'append', filePath: MODEL, line: 4, column: 0 },
        }),
      })).json();
      expect(asked).toMatchObject([{
        modulePath: 'fluidcad/core', exportName: 'draft', values: { angle: 10 }, refs: { faces: [{ kind: 'entities' }] },
      }]);
      expect(drawn.success).toBe(true);
      expect(drawn.solids).toHaveLength(1);
      let minY = Infinity;
      for (const mesh of drawn.solids[0].meshes) {
        for (let i = 1; i < mesh.vertices.length; i += 3) {
          minY = Math.min(minY, mesh.vertices[i]);
        }
      }
      expect(minY).toBeCloseTo(-20 - 30 * Math.tan(10 * Math.PI / 180), 3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
