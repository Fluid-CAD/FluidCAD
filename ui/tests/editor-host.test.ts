// @vitest-environment jsdom

// The in-page editor host is the third implementation of the host contract
// (VS Code, Neovim, this). What can silently diverge is *which buffer* an
// edit lands in and *what render* follows it — the assembly work made both
// matter: the mate dialog edits a connector() in a PART file while the
// assembly is on screen, and the parts panel rewrites an insert() chain named
// by its own sourceLocation. This drives the host with a fake model store and
// a recording fetch, and checks the file each POST is made against.

import { describe, it, expect, afterEach, vi } from 'vitest';

// The host re-exports monaco for its callers; the real setup module pulls in
// Vite `?worker` imports that have no meaning under vitest.
vi.mock('../src/editor/monaco-setup', () => ({ monaco: {} }));

import { EditorHost } from '../src/editor/host/editor-host';
import type { ModelEntry, WorkspaceModels } from '../src/editor/models';

const ASSEMBLY = '/ws/robot.assembly.js';
const PART = '/ws/arm.part.js';

type FakeEntry = ModelEntry & { text: string; versionId: number };

function entry(absPath: string, text: string): FakeEntry {
  const e: any = {
    absPath,
    relPath: absPath.slice('/ws/'.length),
    kind: 'model',
    mtimeMs: 0,
    text,
    versionId: 1,
  };
  e.model = {
    getValue: () => e.text,
    getVersionId: () => e.versionId,
    undo: () => { e.versionId++; },
    redo: () => { e.versionId++; },
  };
  return e as FakeEntry;
}

type Recorded = { url: string; body: any };

function install(opts: { loaded: FakeEntry[]; loadable?: FakeEntry[]; current: string | null }) {
  const store = new Map(opts.loaded.map((e) => [e.absPath, e]));
  const loadable = new Map((opts.loadable ?? []).map((e) => [e.absPath, e]));
  const saved: string[] = [];
  const models = {
    get: (absPath: string) => store.get(absPath),
    ensure: async (absPath: string) => {
      const e = store.get(absPath) ?? loadable.get(absPath);
      if (!e) {
        throw new Error(`no such file ${absPath}`);
      }
      store.set(absPath, e);
      return e;
    },
    setContentAsEdit: (absPath: string, content: string) => {
      const e = store.get(absPath);
      if (!e) {
        return false;
      }
      e.text = content;
      e.versionId++;
      return true;
    },
    save: async (absPath: string) => { saved.push(absPath); },
  } as unknown as WorkspaceModels;

  const requests: Recorded[] = [];
  const responses = new Map<string, (body: any) => unknown>();
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    const answer = responses.get(url);
    return {
      ok: true,
      status: 200,
      json: async () => (answer ? answer(body) : {}),
    };
  });

  const reveals: { absPath: string; line?: number; column?: number; revealPane?: boolean }[] = [];
  const host = new EditorHost({
    models,
    currentModelPath: () => opts.current,
    reveal: async (absPath, line, column, revealPane) => {
      reveals.push({ absPath, line, column, revealPane });
    },
  });
  return { host, requests, responses, saved, store, reveals };
}

// vitest runs this repo with `isolate: false`; a stubbed fetch must not
// outlive the test that installed it.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('in-page editor host — which buffer an edit lands in', () => {
  it('applies apply-feature-edit to the model the scene renders from when the spec names no file', async () => {
    const asm = entry(ASSEMBLY, 'const a = 1;');
    const { host, requests, responses } = install({ loaded: [asm], current: ASSEMBLY });
    responses.set('/api/code/apply-feature', () => ({ newCode: 'const a = 2;' }));

    await host.handle({ type: 'apply-feature-edit', spec: { kind: 'x', editId: 'e1' } });

    const apply = requests.find((r) => r.url === '/api/code/apply-feature')!;
    expect(apply.body.code).toBe('const a = 1;');
    expect(asm.text).toBe('const a = 2;');
    const render = requests.find((r) => r.url === '/api/render')!;
    expect(render.body).toEqual({ filePath: ASSEMBLY, code: 'const a = 2;', keepCurrent: false });
  });

  it('applies a cross-file apply-feature-edit to the file the spec names and re-renders the current model', async () => {
    // The mate dialog: connector() written into the PART while the ASSEMBLY
    // is what the viewport shows. Landing it in the assembly would splice a
    // part-scoped statement into the wrong file; rendering the part would
    // flip the viewport away from the assembly.
    const asm = entry(ASSEMBLY, '// assembly');
    const part = entry(PART, '// part');
    const { host, requests, responses, saved } = install({ loaded: [asm, part], current: ASSEMBLY });
    responses.set('/api/code/apply-feature', () => ({ newCode: '// part + connector' }));

    await host.handle({ type: 'apply-feature-edit', spec: { kind: 'connector', filePath: PART, editId: 'e2' } });

    const apply = requests.find((r) => r.url === '/api/code/apply-feature')!;
    expect(apply.body.code).toBe('// part');
    expect(part.text).toBe('// part + connector');
    expect(asm.text).toBe('// assembly');
    expect(saved).toEqual([PART]);
    const render = requests.find((r) => r.url === '/api/render')!;
    expect(render.body).toEqual({ filePath: PART, code: '// part + connector', keepCurrent: true });
  });

  it('loads a named target the workspace scan did not, rather than falling back to the current model', async () => {
    const asm = entry(ASSEMBLY, '// assembly');
    const part = entry(PART, '// part');
    const { host, requests, responses } = install({ loaded: [asm], loadable: [part], current: ASSEMBLY });
    responses.set('/api/code/apply-feature', () => ({ newCode: '// part!' }));

    await host.handle({ type: 'apply-feature-edit', spec: { kind: 'connector', filePath: PART, editId: 'e3' } });

    expect(part.text).toBe('// part!');
    expect(asm.text).toBe('// assembly');
    expect(requests.find((r) => r.url === '/api/render')!.body.filePath).toBe(PART);
  });

  it('drops a cross-file edit whose target cannot be loaded instead of editing the wrong buffer', async () => {
    const asm = entry(ASSEMBLY, '// assembly');
    const { host, requests } = install({ loaded: [asm], current: ASSEMBLY });

    await host.handle({ type: 'apply-feature-edit', spec: { kind: 'connector', filePath: '/ws/missing.part.js', editId: 'e4' } });

    expect(asm.text).toBe('// assembly');
    expect(requests.map((r) => r.url)).not.toContain('/api/code/apply-feature');
  });

  it('routes update-insert-chain to the file its sourceLocation names', async () => {
    const asm = entry(ASSEMBLY, 'const arm1 = insert(arm);');
    const { host, requests, responses } = install({ loaded: [asm], current: ASSEMBLY });
    responses.set('/api/code/update-insert-chain', () => ({ newCode: 'const arm1 = insert(arm).grounded();' }));

    await host.handle({
      type: 'update-insert-chain',
      sourceLocation: { filePath: ASSEMBLY, line: 1, column: 1 },
      edit: { ground: true },
    });

    const req = requests.find((r) => r.url === '/api/code/update-insert-chain')!;
    expect(req.body).toEqual({ code: 'const arm1 = insert(arm);', sourceLine: 1, edit: { ground: true } });
    expect(asm.text).toBe('const arm1 = insert(arm).grounded();');
    expect(requests.find((r) => r.url === '/api/render')!.body.keepCurrent).toBe(false);
  });

  it('marks a path-targeted timeline edit in an imported file keepCurrent', async () => {
    // Removing a feature from an imported part while the assembly is current:
    // the assembly re-renders with the dependency updated (the Neovim bridge's
    // rule for every non-current buffer), the viewport does not switch.
    const asm = entry(ASSEMBLY, '// assembly');
    const part = entry(PART, 'extrude(10);');
    const { host, requests, responses } = install({ loaded: [asm, part], current: ASSEMBLY });
    responses.set('/api/code/remove-statement', () => ({ newCode: '' }));

    await host.handle({ type: 'remove-feature', filePath: PART, line: 1 });

    expect(part.text).toBe('');
    expect(requests.find((r) => r.url === '/api/render')!.body).toEqual({ filePath: PART, code: '', keepCurrent: true });
  });
});

describe('in-page editor host — acked solved-sketch drag write-back', () => {
  // The server's dispatcher holds the drag's HTTP request open until the host
  // answers /api/editor/ack; a host that stays silent is a 5s timeout and a
  // reverted drag in the product. So every case here asserts the ack itself,
  // success and failure alike — that ack is the bug this suite pins.
  const EDITS = [{ sourceLine: 102, points: [{ pointIndex: 0, position: [-60.01, 60], expected: [-60, 60] }] }];

  function ackOf(requests: Recorded[]) {
    return requests.find((r) => r.url === '/api/editor/ack');
  }

  it('applies the edit, re-renders, and acks success', async () => {
    const part = entry(PART, 'circle([-60, 60], 36.58);');
    const { host, requests, responses } = install({ loaded: [part], current: PART });
    responses.set('/api/code/update-sketch-positions', () => ({ newCode: 'circle([-60.01, 60], 36.58);' }));

    await host.handle({ type: 'update-sketch-positions', editId: 'e10', filePath: PART, edits: EDITS });

    const apply = requests.find((r) => r.url === '/api/code/update-sketch-positions')!;
    expect(apply.body).toEqual({ code: 'circle([-60, 60], 36.58);', edits: EDITS });
    expect(part.text).toBe('circle([-60.01, 60], 36.58);');
    expect(requests.find((r) => r.url === '/api/render')!.body.keepCurrent).toBe(false);
    expect(ackOf(requests)!.body).toEqual({ editId: 'e10' });
  });

  it('falls back to the current model when the message names no file', async () => {
    const part = entry(PART, 'circle([0, 0], 5);');
    const { host, requests, responses } = install({ loaded: [part], current: PART });
    responses.set('/api/code/update-sketch-positions', () => ({ newCode: 'circle([1, 0], 5);' }));

    await host.handle({ type: 'update-sketch-positions', editId: 'e11', edits: EDITS });

    expect(part.text).toBe('circle([1, 0], 5);');
    expect(ackOf(requests)!.body).toEqual({ editId: 'e11' });
  });

  it('acks a transform refusal instead of applying it', async () => {
    const part = entry(PART, 'circle([-60, 60], 36.58);');
    const { host, requests, responses } = install({ loaded: [part], current: PART });
    responses.set('/api/code/update-sketch-positions', () => ({
      newCode: 'circle([-60, 60], 36.58);',
      error: 'the sketch moved under this drag',
    }));

    await host.handle({ type: 'update-sketch-positions', editId: 'e12', filePath: PART, edits: EDITS });

    expect(part.text).toBe('circle([-60, 60], 36.58);');
    expect(requests.map((r) => r.url)).not.toContain('/api/render');
    expect(ackOf(requests)!.body).toEqual({ editId: 'e12', error: 'the sketch moved under this drag' });
  });

  it('acks an error when no buffer is open for the named file, rather than staying silent', async () => {
    const { host, requests } = install({ loaded: [], current: null });

    await host.handle({ type: 'update-sketch-positions', editId: 'e13', filePath: '/ws/missing.part.js', edits: EDITS });

    expect(requests.map((r) => r.url)).not.toContain('/api/code/update-sketch-positions');
    expect(ackOf(requests)!.body).toEqual({ editId: 'e13', error: "the sketch's file is not open in the editor" });
  });
});

describe('in-page editor host — goto-source reveal', () => {
  it('passes a passive goto-source through without revealing the pane', async () => {
    // A timeline row click. The pane is a strip beside the scene here (unlike
    // VS Code / Neovim, where the editor *is* the window), so the flag has to
    // survive the trip or every row click pops the code open again.
    const asm = entry(ASSEMBLY, '// assembly');
    const { host, reveals } = install({ loaded: [asm], current: ASSEMBLY });

    await host.handle({ type: 'goto-source', filePath: ASSEMBLY, line: 7, column: 2, revealEditor: false });

    expect(reveals).toEqual([{ absPath: ASSEMBLY, line: 7, column: 2, revealPane: false }]);
  });

  it('reveals for an explicit goto-source, including one from a host that sends no flag', async () => {
    const asm = entry(ASSEMBLY, '// assembly');
    const { host, reveals } = install({ loaded: [asm], current: ASSEMBLY });

    await host.handle({ type: 'goto-source', filePath: ASSEMBLY, line: 3, column: 0, revealEditor: true });
    await host.handle({ type: 'goto-source', filePath: ASSEMBLY, line: 4, column: 0 });

    expect(reveals.map((r) => r.revealPane)).toEqual([true, true]);
  });
});
