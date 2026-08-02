import { describe, it, expect, beforeEach } from 'vitest';
import { FluidCadServer } from '../src/fluidcad-server.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import param from '../../lib/dist/core/param.js';

// Params-panel overrides live on the server, on top of whatever the file's
// `param()` calls declare. They have to survive ordinary editing — you drag a
// slider, keep typing code, the value stays — without outliving the default
// they were set against: editing the literal in source is the author saying
// what the value should now be, and the scene has to follow the file.

const FILE = '/ws/model.fluid.js';

/**
 * Stands in for the Vite host: "running" a module means calling `param()` for
 * every `param("label", <number>)` in the buffer, which is the only part of
 * user code this behavior depends on.
 */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  moduleRuns = 0;

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    this.moduleRuns++;
    const code = this.buffers.get(filePath) ?? '';
    for (const m of code.matchAll(/param\("([^"]+)",\s*([\d.]+)\)/g)) {
      param(m[1], Number(m[2]));
    }
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(fileName) ?? null;
  }

  invalidateModule(): void {}
}

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
});

/** `width`/`height` params plus a body line that changes without touching them. */
const source = (width: number, height: number, depth: number) => [
  `const width = param("width", ${width})`,
  `const height = param("height", ${height})`,
  `extrude(${depth})`,
].join('\n');

let host: FakeHost;
let server: FluidCadServer;

const render = (code: string) => server.updateLiveCode(FILE, code);

const values = async (code: string) => {
  const data = await render(code);
  return Object.fromEntries((data?.params ?? []).map((p) => [p.label, p.currentValue]));
};

beforeEach(() => {
  host = new FakeHost();
  server = new FluidCadServer(host);
  server.setSceneManager(fakeSceneManager() as any);
});

describe('param overrides vs. edited defaults', () => {
  it('applies a panel override over the declared default', async () => {
    expect(await values(source(300, 50, 10))).toEqual({ width: 300, height: 50 });

    server.setParam(FILE, 'width', 250);
    const data = await server.recomputeCurrentFile();

    expect(data?.params?.find((p) => p.label === 'width')?.currentValue).toBe(250);
  });

  it('keeps overrides through edits that leave the defaults alone', async () => {
    await render(source(300, 50, 10));
    server.setParam(FILE, 'width', 250);
    server.setParam(FILE, 'height', 80);
    await server.recomputeCurrentFile();

    expect(await values(source(300, 50, 20))).toEqual({ width: 250, height: 80 });
    expect(await values(source(300, 50, 30))).toEqual({ width: 250, height: 80 });
  });

  it("drops the override when the file re-declares that param's default", async () => {
    await render(source(300, 50, 10));
    server.setParam(FILE, 'width', 250);
    server.setParam(FILE, 'height', 80);
    await server.recomputeCurrentFile();

    // The author edits `param("width", 300)` to 100 — the scene renders 100,
    // and only width's override is forgotten.
    expect(await values(source(100, 50, 10))).toEqual({ width: 100, height: 80 });
    expect(server.getParamOverrides(FILE)).toEqual({ height: 80 });
  });

  it('takes a fresh override on the same param after the edit', async () => {
    await render(source(300, 50, 10));
    server.setParam(FILE, 'width', 250);
    await server.recomputeCurrentFile();
    await render(source(100, 50, 10));

    server.setParam(FILE, 'width', 175);
    await server.recomputeCurrentFile();

    expect(await values(source(100, 50, 20))).toEqual({ width: 175, height: 50 });
  });

  it('still dedups an unchanged file after a render dropped an override', async () => {
    await render(source(300, 50, 10));
    server.setParam(FILE, 'width', 250);
    await server.recomputeCurrentFile();
    await render(source(100, 50, 10));

    // The dedup key has to be cut from the post-render overrides; keyed on the
    // pre-render ones it never matches again and every keystroke re-renders.
    const runs = host.moduleRuns;
    await render(source(100, 50, 10));
    expect(host.moduleRuns).toBe(runs);
  });

  it('reset-all still returns every param to its declared default', async () => {
    await render(source(300, 50, 10));
    server.setParam(FILE, 'width', 250);
    server.setParam(FILE, 'height', 80);
    await server.recomputeCurrentFile();

    server.resetParams(FILE);
    const data = await server.recomputeCurrentFile();

    expect(Object.fromEntries((data?.params ?? []).map((p) => [p.label, p.currentValue])))
      .toEqual({ width: 300, height: 50 });
  });
});
