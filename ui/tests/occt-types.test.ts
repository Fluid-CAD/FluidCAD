import { afterEach, describe, expect, it, vi } from 'vitest';

// Raw OpenCascade's declarations — the binding's whole API, about 2 MB —
// load the first time a workspace file reaches raw OpenCascade, never
// before: an import of `fluidcad/sdk/occt`, or a feature opening its scope
// with `this.occ(`.

import { OcctTypes } from '../src/editor/occt-types';

type Listener = () => void;

/** A Monaco model as the watch reads it: its text, and its change event. */
class FakeModel {
  private readonly listeners = new Set<Listener>();
  constructor(private text: string) {}
  getValue(): string {
    return this.text;
  }
  setValue(text: string): void {
    this.text = text;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
  onDidChangeContent(listener: Listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  get watched(): number {
    return this.listeners.size;
  }
}

/** Monaco's editor namespace as the watch reads it: the open models, and the event a new one fires. */
function editorWith(...models: FakeModel[]) {
  const created = new Set<(model: any) => void>();
  return {
    getModels: () => models as any[],
    onDidCreateModel(listener: (model: any) => void) {
      created.add(listener);
      return { dispose: () => created.delete(listener) };
    },
    create(model: FakeModel) {
      models.push(model);
      for (const listener of [...created]) {
        listener(model);
      }
    },
    get watching(): number {
      return created.size;
    },
  };
}

afterEach(() => {
  OcctTypes.reset();
});

describe('the OpenCascade declarations', () => {
  it('know what reaches raw OpenCascade', () => {
    expect(OcctTypes.reaches(`import { getOC } from 'fluidcad/sdk/occt';`)).toBe(true);
    expect(OcctTypes.reaches(`const t = await import("fluidcad/sdk/occt");`)).toBe(true);
    expect(OcctTypes.reaches(`return this.occ(({ oc }) => []);`)).toBe(true);
    expect(OcctTypes.reaches(`return this.occ (scope => []);`)).toBe(true);
    expect(OcctTypes.reaches(`import { extrude } from 'fluidcad/core';`)).toBe(false);
    expect(OcctTypes.reaches(`const occ = tool.occ(); // fluidcad/sdk/occtopus`)).toBe(false);
  });

  it('wait until a file reaches it — then load once, and stop watching', () => {
    const load = vi.fn(async () => {});
    const plain = new FakeModel(`import { extrude } from 'fluidcad/core';`);
    const editor = editorWith(plain);
    OcctTypes.watch(editor, load);
    expect(load).not.toHaveBeenCalled();
    expect(OcctTypes.requested).toBe(false);

    plain.setValue(`import { extrude } from 'fluidcad/core';\nimport { getOC } from 'fluidcad/sdk/occt';`);
    expect(load).toHaveBeenCalledOnce();
    expect(OcctTypes.requested).toBe(true);
    expect(plain.watched).toBe(0);
    expect(editor.watching).toBe(0);

    editor.create(new FakeModel(`class T extends Feature { buildTool() { return this.occ(() => []); } }`));
    expect(load).toHaveBeenCalledOnce();
  });

  it('load at once for a file already open that reaches it, and for one opened later', () => {
    const load = vi.fn(async () => {});
    OcctTypes.watch(editorWith(new FakeModel(`export * from 'fluidcad/sdk/occt';`)), load);
    expect(load).toHaveBeenCalledOnce();

    OcctTypes.reset();
    const later = vi.fn(async () => {});
    const editor = editorWith(new FakeModel(''));
    OcctTypes.watch(editor, later);
    editor.create(new FakeModel(`import 'fluidcad/sdk/occt';`));
    expect(later).toHaveBeenCalledOnce();
  });
});
