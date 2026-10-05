// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureMetaSnapshot } from '../src/api';
import { FeatureSchema } from '../src/interactive/create-feature/schema/feature-schema';
import { SchemaFeaturePanel } from '../src/interactive/create-feature/schema/schema-feature-panel';
import { RawOcctMarker } from '../src/interactive/create-feature/schema/raw-occt-marker';

// The dialog a custom feature's metadata draws: each kind of row, the group
// headings and tab panes, rows that come and go with `visibleWhen`, and the
// one armed pick slot moving with them.

afterEach(() => {
  document.body.innerHTML = '';
});

const VENT: FeatureMetaSnapshot = {
  id: 'acme.vent',
  label: 'Vent',
  group: 'create',
  kind: 'tool',
  operations: ['remove'],
  defaultOperation: 'remove',
  params: {
    face: { picker: 'face', label: 'On face' },
    style: { type: 'select', label: 'Style', options: [{ label: 'Slots', value: 'slot' }, { label: 'Holes', value: 'hole' }] },
    count: { type: 'integer', label: 'Count', default: 5, group: 'Pattern' },
    pitch: { type: 'length', label: 'Pitch', default: 4, group: 'Pattern' },
    width: { type: 'length', label: 'Width', default: 2, visibleWhen: { style: 'slot' }, group: 'Slot' },
    rounded: { type: 'boolean', label: 'Rounded ends', default: true, tab: 'Finish' },
    guide: { picker: 'edge', label: 'Along edge', optional: true, tab: 'Finish' },
    note: { type: 'text', label: 'Note', tab: 'Notes', default: 'vent' },
    angle: { type: 'angle', label: 'Angle', default: 0, tab: 'Notes' },
  },
  call: [],
  ghost: true,
  contexts: ['part'],
};

function mount(meta: FeatureMetaSnapshot = VENT, opts: { usesOcct?: boolean } = {}): { panel: SchemaFeaturePanel; root: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new SchemaFeaturePanel(container, new FeatureSchema(meta, opts), 'icon.svg');
  panel.show();
  return { panel, root: container.querySelector<HTMLElement>(`#fluidcad-feature-${meta.id.replace('.', '-')}`)! };
}

const opTabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('[data-role="op-tabs"] button')];

const shown = (el: Element | null) => el !== null && !el.closest('.hidden');

describe('the schema dialog', () => {
  it('marks a feature that reaches raw OpenCascade beside its title, and no other', () => {
    const marked = mount(VENT, { usesOcct: true }).root;
    const mark = marked.querySelector<HTMLElement>('[data-role="header"] [data-role="raw-occt"]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent!.trim()).toBe('Raw OpenCascade');
    expect(mark!.title).toBe(RawOcctMarker.TIP);
    document.body.innerHTML = '';
    expect(mount(VENT).root.querySelector('[data-role="raw-occt"]')).toBeNull();
  });

  it('draws each kind of row with its default', () => {
    const { root } = mount();
    const value = (name: string) => root.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-role="value-${name}"]`)!;
    expect(value('count').value).toBe('5');
    expect(value('style').tagName).toBe('SELECT');
    expect([...value('style').options].map(o => o.textContent)).toEqual(['Slots', 'Holes']);
    expect(value('rounded').type).toBe('checkbox');
    expect(value('rounded').checked).toBe(true);
    expect(value('note').value).toBe('vent');
    expect(root.querySelector('[data-param="angle"] span')!.textContent).toBe('Angle (°)');
  });

  it('gathers grouped rows under their heading and puts tabbed rows on their pane', () => {
    const { root } = mount();
    const pattern = root.querySelector('[data-group="Pattern"]')!;
    expect(pattern.firstElementChild!.textContent).toBe('Pattern');
    expect([...pattern.querySelectorAll('[data-param]')].map(el => (el as HTMLElement).dataset.param)).toEqual(['count', 'pitch']);
    expect([...root.querySelectorAll('[data-role="tabs"] button')].map(b => b.textContent)).toEqual(['Finish', 'Notes']);
    expect(shown(root.querySelector('[data-param="rounded"]'))).toBe(true);
    expect(shown(root.querySelector('[data-param="note"]'))).toBe(false);
    [...root.querySelectorAll<HTMLButtonElement>('[data-role="tabs"] button')][1].click();
    expect(shown(root.querySelector('[data-param="rounded"]'))).toBe(false);
    expect(shown(root.querySelector('[data-param="note"]'))).toBe(true);
  });

  it('hides a row, and a heading left with no row, while visibleWhen fails', () => {
    const { root, panel } = mount();
    const style = root.querySelector<HTMLSelectElement>('[data-role="value-style"]')!;
    style.selectedIndex = 1;
    style.dispatchEvent(new Event('change'));
    expect(shown(root.querySelector('[data-param="width"]'))).toBe(false);
    expect(root.querySelector('[data-group="Slot"]')!.classList.contains('hidden')).toBe(true);
    expect(panel.scalars().style).toBe('hole');
    expect(panel.fields.get('style')!.dirty).toBe(true);
  });

  it('arms one pick slot at a time, never one on a pane out of view', () => {
    const { root, panel } = mount();
    expect(panel.armedSlot).toBe('face');
    panel.armSlot('guide');
    expect(panel.armedSlot).toBe('guide');
    // Switching away from the Finish pane hands the armed state back.
    [...root.querySelectorAll<HTMLButtonElement>('[data-role="tabs"] button')][1].click();
    expect(panel.armedSlot).toBe('face');
    panel.armSlot('guide');
    expect(panel.armedSlot).toBe('face');
  });

  it('keeps the scope row only while the operation has a boolean to narrow', () => {
    const { panel } = mount();
    expect(panel.scopeSlot!.visible).toBe(true);
    panel.armSlot('scope');
    expect(panel.armedSlot).toBe('scope');
  });

  it('shows no operation tabs for a feature with one operation, and still writes it', () => {
    const { panel, root } = mount();
    expect(root.querySelector('[data-role="op-tabs"]')).toBeNull();
    expect(panel.operation).toBe('remove');
    panel.showEdit({ values: {}, operation: 'remove', seedPicks: () => {} });
    expect(root.querySelector('[data-role="op-tabs"]')).toBeNull();
    expect(panel.operation).toBe('remove');

    // A feature that only makes separate bodies has nothing to scope either.
    const apart = mount({ ...VENT, id: 'acme.apart', operations: ['new'], defaultOperation: 'new' });
    expect(apart.root.querySelector('[data-role="op-tabs"]')).toBeNull();
    expect(apart.panel.operation).toBe('new');
    expect(apart.panel.scopeSlot!.visible).toBe(false);

    const plain = mount({ ...VENT, id: 'acme.plain', operations: [], defaultOperation: null });
    expect(plain.panel.operation).toBeNull();
    expect(plain.panel.scopeSlot).toBeNull();
  });

  it('shows the tabs for two operations or more, preselected on the default', () => {
    const { panel, root } = mount({ ...VENT, id: 'acme.pocket', operations: ['new', 'remove'], defaultOperation: 'new' });
    expect(opTabs(root).map(b => b.textContent)).toEqual(['Remove', 'New']);
    const active = () => opTabs(root).filter(b => b.classList.contains('btn-primary')).map(b => b.textContent);
    expect(active()).toEqual(['New']);
    expect(panel.operation).toBe('new');
    expect(panel.scopeSlot!.visible).toBe(false);
    opTabs(root)[0].click();
    expect(panel.operation).toBe('remove');
    expect(panel.scopeSlot!.visible).toBe(true);
    // A fresh dialog opens on the default again; an edit on the statement's own.
    panel.show();
    expect(active()).toEqual(['New']);
    panel.showEdit({ values: {}, operation: 'remove', seedPicks: () => {} });
    expect(active()).toEqual(['Remove']);
  });
});
