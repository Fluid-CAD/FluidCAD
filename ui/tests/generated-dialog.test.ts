// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyPreviewAnswer, AssemblyPreviewBody, GeneratedCatalogEntry, PreviewWriterRequest } from '../src/api';
import { GeneratedDefinition } from '../src/interactive/generated/generated-definition';
import { GeneratedDialog, type GeneratedEditTarget } from '../src/interactive/generated/generated-dialog';
import { AssemblyPreviewRunner } from '../src/interactive/generated/preview-runner';
import { PreviewTokens } from '../src/interactive/generated/preview-tokens';
import type { SerializedAssembly, SerializedAssemblyInstance, SerializedAssemblyOccurrence } from '../src/types';

// The dialog of a generated part or assembly in an assembly (generators S6):
// the custom-feature dialog over its values, its create and edit previews
// (the bodies it posts), Apply posting exactly the writer request the
// preview rendered, Cancel ending the preview, and what it does when the
// preview ends without it (assembly-preview-ended) or the scene moves on.

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const FILE = '/ws/shop.assembly.js';

function entry(overrides: Partial<GeneratedCatalogEntry> = {}): GeneratedCatalogEntry {
  return {
    file: '/ws/assemblies/crate.assembly.js',
    path: 'assemblies/crate.assembly.js',
    exportName: 'crate',
    kind: 'assembly',
    unit: 'mm',
    schema: {
      kind: 'assembly', definitionKind: 'generated', id: 'crate', label: 'Crate', description: 'A crate with a hinged lid.',
      icon: '../features/icons/crate.svg',
      params: {
        width: { type: 'length', label: 'Width', default: 40, min: 5 },
        depth: { type: 'length', label: 'Depth', default: 30, min: 5 },
        height: { type: 'length', label: 'Height', default: 20, min: 5 },
        finish: { type: 'select', label: 'Finish', default: 'open', options: [{ label: 'Open', value: 'open' }, { label: 'Closed', value: 'closed' }] },
      } as any,
      layout: ['width', 'depth', 'height', 'finish'],
      connectors: [],
      assetBase: { layout: 'definition' },
    },
    assetUrls: {
      definition: { '../features/icons/crate.svg': 'api/part-catalog/asset?icon' },
      class: {},
    },
    ...overrides,
  };
}

type Sent = { body: AssemblyPreviewBody; resolve: (answer: AssemblyPreviewAnswer) => void };

let root: HTMLElement;
let sent: Sent[];
let ended: string[];
let written: PreviewWriterRequest[];
let writeResult: { success: boolean; reason?: string };
let notified: string[];
let active: (string | null)[];
let dialog: GeneratedDialog;

const panelEl = () => document.getElementById('fluidcad-generated-dialog');
const input = (id: string) => panelEl()!.querySelector<HTMLInputElement>(`[data-role="value-${id}"]`)!;
const type = (id: string, value: string) => {
  const el = input(id);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const role = (name: string) => panelEl()!.querySelector<HTMLElement>(`[data-role="${name}"]`)!;
const message = () => role('message').textContent;
const answerAll = async (make: (body: AssemblyPreviewBody) => AssemblyPreviewAnswer = body => ({ state: 'rendered', token: body.token })) => {
  for (const pending of sent.splice(0)) {
    pending.resolve(make(pending.body));
  }
  await vi.advanceTimersByTimeAsync(0);
};
/** Answer every request as it is sent, while `run` goes on (the clock is fake: it is moved here). */
async function answering(run: () => Promise<void>): Promise<void> {
  let done = false;
  const running = run().finally(() => {
    done = true;
  });
  for (let step = 0; step < 100 && !done; step++) {
    await answerAll();
    await vi.advanceTimersByTimeAsync(1);
  }
  await running;
}

function scene(assembly: SerializedAssembly | null, overrides: Partial<{ absPath: string; previewToken: string | null; sceneKind: 'part' | 'assembly' }> = {}) {
  return { absPath: FILE, sceneKind: 'assembly' as const, previewToken: null, assembly, ...overrides };
}

function occurrence(line: number, id = 'asm-0', definition = 'crate'): SerializedAssemblyOccurrence {
  return {
    occurrenceId: id, assemblyName: 'Crate', name: 'crate1', parentPath: '',
    position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, grounded: false, groundConnected: false,
    sourceLocation: { filePath: FILE, line, column: 0 },
    generated: { definition, values: { width: 60, depth: 30, height: 20, finish: 'open' } },
  };
}

const editTarget = (): GeneratedEditTarget => ({
  kind: 'occurrence', row: 'asm-0', name: 'crate1', filePath: FILE, line: 4,
  values: { width: 60, depth: 30, height: 20, finish: 'open' },
});

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
  sent = [];
  ended = [];
  written = [];
  writeResult = { success: true };
  notified = [];
  active = [];
  window.sessionStorage.clear();
  dialog = new GeneratedDialog(root, {
    send: (body) => new Promise(resolve => sent.push({ body, resolve })),
    end: async (token) => {
      ended.push(token);
    },
    write: async (writer) => {
      written.push(writer);
      return writeResult;
    },
    expressions: async () => ({ width: 'w * 2' }),
    variables: async () => [],
    notify: (text) => notified.push(text),
    onActiveChange: (definition) => active.push(definition?.id ?? null),
  });
});

afterEach(() => {
  dialog.cancel();
  vi.useRealTimers();
  root.remove();
  document.body.innerHTML = '';
});

describe('GeneratedDialog create', () => {
  it('opens on the definition\'s defaults, previews them at once, and keeps its token for the tab', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    expect(panelEl()?.classList.contains('hidden')).toBe(false);
    expect(role('title').textContent).toBe('Crate');
    expect(input('width').value).toBe('40');
    expect(active).toEqual(['crate']);
    expect(PreviewTokens.orphan()).toBe(dialog.token);
    expect(sent.map(s => s.body)).toEqual([{
      token: dialog.token, filePath: FILE, detail: 'preview', values: {}, mode: 'create',
      definition: { file: '/ws/assemblies/crate.assembly.js', exportName: 'crate' },
    }]);
    // Values only: no operation tabs, no scope row, no Preview toggle — and Cancel, not Exit.
    expect(panelEl()!.querySelector('[data-role="op-tabs"], [data-role="scope-slot"], [data-role="preview-toggle"]')).toBeNull();
    expect(role('exit').textContent).toBe('Cancel');
  });

  it('previews the values the user sets, by id — a number row\'s expression as source text', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    await answerAll();
    type('width', '80');
    type('depth', 'w * 2');
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS);
    expect(sent.map(s => [s.body.detail, s.body.values])).toEqual([['preview', { width: 80, depth: { expr: 'w * 2' } }]]);
  });

  it('Apply settles a full preview, then posts the insert it rendered, and closes without ending it', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    const token = dialog.token!;
    type('height', '35');
    await answering(() => dialog.apply());
    expect(written).toEqual([{
      route: 'part-catalog/insert',
      body: { inserts: [{ file: '/ws/assemblies/crate.assembly.js', exportName: 'crate', kind: 'value', params: { height: 35 } }] },
    }]);
    expect(dialog.isOpen).toBe(false);
    expect(panelEl()).toBeNull();
    expect(ended).toEqual([]);
    expect(PreviewTokens.orphan()).toBeNull();
    expect(active.at(-1)).toBeNull();
    // The full preview the write was served from went out first.
    expect(token).toBeTruthy();
  });

  it('keeps the dialog open with the refusal when Apply is refused, or the result doesn\'t compile', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    writeResult = { success: false, reason: 'Insert targets an assembly' };
    await answering(() => dialog.apply());
    expect(dialog.isOpen).toBe(true);
    expect(message()).toBe('Insert targets an assembly');
    expect(role('apply').hasAttribute('disabled')).toBe(false);

    type('width', '90');
    const applying = dialog.apply();
    await vi.advanceTimersByTimeAsync(0);
    await answerAll(body => ({ state: 'compile-error', token: body.token, compileError: { message: 'Unexpected token' } }));
    await applying;
    expect(message()).toBe("The result doesn't compile: Unexpected token");
    expect(written).toHaveLength(1);
  });

  it('refuses Apply with a required value left empty, naming it', async () => {
    const required = entry();
    (required.schema.params as any).count = { type: 'integer', label: 'Count' };
    required.schema.layout = [...required.schema.layout, 'count'];
    dialog.openCreate(new GeneratedDefinition(required), FILE);
    await dialog.apply();
    expect(message()).toBe('Count is required.');
    expect(written).toHaveLength(0);
  });

  it('Cancel ends the preview by its token, and Escape is Cancel', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    const token = dialog.token!;
    role('exit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toEqual([token]);
    expect(dialog.isOpen).toBe(false);
    expect(PreviewTokens.orphan()).toBeNull();

    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(dialog.isOpen).toBe(false);
  });

  it('says what a preview answered: a build error, a refusal', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    await answerAll(body => ({ state: 'build-error', token: body.token, objectErrors: [{ name: 'crate1', message: "the lid can't fit" }] }));
    expect(message()).toBe("crate1: the lid can't fit");
    type('width', '50');
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS);
    await answerAll(body => ({ state: 'refused', token: body.token, status: 422, reason: 'No such export' }));
    expect(message()).toBe('No such export');
  });
});

describe('GeneratedDialog edit', () => {
  it('opens on the insert\'s values (its expressions as written) and previews nothing until a value changes', async () => {
    await dialog.openEdit(new GeneratedDefinition(entry()), editTarget());
    expect(role('title').textContent).toBe('Edit crate1');
    expect(input('width').value).toBe('w * 2');
    expect(input('depth').value).toBe('30');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(0);
  });

  it('previews the changed values and the emptied ones (back to the default), with its line and row', async () => {
    await dialog.openEdit(new GeneratedDefinition(entry()), editTarget());
    type('height', '35');
    type('depth', '');
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS);
    expect(sent.map(s => s.body)).toEqual([{
      token: dialog.token, filePath: FILE, detail: 'preview', values: { height: 35 }, mode: 'edit', line: 4, unset: ['depth'], row: 'asm-0',
    }]);
    await answering(() => dialog.apply());
    expect(written).toEqual([{
      route: 'update-insert-params',
      body: { filePath: FILE, sourceLine: 4, set: { height: 35 }, unset: ['depth'], row: 'asm-0' },
    }]);
    expect(dialog.isOpen).toBe(false);
  });

  it('Apply with nothing changed closes, writing nothing and ending nothing', async () => {
    await dialog.openEdit(new GeneratedDefinition(entry()), editTarget());
    await dialog.apply();
    expect(dialog.isOpen).toBe(false);
    expect(written).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('follows its insert\'s line through a render, by its row; closes when the insert is gone', async () => {
    await dialog.openEdit(new GeneratedDefinition(entry()), editTarget());
    dialog.handleSceneRendered(scene({ instances: [], mates: [], occurrences: [occurrence(9)] }));
    type('height', '25');
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS);
    expect((sent[0].body as { line: number }).line).toBe(9);

    dialog.handleSceneRendered(scene({ instances: [], mates: [], occurrences: [occurrence(9, 'asm-0', 'other')] }));
    expect(dialog.isOpen).toBe(false);
    expect(notified).toEqual(['crate1 is no longer in the assembly, so the dialog closed.']);
    expect(ended).toHaveLength(1);
  });
});

describe('GeneratedDialog and the preview ending without it', () => {
  it('replaced: the next scene of its file rebuilds the preview, saying why; a preview scene changes nothing', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    await answerAll();
    type('width', '70');
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS + AssemblyPreviewRunner.SETTLE_MS);
    await answerAll();
    dialog.handlePreviewEnded(dialog.token!, 'replaced');
    dialog.handleSceneRendered(scene(null, { previewToken: 'someone-else' }));
    expect(sent).toHaveLength(0);
    dialog.handleSceneRendered(scene({ instances: [], mates: [] }));
    expect(sent.map(s => [s.body.detail, s.body.values])).toEqual([['preview', { width: 70 }]]);
    expect(role('preview-note').textContent).toBe('The model changed, so the preview was rebuilt.');
    expect(role('preview-note').classList.contains('hidden')).toBe(false);
    // The next change clears the note.
    type('width', '75');
    expect(role('preview-note').classList.contains('hidden')).toBe(true);
    // Only once: a later scene re-arms nothing.
    await answerAll();
    await vi.advanceTimersByTimeAsync(AssemblyPreviewRunner.TYPING_MS + AssemblyPreviewRunner.SETTLE_MS);
    await answerAll();
    dialog.handleSceneRendered(scene({ instances: [], mates: [] }));
    expect(sent).toHaveLength(0);
  });

  it('superseded, closed and end close the dialog and say why; another token\'s end is not its own', async () => {
    const cases: ['superseded' | 'closed' | 'end', string][] = [
      ['superseded', 'Another preview took over, so the dialog closed.'],
      ['closed', 'The assembly was closed, so the dialog closed.'],
      ['end', 'The preview was ended, so the dialog closed.'],
    ];
    for (const [reason, text] of cases) {
      dialog.openCreate(new GeneratedDefinition(entry()), FILE);
      dialog.handlePreviewEnded('another-token', reason);
      expect(dialog.isOpen).toBe(true);
      dialog.handlePreviewEnded(dialog.token!, reason);
      expect(dialog.isOpen).toBe(false);
      expect(notified.at(-1)).toBe(text);
    }
  });

  it('closes when another file (or a part) comes on screen', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    dialog.handleSceneRendered(scene({ instances: [], mates: [] }, { absPath: '/ws/other.assembly.js' }));
    expect(dialog.isOpen).toBe(false);
    expect(notified).toEqual(['The assembly is no longer on screen, so the dialog closed.']);
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    dialog.handleSceneRendered(scene(null, { sceneKind: 'part' }));
    expect(dialog.isOpen).toBe(false);
  });

  it('ignores the end of its preview its own Apply causes', async () => {
    dialog.openCreate(new GeneratedDefinition(entry()), FILE);
    let finish!: (result: { success: boolean }) => void;
    const token = dialog.token!;
    (dialog as any).hooks.write = (writer: PreviewWriterRequest) => {
      written.push(writer);
      return new Promise(resolve => { finish = resolve; });
    };
    const applying = answering(() => dialog.apply());
    await vi.waitFor(() => expect(written).toHaveLength(1));
    dialog.handlePreviewEnded(token, 'replaced');
    dialog.handleSceneRendered(scene({ instances: [], mates: [] }));
    finish({ success: true });
    await applying;
    expect(dialog.isOpen).toBe(false);
    expect(notified).toEqual([]);
    expect(ended).toEqual([]);
  });
});

describe('GeneratedDialog.editTargetOf (Edit parameters routing)', () => {
  const instance = (generated?: SerializedAssemblyInstance['generated']): SerializedAssemblyInstance => ({
    instanceId: 'inst-2', partId: 'p', partName: 'Spur gear', name: 'gear1',
    position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, grounded: true,
    sourceLocation: { filePath: FILE, line: 3, column: 0 },
    ...(generated ? { generated } : {}),
  });

  it('opens a generated assembly\'s occurrence and a generated part\'s instance in the schema dialog', () => {
    expect(GeneratedDialog.editTargetOf(occurrence(4))).toEqual({ definition: 'crate', target: editTarget() });
    expect(GeneratedDialog.editTargetOf(instance({ definition: 'spur', values: { teeth: 18 } }))).toEqual({
      definition: 'spur',
      target: { kind: 'instance', row: 'inst-2', name: 'gear1', filePath: FILE, line: 3, values: { teeth: 18 } },
    });
  });

  it('leaves every other record to the param() form', () => {
    expect(GeneratedDialog.editTargetOf(instance())).toBeNull();
    const plain = occurrence(4);
    delete plain.generated;
    expect(GeneratedDialog.editTargetOf(plain)).toBeNull();
  });
});

describe('GeneratedDefinition', () => {
  it('serves its icon and images by the module each resolves against, the class\'s first', () => {
    const definition = new GeneratedDefinition(entry({
      assetUrls: { definition: { '../features/icons/crate.svg': 'u/icon', './a.svg': 'u/def-a' }, class: { './a.svg': 'u/class-a', './b.svg': 'u/b' } },
    }));
    expect(definition.iconSrc).toBe('u/icon');
    expect(definition.assetUrl('./b.svg')).toBe('u/b');
    expect(definition.assetUrl('./a.svg')).toBe('u/class-a');
    expect(definition.assetUrl('./nowhere.svg')).toBe('./nowhere.svg');
    expect(definition.tip).toBe('Crate — A crate with a hinged lid.');
  });

  it('writes a row\'s value as an insert takes it, by the value\'s kind', () => {
    const definition = new GeneratedDefinition(entry());
    expect(definition.insertValue('width', 80)).toBe(80);
    expect(definition.insertValue('width', 'w * 2')).toEqual({ expr: 'w * 2' });
    expect(definition.insertValue('finish', 'closed')).toBe('closed');
    expect(definition.insertValue('finish', { ref: 'lidFinish' })).toEqual({ expr: 'lidFinish' });
    expect(definition.insertValue('finish', { expr: "open ? 'open' : 'closed'" })).toEqual({ expr: "open ? 'open' : 'closed'" });
    expect(definition.seedValue('width', 60, 'w * 2')).toBe('w * 2');
    expect(definition.seedValue('finish', 'open', 'lidFinish')).toEqual({ expr: 'lidFinish' });
    expect(definition.seedValue('depth', 30, undefined)).toBe(30);
  });
});

describe('PreviewTokens', () => {
  it('ends the preview a reloaded tab left behind, once', async () => {
    const token = PreviewTokens.create();
    const end = vi.fn(async () => {});
    await PreviewTokens.endOrphan(end);
    await PreviewTokens.endOrphan(end);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(token);
    expect(PreviewTokens.orphan()).toBeNull();
  });

  it('forgets a token only when it is still the tab\'s', () => {
    const first = PreviewTokens.create();
    const second = PreviewTokens.create();
    PreviewTokens.release(first);
    expect(PreviewTokens.orphan()).toBe(second);
    PreviewTokens.release(second);
    expect(PreviewTokens.orphan()).toBeNull();
  });
});
