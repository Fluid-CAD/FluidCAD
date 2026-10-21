// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The parameter dialog in its params-file mode: a project parameter is
// addressed by file rather than by part and carries an Identifier — derived
// from the label as it is typed until the user writes one — that goes out
// as `spec.name`. Edits and deletes use the ordinary declaration routes with
// the params file as the target.
//
// The server is a stubbed `fetch`, asserted on the routes and bodies it
// receives — what the server contract is written against. The dialog is
// imported under its own module id: the suite shares one module cache
// (vitest.config.ts: isolate false) and another file binds the plain id to
// a mocked api.

import type { ParamEditorDialog as ParamEditorDialogType } from '../src/ui/param-editor-dialog';
import type { GlobalParam } from '../src/types';

type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
let usage: unknown = null;

beforeEach(() => {
  calls.length = 0;
  usage = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = url.startsWith('api/params/usage') ? usage : { success: true };
    return { ok: true, status: 200, json: async () => payload };
  }));
});

const posted = (url: string) => calls.find((c) => c.url === url && c.method === 'POST');

const FILE = '/ws/project.params.js';

const WALL: GlobalParam = {
  file: FILE, relPath: 'project.params.js', name: 'wall', label: 'Wall thickness',
  controlType: 'slider', defaultValue: 3, value: 3, derived: false, numeric: true,
  min: 1, max: 10, step: 0.5, group: 'Shell', line: 3, column: 0,
};

async function mount() {
  const { ParamEditorDialog } = await import('../src/ui/param-editor-dialog?fresh') as
    { ParamEditorDialog: typeof ParamEditorDialogType };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const dialog = new ParamEditorDialog(root);
  const ref = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return {
    dialog, root, ref, type,
    label: () => ref<HTMLInputElement>('label'),
    identifier: () => ref<HTMLInputElement>('identifier'),
    identifierRow: () => ref('identifier-row'),
    save: () => ref<HTMLButtonElement>('save').click(),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ParamEditorDialog — project parameters', () => {
  it('derives the identifier from the label until the user writes one', async () => {
    const h = await mount();
    h.dialog.openForCreateInFile(FILE);
    expect(h.identifierRow().classList.contains('hidden')).toBe(false);
    expect(h.ref('part-row').classList.contains('hidden')).toBe(true);
    expect(h.ref('expose-row').classList.contains('hidden')).toBe(true);

    h.type(h.label(), 'Wall thickness');
    expect(h.identifier().value).toBe('wallThickness');
    h.type(h.label(), '2nd wall');
    expect(h.identifier().value).toBe('p2ndWall');

    h.type(h.identifier(), 'wall');
    h.type(h.label(), 'Outer wall');
    expect(h.identifier().value).toBe('wall');

    // Clearing it hands it back to the label.
    h.type(h.identifier(), '');
    expect(h.identifier().value).toBe('outerWall');
  });

  it('creates in the params file with the identifier as spec.name', async () => {
    const h = await mount();
    h.dialog.openForCreateInFile(FILE);
    h.type(h.label(), 'Wall thickness');
    h.save();
    await vi.waitFor(() => expect(posted('api/params/add')).toBeDefined());
    expect(posted('api/params/add')!.body).toEqual({
      file: FILE,
      param: { label: 'Wall thickness', name: 'wallThickness', type: 'number', defaultValue: 0 },
    });
    await vi.waitFor(() => expect(h.root.querySelector('.fixed')!.classList.contains('hidden')).toBe(true));
  });

  it('refuses an identifier that is not a JavaScript name, and an empty one', async () => {
    const h = await mount();
    h.dialog.openForCreateInFile(FILE);
    h.type(h.label(), 'Wall');
    h.type(h.identifier(), 'wall-1');
    h.save();
    await Promise.resolve();
    expect(h.ref('message').textContent).toContain("'wall-1' is not a valid identifier");
    expect(posted('api/params/add')).toBeUndefined();

    h.type(h.identifier(), 'class');
    h.save();
    await Promise.resolve();
    expect(h.ref('message').textContent).toContain("'class' is not a valid identifier");

    h.type(h.label(), '');
    h.type(h.identifier(), '');
    h.save();
    await Promise.resolve();
    expect(h.ref('message').textContent).toContain('label');
    expect(posted('api/params/add')).toBeUndefined();
  });

  it('edits with the file as target, the existing identifier seeded and not following the label', async () => {
    const h = await mount();
    usage = {
      label: 'Wall thickness', variable: 'wall', references: 3, referenceLines: [], editable: true,
      usages: [{ filePath: '/ws/a.part.js', count: 2, lines: [4, 9] }, { filePath: '/ws/b.part.js', count: 1, lines: [2] }],
    };
    h.dialog.openForEditGlobal(WALL);
    expect(h.identifier().value).toBe('wall');
    expect(h.label().value).toBe('Wall thickness');
    expect(h.ref<HTMLSelectElement>('type').value).toBe('slider');
    expect(h.ref<HTMLInputElement>('min').value).toBe('1');
    expect(h.ref('edit-actions').classList.contains('hidden')).toBe(false);
    await vi.waitFor(() => expect(h.ref('usage-note').textContent).toBe('Used in 2 files.'));
    const usageCall = calls.find((c) => c.url.startsWith('api/params/usage'))!;
    expect(usageCall.url).toBe(`api/params/usage?label=Wall+thickness&line=3&filePath=${encodeURIComponent(FILE)}`);

    h.type(h.label(), 'Shell thickness');
    expect(h.identifier().value).toBe('wall');
    h.save();
    await vi.waitFor(() => expect(posted('api/params/update')).toBeDefined());
    expect(posted('api/params/update')!.body).toEqual({
      label: 'Wall thickness', line: 3, filePath: FILE,
      param: { label: 'Shell thickness', name: 'wall', type: 'slider', defaultValue: 3, min: 1, max: 10, step: 0.5, group: 'Shell' },
    });
  });

  it('deletes through the declaration route with the file as target', async () => {
    const h = await mount();
    h.dialog.openForEditGlobal(WALL);
    h.ref<HTMLButtonElement>('delete').click();
    h.ref<HTMLButtonElement>('confirm-delete').click();
    await vi.waitFor(() => expect(posted('api/params/remove')).toBeDefined());
    expect(posted('api/params/remove')!.body).toEqual({ label: 'Wall thickness', line: 3, filePath: FILE });
  });

  it('keeps the part flow as it was: no identifier row, the part route', async () => {
    const h = await mount();
    h.dialog.openForCreateInFile(FILE);
    h.dialog.openForCreate(null);
    expect(h.identifierRow().classList.contains('hidden')).toBe(true);
    h.type(h.label(), 'Width');
    h.save();
    await vi.waitFor(() => expect(posted('api/params/add')).toBeDefined());
    expect(posted('api/params/add')!.body).toEqual({ param: { label: 'Width', type: 'number', defaultValue: 0 } });
  });
});
