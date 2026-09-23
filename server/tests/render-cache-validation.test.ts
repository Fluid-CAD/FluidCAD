import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { BreakpointHit } from '../../lib/dist/common/breakpoint-hit.js';
import { getParamRegistry } from '../../lib/dist/index.js';

// A cached render is served again iff everything it was built from is
// unchanged: viewing a file invalidates nothing, and an edit anywhere in the
// module graph — a part, a helper module no session ever opened, the project
// config, an imported asset — makes every render built from it miss.

/** Mirrors LocalSceneHost: buffers keyed by the live-render id, a canned module graph. */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  runs: string[] = [];
  deps = new Map<string, string[]>();
  onLoad: ((file: string) => void) | null = null;

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    const file = filePath.replace('virtual:live-render:', '');
    this.runs.push(file);
    this.onLoad?.(file);
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  invalidateModule(): void {}

  getModuleDependencies(filePath: string): string[] {
    return this.deps.get(filePath.replace('virtual:live-render:', '')) ?? [];
  }
}

let renderInputs: string[] = [];

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [{ id: 'row' }], getAllSceneObjects: () => [] }),
  startAssemblyScene: () => ({ getRenderedObjects: () => [{ id: 'row' }], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
  getAssemblyData: () => null,
  getRenderInputs: () => renderInputs,
});

let workspace: string;
let assembly: string;
let part: string;
let helper: string;
let other: string;
let host: FakeHost;
let server: FluidCadServer;

function write(file: string, content: string): void {
  fs.writeFileSync(file, content);
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-render-cache-'));
  assembly = path.join(workspace, 'rig.assembly.js');
  part = path.join(workspace, 'block.part.js');
  helper = path.join(workspace, 'parameters.js');
  other = path.join(workspace, 'other.fluid.js');
  write(assembly, 'assembly v1');
  write(part, 'part v1');
  write(helper, 'export const rearX = -120;');
  write(other, 'other v1');
  // Present so init() records the workspace without a missing-engine diagnostic.
  write(path.join(workspace, 'init.js'), '');
  renderInputs = [];
  host = new FakeHost();
  host.deps.set(assembly, [assembly, part, helper]);
  host.deps.set(part, [part, helper]);
  host.deps.set(other, [other]);
  server = new FluidCadServer(host);
  await server.init(workspace).catch(() => {});
  server.setSceneManager(fakeSceneManager() as any);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Renders the file ran since `from`. */
const ranSince = (from: number) => host.runs.slice(from);

describe('fingerprint-validated render cache', () => {
  it('opening a dependency and coming back is a hit — no module evaluation', async () => {
    const first = await server.processFile(assembly);
    await server.processFile(part);
    const runs = host.runs.length;
    const back = await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([]);
    expect(back).toBe(first);
  });

  it('a live-update of a dependency with unchanged content keeps the hit', async () => {
    await server.processFile(assembly);
    await server.updateLiveCode(part, 'part v1');
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([]);
  });

  it('editing a dependency in its editor buffer is a miss on the way back', async () => {
    await server.processFile(assembly);
    await server.updateLiveCode(part, 'part v2 with connectors');
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('editing a helper module on disk is a miss, though no session ever opened it', async () => {
    await server.processFile(assembly);
    write(helper, 'export const rearX = -150; // moved');
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('the live-update dedup misses on a helper edit too', async () => {
    await server.updateLiveCode(assembly, 'assembly v1');
    const runs = host.runs.length;
    await server.updateLiveCode(assembly, 'assembly v1');
    expect(ranSince(runs)).toEqual([]);
    write(helper, 'export const rearX = -150; // moved');
    await server.updateLiveCode(assembly, 'assembly v1');
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('a project config edit is a miss', async () => {
    await server.processFile(assembly);
    write(path.join(workspace, 'fluidcad.json'), JSON.stringify({ unit: 'in' }));
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('a param override change is a miss', async () => {
    await server.processFile(assembly);
    server.setParam(assembly, 'width', 40);
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('an asset the engine read is an input like any other', async () => {
    const asset = path.join(workspace, 'imports', 'motor.brep');
    fs.mkdirSync(path.dirname(asset));
    write(asset, 'brep v1');
    renderInputs = [asset];
    await server.processFile(assembly);
    const runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([]);
    write(asset, 'brep v2, re-imported');
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
  });

  it('a file that left the module graph no longer invalidates', async () => {
    await server.processFile(assembly);
    // The assembly stops importing the part: its own text changed, so it misses once…
    host.deps.set(assembly, [assembly, helper]);
    write(assembly, 'assembly v2 without the part');
    let runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
    // …and from then on the part is nobody's input.
    write(part, 'part v2, now unrelated');
    runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([]);
  });

  it('a breakpoint render is never served as a complete one', async () => {
    host.onLoad = () => {
      throw new BreakpointHit();
    };
    const first = await server.processFile(assembly);
    expect(first?.breakpointHit).toBe(true);
    host.onLoad = null;
    // Another file renders to completion in between.
    await server.processFile(other);
    const back = await server.processFile(assembly);
    expect(back?.breakpointHit).toBe(true);
  });

  it('a hit answers with the file\'s own params, not the last rendered file\'s', async () => {
    host.onLoad = (file) => {
      if (file === assembly) {
        getParamRegistry().register({ label: 'width', defaultValue: 25, currentValue: 25, controlType: 'auto' } as any);
      }
    };
    const first = await server.processFile(assembly);
    expect(first?.params?.map(p => p.label)).toEqual(['width']);
    await server.processFile(other);
    expect(server.getParamDefinitions()).toEqual([]);
    const back = await server.processFile(assembly);
    expect(back?.params?.map(p => p.label)).toEqual(['width']);
    expect(server.getParamDefinitions().map(p => p.label)).toEqual(['width']);
  });

  it('a disk-seeded buffer follows its file; an editor buffer does not', async () => {
    await server.processFile(assembly);
    await server.processFile(part);
    // An agent rewrites the part on disk — the seed must not mask it.
    write(part, 'part v2 written straight to disk');
    let runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([assembly]);
    expect(server.getLiveBuffer(part)).toBe('part v2 written straight to disk');

    // Once an editor owns the buffer, disk no longer speaks for the file.
    await server.updateLiveCode(part, 'part v3 unsaved in the editor');
    await server.processFile(assembly);
    write(part, 'part v4 on disk, editor still dirty');
    runs = host.runs.length;
    await server.processFile(assembly);
    expect(ranSince(runs)).toEqual([]);
    expect(server.getLiveBuffer(part)).toBe('part v3 unsaved in the editor');
  });

  it('a render whose inputs cannot be enumerated is never re-served', async () => {
    host.deps.delete(other);
    await server.processFile(other);
    const runs = host.runs.length;
    await server.processFile(other);
    expect(ranSince(runs)).toEqual([other]);
  });
});
