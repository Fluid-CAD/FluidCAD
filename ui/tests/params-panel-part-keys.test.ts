// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// A parameter is its part + label. Two parts of one file may both declare
// `Width`: each is its own row, a value typed into one goes to that part's
// parameter only (`setParam(label, value, body)`), and where both rows show
// at once each names its part. A single-part file looks as it always did.

import { ParamsPanel } from '../src/ui/params-panel';
import type { ParamEditorDialog, PartChoices } from '../src/ui/param-editor-dialog';
import type { EngineClient } from '../src/engine-client';
import type { UIParamDefinition } from '../src/types';

// jsdom ships no CSS.escape; the in-place value update path uses it with a
// row key that holds quotes (`["Lid","Width"]`), so an identity stand-in
// another test file installed in the shared jsdom will not do.
if (typeof globalThis.CSS === 'undefined' || globalThis.CSS.escape('"') === '"') {
  (globalThis as any).CSS = { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };
}

const FILE = '/ws/pair.part.js';
const bracket = { name: 'Bracket', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
const lid = { name: 'Lid', sourceLocation: { filePath: FILE, line: 13, column: 0 } };

function width(owner: typeof bracket, value: number): UIParamDefinition {
  return {
    label: 'Width', kind: 'part', defaultValue: value, currentValue: value, controlType: 'number',
    part: owner.sourceLocation, body: owner.name,
    sourceLocation: { filePath: FILE, line: owner.sourceLocation.line + 1, column: 2 },
  };
}

function mount(choices?: () => PartChoices) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = { setParam: vi.fn(), resetParams: vi.fn() } as unknown as EngineClient;
  const editor = { openForCreate: vi.fn(), openForEdit: vi.fn() } as unknown as ParamEditorDialog;
  const panel = new ParamsPanel(host, client, editor);
  if (choices) {
    panel.setPartProvider(choices);
  }
  return { host, panel, client, editor };
}

/** Type `value` into a number field and leave it — the blur sends at once. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

const fields = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLInputElement>('input[data-param-label="Width"]'));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ParamsPanel — the same label in two parts', () => {
  it("shows the selected part's Width and sends its value to that part only", () => {
    let choices: PartChoices = { parts: [bracket, lid], selected: lid.sourceLocation };
    const { host, panel, client } = mount(() => choices);
    panel.update([width(bracket, 100), width(lid, 40)]);

    expect(fields(host).map((f) => f.value)).toEqual(['40']);
    type(fields(host)[0], '55');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 55, 'Lid');

    choices = { parts: [bracket, lid], selected: bracket.sourceLocation };
    panel.syncParts();
    expect(fields(host).map((f) => f.value)).toEqual(['100']);
    type(fields(host)[0], '120');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 120, 'Bracket');
  });

  it("updates a row in place from its own part's value, never the other part's", () => {
    const { host, panel } = mount(() => ({ parts: [bracket, lid], selected: lid.sourceLocation }));
    panel.update([width(bracket, 100), width(lid, 40)]);
    const field = fields(host)[0];

    panel.update([{ ...width(bracket, 100), currentValue: 130 }, { ...width(lid, 40), currentValue: 45 }]);
    expect(fields(host)[0]).toBe(field);
    expect(field.value).toBe('45');
  });

  it('names the part beside each of two rows shown together, and edits the one clicked', () => {
    // A host with no timeline lists every part's parameters at once.
    const { host, panel, client, editor } = mount();
    const lidWidth = width(lid, 40);
    panel.update([width(bracket, 100), lidWidth]);

    expect(fields(host).map((f) => f.value)).toEqual(['100', '40']);
    expect(Array.from(host.querySelectorAll('[data-param-owner]'), (el) => el.textContent)).toEqual(['Bracket', 'Lid']);

    type(fields(host)[1], '60');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 60, 'Lid');
    host.querySelectorAll<HTMLButtonElement>('[data-param-edit]')[1].click();
    expect(editor.openForEdit).toHaveBeenCalledWith(lidWidth);
  });

  it('keeps the single-part look: no part name beside the label', () => {
    const { host, panel, client } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    panel.update([width(bracket, 100)]);

    expect(host.querySelector('[data-param-owner]')).toBeNull();
    expect(host.querySelector('label')!.textContent).toBe('Width');
    type(fields(host)[0], '80');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 80, 'Bracket');
  });

  it('sends the label alone for a render that names no body', () => {
    const { host, panel, client } = mount(() => ({ parts: [bracket], selected: bracket.sourceLocation }));
    const { body: _body, ...old } = width(bracket, 100);
    panel.update([old]);
    type(fields(host)[0], '70');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 70, undefined);
  });
});

// Two parts with the same NAME are two parts: each row is keyed by its
// part's hidden identity (the export binding: `plate`, `lid`), shown by the
// name, and the binding follows the name only because it is shared.
describe('ParamsPanel — two parts of one name', () => {
  const plate = { name: 'Plate', body: 'plate', sourceLocation: { filePath: FILE, line: 3, column: 0 } };
  const top = { name: 'Plate', body: 'lid', sourceLocation: { filePath: FILE, line: 9, column: 0 } };
  const widthOf = (owner: typeof plate, value: number): UIParamDefinition => ({
    ...width({ name: owner.name, sourceLocation: owner.sourceLocation }, value),
    body: owner.body,
    bodyName: owner.name,
  });

  it('names both parts apart in the Add to dropdown and sends the chosen part\'s id', () => {
    const { host, panel, client } = mount(() => ({ parts: [plate, top], selected: top.sourceLocation }));
    panel.update([widthOf(plate, 100), widthOf(top, 40)]);
    const options = Array.from(host.querySelectorAll<HTMLOptionElement>('select[data-param-part] option'), (o) => o.textContent);
    expect(options).toEqual(['Plate (plate)', 'Plate (lid)']);
    expect(fields(host).map((f) => f.value)).toEqual(['40']);
    type(fields(host)[0], '55');
    expect(client.setParam).toHaveBeenLastCalledWith('Width', 55, 'lid');
  });

  it('names the part of each of two rows shown together by name and binding', () => {
    const { host, panel } = mount();
    panel.update([widthOf(plate, 100), widthOf(top, 40)]);
    expect(Array.from(host.querySelectorAll('[data-param-owner]'), (el) => el.textContent)).toEqual(['Plate (plate)', 'Plate (lid)']);
  });

  it('keeps the plain name for parts whose names differ', () => {
    const { host, panel } = mount();
    panel.update([widthOf(plate, 100), widthOf({ ...top, name: 'Lid' }, 40)]);
    expect(Array.from(host.querySelectorAll('[data-param-owner]'), (el) => el.textContent)).toEqual(['Plate', 'Lid']);
    const unique = mount(() => ({ parts: [plate, { ...top, name: 'Lid' }], selected: plate.sourceLocation }));
    unique.panel.update([widthOf(plate, 100)]);
    expect(Array.from(unique.host.querySelectorAll<HTMLOptionElement>('select[data-param-part] option'), (o) => o.textContent))
      .toEqual(['Plate', 'Lid']);
  });

  it('falls back to the line for a shared name from an engine that names no body', () => {
    const { host, panel } = mount(() => ({
      parts: [{ name: 'Plate', sourceLocation: plate.sourceLocation }, { name: 'Plate', sourceLocation: top.sourceLocation }],
      selected: plate.sourceLocation,
    }));
    panel.update([]);
    expect(Array.from(host.querySelectorAll<HTMLOptionElement>('select[data-param-part] option'), (o) => o.textContent))
      .toEqual(['Plate (line 3)', 'Plate (line 9)']);
  });
});
