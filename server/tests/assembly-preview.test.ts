import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'node:http';
import os from 'os';
import path from 'path';
import { FluidCadServer, scenePreviewFields, sceneStopFields, sceneUnitFields } from '../src/fluidcad-server/index.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { FeatureEditDispatcher } from '../src/edit-dispatch.ts';
import { PackageEditGuard } from '../src/packages/package-edit-guard.ts';
import { AssemblyPreviews } from '../src/assembly-preview/assembly-previews.ts';
import { AssemblyPreviewRequest } from '../src/assembly-preview/preview-request.ts';
import { createAssemblyPreviewRouter } from '../src/routes/assembly-preview.ts';
import { createPartCatalogRouter } from '../src/routes/part-catalog.ts';
import { createInstancePoseRouter } from '../src/routes/instance-pose.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';
import { readProjectConfig } from '../src/project-config.ts';
import { packPackage, type PackPackageResult } from '../src/packages/package-builder.ts';
import { InProcessEngine } from '../src/packages/in-process-engine.ts';
import { PackageManifests } from '../src/packages/package-manifests.ts';
import { PackageProject } from './packages/package-project.ts';

// The assembly preview (generators S5, G4): a dialog's edit — the insert
// its Apply writes (create) or the values it merges (edit) — applied in
// memory to the file on screen and rendered as the session's scene, never
// written: not to the editor, not to disk, not to fluidcad.json (a library
// package resolves through the pin its Apply will write, held in memory).
// Latest wins; a render of the file's own code ends the preview; /end
// renders the saved code; Apply after a full-detail preview is served
// without evaluating anything. Over real workspaces made from the S4
// fixture (fixtures/generated-workspace), with the editor faked: what it is
// sent is recorded, and applied only where a test plays the editor.

const FIXTURE = path.resolve(__dirname, 'fixtures/generated-workspace');

/** The model: one crate, its width a parameter of the assembly. */
const SHOP = [
  `import { assembly, insert, param } from 'fluidcad/core';`,
  `import { crate } from './assemblies/crate.assembly.js';`,
  ``,
  `export const shop = assembly('shop', () => {`,
  `  const width = param('Crate width', 40);`,
  `  const crate1 = insert(crate, { width }).name('crate1');`,
  `});`,
  ``,
].join('\n');
const CRATE1_LINE = 6;

/** A generator whose box is shorter at the preview tier, and which records every tier it builds at. */
const PROBE = [
  `import { Generator } from 'fluidcad/sdk';`,
  `import { ShapeFactory } from 'fluidcad/sdk/kernel';`,
  ``,
  `export class Probe extends Generator.with({ size: { type: 'length', default: 10, min: 1 } }) {`,
  `  static id = 'probe';`,
  ``,
  `  layout(g) {`,
  `    return { box: g.part('box', { name: 'Box', inputs: { size: this.values.size } }) };`,
  `  }`,
  ``,
  `  static build(type, inputs, ctx) {`,
  `    (globalThis.__probeDetails ??= []).push(ctx.detail);`,
  `    const height = ctx.detail === 'full' ? 10 : 5;`,
  `    return [ctx.occ(({ oc, track }) => ShapeFactory.fromShape(track(new oc.BRepPrimAPI_MakeBox(inputs.size, inputs.size, height).Shape())))];`,
  `  }`,
  `}`,
  ``,
].join('\n');
const PROBE_ASSEMBLY = [
  `import { defineAssembly } from 'fluidcad/sdk';`,
  `import { Probe } from '../features/lib/probe.js';`,
  ``,
  `export const probe = defineAssembly(Probe, { label: 'Probe' });`,
  ``,
].join('\n');

type Probed = { __probeDetails?: string[] };
const probed = globalThis as Probed;

type Row = { type: string; hasError?: boolean; errorMessage?: string; fromCache?: boolean; sceneShapes?: { shapeId: string }[] };

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const table = vi.spyOn(console, 'table').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
    table.mockRestore();
    warn.mockRestore();
  }
}

/**
 * A workspace, its engine and the preview wiring index.ts makes, the
 * editor faked: the edits it is sent are recorded ({@link hostMessages}),
 * and land only through {@link applyHostEdit}. {@link liveRender} is
 * index.ts's `runLiveRender` reduced to what the preview depends on: a
 * render version, the render, and the scene broadcast through the preview's
 * gate.
 */
class PreviewHarness {
  readonly broadcasts: any[] = [];
  readonly hostMessages: any[] = [];
  /** Module evaluations: every render evaluates the file once. */
  evaluations = 0;
  /** Preview renders the engine was asked for. */
  previewRenders = 0;
  private version = 0;
  readonly previews: AssemblyPreviews;
  readonly dispatcher: FeatureEditDispatcher;
  private http: http.Server | null = null;
  private base = '';

  private constructor(readonly root: string, readonly host: LocalSceneHost, readonly server: FluidCadServer) {
    const guard = new PackageEditGuard(() => root, () => server.getCurrentFileName() || null, () => server.getGeneratedRows());
    const send = guard.guardSend((message: any) => {
      this.hostMessages.push(message);
      return false;
    });
    this.dispatcher = new FeatureEditDispatcher(server, send, { packages: guard });
    const renderPreview = server.renderPreview.bind(server);
    server.renderPreview = async (preview) => {
      this.previewRenders++;
      return renderPreview(preview);
    };
    const load = host.loadModule.bind(host);
    host.loadModule = async (...args) => {
      this.evaluations++;
      return load(...args);
    };
    this.previews = new AssemblyPreviews({
      engine: server,
      edits: this.dispatcher,
      workspacePath: root,
      broadcast: (msg) => this.record(msg),
      versions: { next: () => ++this.version, isLatest: (version) => version === this.version },
      renderSaved: async (file, code) => {
        const data = await this.liveRender(code, file);
        return data
          ? { state: 'rendered' as const, version: this.version, absPath: data.absPath, durationMs: 0 }
          : { state: 'superseded' as const, version: this.version, durationMs: 0 };
      },
    });
  }

  static async open(root: string): Promise<PreviewHarness> {
    const host = new LocalSceneHost();
    const server = new FluidCadServer(host);
    await quietly(() => server.init(root));
    // The template cache is one per process: start every workspace without
    // another test's builds in it.
    (server as any).sceneManager.clearGeneratedTemplates();
    const harness = new PreviewHarness(root, host, server);
    const app = express();
    app.use(express.json());
    app.use('/api', createAssemblyPreviewRouter(harness.previews));
    app.use('/api', createPartCatalogRouter(server, root, harness.dispatcher));
    app.use('/api', createInstancePoseRouter(server, harness.dispatcher, root));
    app.use('/api', PackageEditGuard.errorHandler());
    harness.http = http.createServer(app);
    await new Promise<void>(resolve => harness.http!.listen(0, '127.0.0.1', () => resolve()));
    harness.base = `http://127.0.0.1:${(harness.http.address() as import('node:net').AddressInfo).port}`;
    return harness;
  }

  at(rel: string): string {
    return path.join(this.root, rel).replace(/\\/g, '/');
  }

  get shop(): string {
    return this.at('shop.assembly.js');
  }

  /** What every page is sent goes through the preview's gate first, as index.ts's broadcast does. */
  private record(msg: any): number {
    this.broadcasts.push(msg);
    return JSON.stringify(msg).length;
  }

  private gate(msg: any): void {
    this.previews.noteBroadcast(msg);
    this.record(msg);
  }

  /** The editor's live update of `code` (index.ts `runLiveRender`): a version, the render, its scene for the pages. */
  async liveRender(code: string, file = this.shop): Promise<SceneRenderedData | null> {
    const mine = ++this.version;
    const data = await quietly(() => this.server.updateLiveCode(file, code));
    if (!data || mine !== this.version) {
      return null;
    }
    this.gate({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      ...sceneStopFields(data),
      params: data.params,
      ...(data.assembly ? { assembly: data.assembly } : {}),
      ...scenePreviewFields(data),
    });
    return data;
  }

  async post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await quietly(() => fetch(`${this.base}/api/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  }

  preview(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    return this.post('assembly-preview', body);
  }

  /** Play the editor: apply the last edit it was sent to its buffer, as `/code/apply-feature` does, and answer the new code. */
  async applyHostEdit(): Promise<string> {
    const message = this.hostMessages.at(-1);
    expect(message?.type).toBe('apply-feature-edit');
    const { editId: _editId, ...spec } = message.spec;
    const result = await applyFeatureEdit(this.server.getLiveBuffer(this.shop)!, spec);
    expect(result.error).toBeUndefined();
    return result.newCode;
  }

  /** The scenes sent since `from`, preview ones and not. */
  scenesSince(from: number): any[] {
    return this.broadcasts.slice(from).filter(msg => msg.type === 'scene-rendered');
  }

  /** The volume of every solid a render shows. */
  volumeOf(result: Row[]): number {
    return result
      .flatMap(row => row.sceneShapes ?? [])
      .reduce((sum, shape) => sum + (this.server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
  }

  async close(): Promise<void> {
    if (this.http) {
      await new Promise<void>(resolve => this.http!.close(() => resolve()));
    }
    await this.host.server?.close();
  }
}

function errorsOf(result: Row[]): string[] {
  return result.flatMap(row => (row.hasError ? [`${row.type}: ${row.errorMessage}`] : []));
}

/** A copy of the S4 fixture with the shop model and the probe generator beside it. */
function workspace(prefix: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'shop.assembly.js'), SHOP);
  fs.writeFileSync(path.join(root, 'features/lib/probe.js'), PROBE);
  fs.writeFileSync(path.join(root, 'assemblies/probe.assembly.js'), PROBE_ASSEMBLY);
  return root.replace(/\\/g, '/');
}

describe('an assembly preview over a workspace', () => {
  let root: string;
  let harness: PreviewHarness;
  let crateFile: string;
  let probeFile: string;
  /** The model as the editor holds it, rendered. */
  let opened: SceneRenderedData;

  const create = (token: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    token, mode: 'create', filePath: harness.shop, definition: { file: crateFile, exportName: 'crate' }, values, ...extra,
  });

  beforeEach(async () => {
    root = workspace('fluidcad-assembly-preview-');
    harness = await PreviewHarness.open(root);
    crateFile = harness.at('assemblies/crate.assembly.js');
    probeFile = harness.at('assemblies/probe.assembly.js');
    probed.__probeDetails = [];
    opened = (await harness.liveRender(SHOP))!;
    expect(errorsOf(opened.result)).toEqual([]);
    harness.broadcasts.length = 0;
  });

  afterEach(async () => {
    await harness?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders an insert in memory as the scene, tagged with its token, with its timings — and writes nothing', async () => {
    const rowsBefore = harness.server.getGeneratedRows();
    const paramsBefore = harness.server.getParamDefinitions();
    const answer = await harness.preview(create('dialog-1', { width: 60, finish: 'closed' }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ state: 'rendered', token: 'dialog-1', absPath: harness.shop });

    // The pages get the preview as the model: the scene, with its token and
    // without the panels' params — between the render's version pings.
    expect(harness.broadcasts.map(msg => msg.type)).toEqual(['render-version', 'scene-rendered', 'render-version']);
    const scene = harness.broadcasts[1];
    expect(scene.preview).toEqual({ token: 'dialog-1' });
    expect(scene.params).toBeUndefined();
    expect(scene.configurations).toBeUndefined();
    expect(harness.broadcasts[2]).toMatchObject({ state: 'end', version: answer.body.version, absPath: harness.shop });
    expect(errorsOf(scene.result)).toEqual([]);
    expect(scene.assembly.occurrences.map((occ: any) => [occ.name, occ.generated?.values.width])).toEqual([['crate1', 40], ['crate2', 60]]);
    // 40 × 30 × (20 + 3) and 60 × 30 × (20 + 3): crate1's parts kept, crate2's built.
    expect(harness.volumeOf(scene.result)).toBeCloseTo(40 * 30 * 23 + 60 * 30 * 23, 3);

    // Timings (P7): the server's phases and the engine's generated-part report.
    const { timings, generated } = answer.body;
    for (const key of ['totalMs', 'queueMs', 'editMs', 'waitMs', 'evaluateMs', 'compareMs', 'renderMs', 'collectMs', 'sendMs']) {
      expect(typeof timings[key]).toBe('number');
      expect(timings[key]).toBeGreaterThanOrEqual(0);
    }
    expect(timings.evaluateMs).toBeGreaterThan(0);
    expect(timings.renderMs).toBeGreaterThan(0);
    expect(timings.payloadBytes).toBe(JSON.stringify(scene).length);
    expect(generated.detail).toBe('full');
    expect(generated.layouts.map((layout: any) => layout.parts)).toEqual([2, 2]);
    expect(generated.templates.map((t: any) => [t.type, t.source])).toEqual([['base', 'kept'], ['lid', 'kept'], ['base', 'built'], ['lid', 'built']]);
    expect(generated.misses).toBe(2);
    expect(generated.hits).toEqual({ kept: 2, cached: 0 });
    expect(generated.cache).toMatchObject({ maxEntries: expect.any(Number) });

    // Nothing written: the editor was sent nothing, its buffer and the disk hold the model as it was.
    expect(harness.hostMessages).toEqual([]);
    expect(harness.broadcasts.some(msg => msg.type === 'host-message')).toBe(false);
    expect(harness.server.getLiveBuffer(harness.shop)).toBe(SHOP);
    expect(fs.readFileSync(harness.shop, 'utf8')).toBe(SHOP);
    // The session's scene is the preview's; what describes its code is not.
    expect(harness.server.previewTokenOf()).toBe('dialog-1');
    expect(harness.server.getGeneratedRows()).toBe(rowsBefore);
    expect(harness.server.getParamDefinitions()).toBe(paramsBefore);
  });

  it('previews an edit of an insert\'s values, keyed by id, refusing an engine-owned row as the writer does', async () => {
    const edited = await harness.preview({ token: 'edit-1', mode: 'edit', filePath: harness.shop, line: CRATE1_LINE, values: { width: 70 }, row: 'asm-0' });
    expect(edited.status).toBe(200);
    const scene = harness.broadcasts.find(msg => msg.type === 'scene-rendered');
    expect(scene.preview).toEqual({ token: 'edit-1' });
    expect(scene.assembly.occurrences[0].generated.values.width).toBe(70);
    expect(harness.volumeOf(scene.result)).toBeCloseTo(70 * 30 * 23, 3);
    expect(harness.server.getLiveBuffer(harness.shop)).toBe(SHOP);

    // No change at all previews the code as it is.
    const same = await harness.preview({ token: 'edit-1', mode: 'edit', filePath: harness.shop, line: CRATE1_LINE, values: {} });
    expect(same.body.state).toBe('rendered');
    expect(harness.volumeOf(harness.scenesSince(0).at(-1).result)).toBeCloseTo(40 * 30 * 23, 3);

    // The generator's own parts are read-only (G8): the writer's refusal, before any render.
    const base = opened.assembly!.instances.find(inst => inst.name === 'Base')!;
    const refused = await harness.preview({ token: 'edit-1', mode: 'edit', filePath: harness.shop, line: CRATE1_LINE, values: { width: 50 }, row: base.instanceId });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ success: false, code: 'generated-read-only' });
    expect(harness.hostMessages).toEqual([]);
  });

  it('refuses what it can\'t preview — a malformed body, another file than the one on screen — and answers a module that fails to evaluate as a compile error', async () => {
    expect((await harness.preview({ token: 'x', mode: 'create', filePath: harness.shop, values: {} })).status).toBe(400);
    expect((await harness.preview({ token: 'bad token!', mode: 'edit', filePath: harness.shop, line: 1, values: {} })).status).toBe(400);
    expect((await harness.preview({ ...create('x', {}), detail: 'draft' })).status).toBe(400);
    const elsewhere = await harness.preview({ ...create('x', {}), filePath: crateFile });
    expect(elsewhere.status).toBe(422);
    expect(harness.previewRenders).toBe(0);

    // A module that doesn't exist imports as the writer would write it, and
    // fails to evaluate: a compile error, and the scene stays what it was.
    const missing = await harness.preview(create('x', {}, { definition: { file: harness.at('assemblies/none.assembly.js'), exportName: 'none' } }));
    expect(missing.status).toBe(200);
    expect(missing.body.state).toBe('compile-error');
    expect(missing.body.compileError).toMatchObject({ filePath: harness.shop });
    expect(harness.broadcasts.map(msg => [msg.type, msg.state])).toEqual([['render-version', 'start'], ['render-version', 'error']]);
    expect(harness.server.previewTokenOf()).toBeNull();
  });

  it('ends on /end: the saved code renders again, its parts back from the cache, and the token is done', async () => {
    await harness.preview(create('dialog-1', { width: 60 }));
    const from = harness.broadcasts.length;
    const ended = await harness.post('assembly-preview/end', { token: 'dialog-1' });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ state: 'rendered', token: 'dialog-1' });
    // The pages hear the preview ended before the file's own scene.
    const after = harness.broadcasts.slice(from);
    expect(after[0]).toEqual({ type: 'assembly-preview-ended', token: 'dialog-1', reason: 'end' });
    const scene = harness.scenesSince(from).at(-1);
    expect(scene.preview).toBeUndefined();
    expect(scene.assembly.occurrences.map((occ: any) => occ.name)).toEqual(['crate1']);
    expect(scene.result.filter((row: Row) => row.type === 'part').every((row: Row) => row.fromCache)).toBe(true);
    expect(harness.server.previewTokenOf()).toBeNull();

    // A late request of the ended preview never shows again; a second /end renders nothing.
    const late = await harness.preview(create('dialog-1', { width: 80 }));
    expect(late.body).toEqual({ state: 'superseded', token: 'dialog-1', reason: 'ended' });
    expect((await harness.post('assembly-preview/end', { token: 'dialog-1' })).body).toEqual({ state: 'inactive', token: 'dialog-1' });

    // Opening the dialog again with the same values takes the preview's parts from the cache.
    const again = await harness.preview(create('dialog-2', { width: 60 }));
    expect(again.body.generated.templates.map((t: any) => t.source)).toEqual(['kept', 'kept', 'cached', 'cached']);
    expect(again.body.generated.misses).toBe(0);
    expect(harness.hostMessages).toEqual([]);
  });

  it('coalesces: of three quick requests the middle one is superseded at once, and two render', async () => {
    const answers = await Promise.all([50, 60, 70].map(width => harness.previews.request(create('drag', { width }))));
    expect(answers.map(answer => answer.body.state)).toEqual(['rendered', 'superseded', 'rendered']);
    expect(answers[1].body).toEqual({ state: 'superseded', token: 'drag', reason: 'newer-request' });
    expect(harness.previewRenders).toBe(2);
    // The latest is what shows.
    const shown = harness.scenesSince(0).at(-1);
    expect(shown.preview).toEqual({ token: 'drag' });
    expect(shown.assembly.occurrences[1].generated.values.width).toBe(70);
    expect(answers[2].body.timings.queueMs).toBeGreaterThan(0);
  });

  it('a render of the file\'s own code ends the preview showing; the token may ask again, another token takes it over', async () => {
    await harness.preview(create('dialog-1', { width: 60 }));
    let from = harness.broadcasts.length;
    // The editor changed the file (here: the same code, saved again).
    await harness.liveRender(`${SHOP}// edited\n`);
    const after = harness.broadcasts.slice(from).map(msg => msg.type === 'assembly-preview-ended' ? `ended:${msg.reason}` : msg.type);
    expect(after).toEqual(['ended:replaced', 'scene-rendered']);
    expect(harness.server.previewTokenOf()).toBeNull();
    expect(harness.server.getLiveBuffer(harness.shop)).toBe(`${SHOP}// edited\n`);

    // The same dialog asks again: its edit lands on the code as it is now.
    const again = await harness.preview(create('dialog-1', { width: 60 }));
    expect(again.body.state).toBe('rendered');
    expect(harness.server.previewTokenOf()).toBe('dialog-1');

    // Another dialog takes the preview over; the first one's late requests are refused.
    from = harness.broadcasts.length;
    const other = await harness.preview(create('dialog-2', { width: 30 }));
    expect(other.body.state).toBe('rendered');
    expect(harness.broadcasts[from]).toEqual({ type: 'assembly-preview-ended', token: 'dialog-1', reason: 'superseded' });
    expect((await harness.preview(create('dialog-1', { width: 60 }))).body.reason).toBe('ended');
    // A scene going away ends it too.
    harness.previews.noteBroadcast({ type: 'scene-closed' });
    expect(harness.broadcasts.at(-1)).toEqual({ type: 'assembly-preview-ended', token: 'dialog-2', reason: 'closed' });
  });

  // The workspace's engine copy registers its param() calls in its own
  // module instance under vitest (the existing route tests fake the host for
  // params), so what is checked here is that a preview never touches the
  // session's override and definition state — by identity.
  it('leaves the session\'s parameter overrides, params and breakpoints alone', async () => {
    expect(harness.server.setParam(harness.shop, 'Crate width', 50)).toBeNull();
    await harness.liveRender(SHOP);
    const overrides = harness.server.getParamOverrides(harness.shop);
    expect(overrides).toEqual({ 'Crate width': 50 });
    const params = harness.server.getParamDefinitions();

    // Inserting the probe imports it: every line below the imports moves down in the previewed code.
    const answer = await harness.preview({
      token: 'probe-1', mode: 'create', filePath: harness.shop, definition: { file: probeFile, exportName: 'probe' }, values: { size: 12 },
    });
    expect(answer.body.state).toBe('rendered');
    const scene = harness.scenesSince(0).at(-1);
    expect(harness.volumeOf(scene.result)).toBeCloseTo(40 * 30 * 23 + 12 * 12 * 10, 3);
    expect(harness.server.getParamOverrides(harness.shop)).toEqual(overrides);
    expect(harness.server.getParamDefinitions()).toBe(params);
    expect(harness.server.getActiveBreakpoint()).toBeNull();
    expect(harness.server.getCompileError()).toBeNull();
  });

  it('reaches the generator with its detail: the preview tier while a control moves, full once it settles', async () => {
    const preview = await harness.preview({
      token: 'p', mode: 'create', filePath: harness.shop, definition: { file: probeFile, exportName: 'probe' }, values: { size: 20 }, detail: 'preview',
    });
    expect(preview.body.generated.detail).toBe('preview');
    expect(probed.__probeDetails).toEqual(['preview']);
    expect(harness.volumeOf(harness.scenesSince(0).at(-1).result) - 40 * 30 * 23).toBeCloseTo(20 * 20 * 5, 3);

    const full = await harness.preview({
      token: 'p', mode: 'create', filePath: harness.shop, definition: { file: probeFile, exportName: 'probe' }, values: { size: 20 }, detail: 'full',
    });
    expect(full.body.generated.detail).toBe('full');
    expect(probed.__probeDetails).toEqual(['preview', 'full']);
    expect(harness.volumeOf(harness.scenesSince(0).at(-1).result) - 40 * 30 * 23).toBeCloseTo(20 * 20 * 10, 3);

    // Every render of the file's own code builds at full detail; the
    // preview tier's parts are never served as the code's own.
    await harness.preview({
      token: 'p', mode: 'create', filePath: harness.shop, definition: { file: probeFile, exportName: 'probe' }, values: { size: 20 }, detail: 'preview',
    });
    const writer = AssemblyPreviewRequest.writerRequest(AssemblyPreviewRequest.parse({
      token: 'p', mode: 'create', filePath: harness.shop, definition: { file: probeFile, exportName: 'probe' }, values: { size: 20 },
    })!);
    expect((await harness.post(writer.route, writer.body)).status).toBe(200);
    const applied = (await harness.liveRender(await harness.applyHostEdit()))!;
    expect(harness.volumeOf(applied.result as Row[]) - 40 * 30 * 23).toBeCloseTo(20 * 20 * 10, 3);
    // The full-tier box came back from the cache: nothing built again.
    expect(probed.__probeDetails).toEqual(['preview', 'full']);
  });

  it('Apply after a full-detail preview is served from the preview: nothing evaluates, nothing builds', async () => {
    const values = { width: 60, finish: 'closed' };
    const answer = await harness.preview(create('dialog-1', values));
    expect(answer.body.state).toBe('rendered');
    const previewScene = harness.scenesSince(0).at(-1);
    const evaluations = harness.evaluations;
    const paramsBefore = harness.server.getParamDefinitions();

    // Apply: the Insert writer's request — exactly the one the preview planned — and the editor applying it.
    const writer = AssemblyPreviewRequest.writerRequest(AssemblyPreviewRequest.parse(create('dialog-1', values))!);
    expect(writer.route).toBe('part-catalog/insert');
    const inserted = await harness.post(writer.route, writer.body);
    expect(inserted.status).toBe(200);
    const code = await harness.applyHostEdit();
    expect(code).toContain(`const crate2 = insert(crate, { width: 60, finish: 'closed' }).name('crate2');`);
    const from = harness.broadcasts.length;
    const applied = (await harness.liveRender(code))!;

    // The live update was the preview's render: no module evaluated, the same rows.
    expect(harness.evaluations).toBe(evaluations);
    expect(applied.result).toBe(previewScene.result);
    // It is the file's own scene now: no preview mark, the preview ended,
    // and what describes the code is the applied code's.
    expect(harness.server.previewTokenOf()).toBeNull();
    expect(harness.broadcasts.slice(from).map(msg => msg.type === 'assembly-preview-ended' ? `ended:${msg.reason}` : msg.type))
      .toEqual(['ended:replaced', 'scene-rendered']);
    expect(harness.scenesSince(from)[0].preview).toBeUndefined();
    const crate2 = applied.assembly!.occurrences!.find(occ => occ.name === 'crate2')!;
    expect(harness.server.getGeneratedRows().refusal({ row: applied.assembly!.instances.find(inst => inst.owner === crate2.occurrenceId)!.instanceId }))
      .not.toBeNull();
    // The params the panel reads are the applied code's (the preview's, made the session's).
    expect(harness.server.getParamDefinitions()).not.toBe(paramsBefore);

    // An edit afterwards renders as usual, pairing every template with the applied scene's.
    const next = (await harness.liveRender(`${code}// next\n`))!;
    expect(harness.evaluations).toBe(evaluations + 1);
    expect((next.result as Row[]).filter(row => row.type === 'part').every(row => row.fromCache)).toBe(true);
  });

  it('applies an edit preview the same way: Edit parameters\' writer, then the live update served from the preview', async () => {
    const values = { width: 55 };
    await harness.preview({ token: 'edit-2', mode: 'edit', filePath: harness.shop, line: CRATE1_LINE, values, row: 'asm-0' });
    const evaluations = harness.evaluations;
    const request = AssemblyPreviewRequest.parse({ token: 'edit-2', mode: 'edit', filePath: harness.shop, line: CRATE1_LINE, values, row: 'asm-0' })!;
    const writer = AssemblyPreviewRequest.writerRequest(request);
    expect(writer.route).toBe('update-insert-params');
    expect((await harness.post(writer.route, writer.body)).status).toBe(200);
    const code = await harness.applyHostEdit();
    expect(code).toContain(`const crate1 = insert(crate, { width: 55 }).name('crate1');`);
    await harness.liveRender(code);
    expect(harness.evaluations).toBe(evaluations);
    expect(harness.server.previewTokenOf()).toBeNull();
  });
});

/** A model of one generated part: a gear (`spurPart`, a definePart) inserted with its teeth. */
const GEARS = [
  `import { assembly, insert } from 'fluidcad/core';`,
  `import { spurPart } from './parts/spur.part.js';`,
  ``,
  `export const shop = assembly('shop', () => {`,
  `  const gear1 = insert(spurPart, { teeth: 30 }).name('gear1');`,
  `});`,
  ``,
].join('\n');
const GEAR1_LINE = 5;

/** The fixture spur's disc: tip radius module × (teeth + 2) / 2, module 2, width 10. */
const spurVolume = (teeth: number) => Math.PI * (teeth + 2) ** 2 * 10;

// A generated part's variants go through the template cache too (F2): the
// dialog's teeth dragged away and back renders the way back from the cache,
// at either tier — a feature's build reads no detail tier, so a preview
// build serves the full render.
describe('an assembly preview of a generated part (definePart)', () => {
  let root: string;
  let harness: PreviewHarness;

  const edit = (token: string, teeth: number, detail: 'preview' | 'full' = 'full') => harness.preview({
    token, mode: 'edit', filePath: harness.shop, line: GEAR1_LINE, values: { teeth }, detail,
  });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-variant-preview-')).replace(/\\/g, '/');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'shop.assembly.js'), GEARS);
    harness = await PreviewHarness.open(root);
    const opened = (await harness.liveRender(GEARS))!;
    expect(errorsOf(opened.result)).toEqual([]);
    harness.broadcasts.length = 0;
  });

  afterEach(async () => {
    await harness?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('revisits a gear\'s teeth from the cache: 30 → 40 → 30 builds nothing on the way back, and reports it cached', async () => {
    const sources: string[] = [];
    const counts: unknown[] = [];
    for (const [token, teeth] of [['gear-1', 40], ['gear-1', 30], ['gear-1', 40]] as const) {
      const answer = await edit(token, teeth);
      expect(answer.status).toBe(200);
      expect(answer.body.state).toBe('rendered');
      const scene = harness.scenesSince(0).at(-1);
      expect(errorsOf(scene.result)).toEqual([]);
      expect(harness.volumeOf(scene.result)).toBeCloseTo(spurVolume(teeth), 0);
      const { generated } = answer.body;
      expect(generated.variants.map((v: any) => [v.definition, v.part, v.values.teeth])).toEqual([['spur', 'Spur gear', teeth]]);
      sources.push(generated.variants[0].source);
      counts.push({ misses: generated.misses, hits: generated.hits });
      // A variant taken from the cache renders fromCache, as one carried over does.
      if (generated.variants[0].source === 'cached') {
        expect((scene.result as Row[]).filter(row => row.type === 'part').every(row => row.fromCache)).toBe(true);
      }
    }
    // 40 is built; 30 — the model's own, left in the cache by the first tick — comes back; so does 40.
    expect(sources).toEqual(['built', 'cached', 'cached']);
    expect(counts).toEqual([
      { misses: 1, hits: { kept: 0, cached: 0 } },
      { misses: 0, hits: { kept: 0, cached: 1 } },
      { misses: 0, hits: { kept: 0, cached: 1 } },
    ]);

    // Ending the preview: the saved code's 30 is back from the cache, nothing built.
    const ended = await harness.post('assembly-preview/end', { token: 'gear-1' });
    expect(ended.status).toBe(200);
    const report = (harness.server as any).sceneManager.getGeneratedReport((harness.server as any).previousScenes.get(harness.shop));
    expect(report.variants.map((v: any) => [v.values.teeth, v.source])).toEqual([[30, 'cached']]);
    expect(report.misses).toBe(0);
  });

  it('serves the full tier a variant a preview tick built: a feature\'s build reads no detail tier', async () => {
    const tick = await edit('gear-2', 44, 'preview');
    expect(tick.body.generated.detail).toBe('preview');
    expect(tick.body.generated.variants.map((v: any) => v.source)).toEqual(['built']);
    const settled = await edit('gear-2', 44, 'full');
    expect(settled.body.generated.detail).toBe('full');
    expect(errorsOf(harness.scenesSince(0).at(-1).result)).toEqual([]);
    expect(settled.body.generated.variants.map((v: any) => v.source)).toEqual(['kept']);
    expect(settled.body.generated.misses).toBe(0);
  });
});

describe('an assembly preview of a library package\'s definition', () => {
  let scratch: string;
  let engine: InProcessEngine;
  let packed: PackPackageResult;
  let project: PackageProject;
  let harness: PreviewHarness;
  let packageDir: string;

  const EMPTY_SHOP = [`import { insert } from 'fluidcad/core';`, ``].join('\n');

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-preview-package-'));
    const ws = path.join(scratch, 'ws');
    fs.cpSync(FIXTURE, ws, { recursive: true });
    engine = await quietly(() => InProcessEngine.boot(ws, { linkEngine: false }));
    packed = await quietly(() => packPackage({ workspacePath: ws, fluidcadVersion: '0.0.48', engine: engine.server }));
  });

  afterAll(async () => {
    await engine?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    project = new PackageProject('fluidcad-preview-library-');
    packageDir = project.packageDir('@acme/generated', '0.1.0');
    for (const [rel, bytes] of Object.entries(packed.files)) {
      fs.mkdirSync(path.dirname(path.join(packageDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(packageDir, rel), bytes);
    }
    PackageProject.chmodFiles(packageDir, 0o444);
    // The project doesn't pin the package: it is only in the library.
    project.config(null);
    PackageManifests.forget();
    project.write('shop.assembly.js', EMPTY_SHOP);
    harness = await PreviewHarness.open(project.root);
    await harness.liveRender(EMPTY_SHOP);
    harness.broadcasts.length = 0;
  });

  afterEach(async () => {
    await harness?.close();
    project.dispose();
  });

  it('resolves it through the pin its Apply writes, held in memory; Apply then pins it and every template is kept', async () => {
    const configBefore = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    const definition = { file: `${packageDir}/assemblies/crate.assembly.js`, exportName: 'crate' };
    const body = { token: 'lib-1', mode: 'create', filePath: harness.shop, definition, values: { width: 50 } };
    const answer = await harness.preview(body);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe('rendered');
    const scene = harness.scenesSince(0).at(-1);
    expect(errorsOf(scene.result)).toEqual([]);
    expect(scene.assembly.instances.map((inst: any) => inst.name)).toEqual(['Base', 'Lid']);
    expect(harness.volumeOf(scene.result)).toBeCloseTo(50 * 30 * 23, 3);
    // Nothing pinned, nothing written.
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(configBefore);
    expect(readProjectConfig(project.root).dependencies ?? null).toBeNull();
    expect(harness.server.getLiveBuffer(harness.shop)).toBe(EMPTY_SHOP);
    expect(harness.hostMessages).toEqual([]);

    // Ending the preview: the file's own code renders, and still nothing is pinned.
    await harness.post('assembly-preview/end', { token: 'lib-1' });
    expect(readProjectConfig(project.root).dependencies ?? null).toBeNull();

    // Preview again, then Apply: the writer pins the package, the editor writes the import and the insert.
    await harness.preview({ ...body, token: 'lib-2' });
    const writer = AssemblyPreviewRequest.writerRequest(AssemblyPreviewRequest.parse({ ...body, token: 'lib-2' })!);
    expect((await harness.post(writer.route, writer.body)).status).toBe(200);
    expect(readProjectConfig(project.root).dependencies?.['@acme/generated']?.version).toBe('0.1.0');
    const code = await harness.applyHostEdit();
    expect(code).toContain(`import { crate } from '@acme/generated';`);
    // The pin changed fluidcad.json, so this is a render — of the previewed
    // code, through the pin it previewed with: every template is kept.
    const evaluations = harness.evaluations;
    const applied = (await harness.liveRender(code))!;
    expect(harness.evaluations).toBe(evaluations + 1);
    expect(errorsOf(applied.result as Row[])).toEqual([]);
    const report = (harness.server as any).sceneManager.getGeneratedReport((harness.server as any).previousScenes.get(harness.shop));
    expect(report.misses).toBe(0);
    expect(report.templates.map((t: any) => t.source)).toEqual(['kept', 'kept']);
  });

  it('revisits a package gear\'s teeth from the cache: the package\'s code version holds from render to render', async () => {
    const definition = { file: `${packageDir}/parts/spur.part.js`, exportName: 'spurPart' };
    const sources: string[] = [];
    for (const teeth of [30, 40, 30]) {
      const answer = await harness.preview({ token: 'lib-gear', mode: 'create', filePath: harness.shop, definition, values: { teeth } });
      expect(answer.status).toBe(200);
      expect(answer.body.state).toBe('rendered');
      const scene = harness.scenesSince(0).at(-1);
      expect(errorsOf(scene.result)).toEqual([]);
      expect(harness.volumeOf(scene.result)).toBeCloseTo(spurVolume(teeth), 0);
      const variants = answer.body.generated.variants;
      expect(variants.map((v: any) => [v.definition, v.values.teeth])).toEqual([['@acme/generated:spur', teeth]]);
      sources.push(variants[0].source);
    }
    expect(sources).toEqual(['built', 'built', 'cached']);
  });
});
