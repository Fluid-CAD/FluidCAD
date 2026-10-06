// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureMetaSnapshot } from '../src/api';
import { FeatureSchema } from '../src/interactive/create-feature/schema/feature-schema';
import { SchemaFeaturePanel } from '../src/interactive/create-feature/schema/schema-feature-panel';

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
    // No default declared: the engine's snapshot carries its first option.
    style: { type: 'select', label: 'Style', options: [{ label: 'Slots', value: 'slot' }, { label: 'Holes', value: 'hole' }], default: 'slot' },
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

function mount(meta: FeatureMetaSnapshot = VENT, opts: ConstructorParameters<typeof FeatureSchema>[1] = {}): { panel: SchemaFeaturePanel; root: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new SchemaFeaturePanel(container, new FeatureSchema(meta, opts), 'icon.svg');
  panel.show();
  return { panel, root: container.querySelector<HTMLElement>(`#fluidcad-feature-${meta.id.replace('.', '-')}`)! };
}

const opTabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('[data-role="op-tabs"] button')];

const shown = (el: Element | null) => el !== null && !el.closest('.hidden');

describe('the schema dialog', () => {
  it('carries no raw OpenCascade mark beside its title — the Custom dropdown cell carries it', () => {
    const marked = mount(VENT, { usesOcct: true }).root;
    expect(marked.querySelector('[data-role="raw-occt"]')).toBeNull();
    expect(marked.querySelector('[data-role="header"]')!.textContent).not.toContain('Raw OpenCascade');
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

  it('shows in each row left alone what the builder gets: an empty choice for an optional select without a default, an empty row for a value without one', () => {
    const { panel, root } = mount({
      ...VENT,
      id: 'acme.label',
      params: {
        finish: { type: 'select', label: 'Finish', optional: true, options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }] },
        title: { type: 'text', label: 'Title' },
        note: { type: 'text', label: 'Note', default: 'vent' },
        depth: { type: 'length', label: 'Depth' },
        pitch: { type: 'length', label: 'Pitch', default: 4 },
      },
    });
    const value = (name: string) => root.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-role="value-${name}"]`)!;
    const field = (name: string) => panel.fields.get(name)!;
    const choose = (index: number) => {
      value('finish').selectedIndex = index;
      value('finish').dispatchEvent(new Event('change'));
    };
    const type = (name: string, text: string) => {
      value(name).value = text;
      value(name).dispatchEvent(new Event('input'));
    };

    // The optional select opens on its empty choice, and holds nothing there.
    expect([...value('finish').options].map(o => o.textContent)).toEqual(['—', 'Matte', 'Gloss']);
    expect(value('finish').selectedIndex).toBe(0);
    expect(panel.scalars().finish).toBeUndefined();
    expect(field('finish').read()).toEqual({ empty: true });
    choose(2);
    expect(field('finish').read()).toEqual({ value: 'gloss' });
    choose(0);
    expect(field('finish').read()).toEqual({ empty: true });
    expect(field('finish').dirty).toBe(true);

    // A text without a default holds nothing while empty, however it got there.
    expect(field('title').read()).toEqual({ empty: true });
    expect(panel.scalars().title).toBeUndefined();
    type('title', 'Rev B');
    expect(field('title').read()).toEqual({ value: 'Rev B' });
    type('title', '');
    expect(field('title').read()).toEqual({ empty: true });
    // One with a default writes the empty text it is cleared to.
    type('note', '');
    expect(field('note').read()).toEqual({ value: '' });

    // An emptied number shows the default the builder falls back on; one without a default shows nothing.
    expect(value('pitch').placeholder).toBe('4');
    expect(value('depth').placeholder).toBe('');
    expect(field('depth').read()).toEqual({ empty: true });

    // An edit seeds the statement's own value, or what the builder fills for one it leaves out.
    panel.showEdit({ values: { finish: 'matte' }, operation: 'remove', seedPicks: () => {} });
    expect(value('finish').selectedIndex).toBe(1);
    expect(field('finish').dirty).toBe(false);
    panel.showEdit({ values: {}, operation: 'remove', seedPicks: () => {} });
    expect(value('finish').selectedIndex).toBe(0);
    expect(value('note').value).toBe('vent');
  });

  it('opens a select and a toggle without a declared default on what the engine resolved — no empty choice', () => {
    const { root } = mount({
      ...VENT,
      id: 'acme.grille',
      params: {
        pattern: { type: 'select', label: 'Pattern', options: [{ label: 'Round', value: 'round' }, { label: 'Slot', value: 'slot' }], default: 'round' },
        chamfered: { type: 'boolean', label: 'Chamfered', default: false },
      },
    });
    const pattern = root.querySelector<HTMLSelectElement>('[data-role="value-pattern"]')!;
    expect([...pattern.options].map(o => o.textContent)).toEqual(['Round', 'Slot']);
    expect(pattern.selectedIndex).toBe(0);
    expect(root.querySelector<HTMLInputElement>('[data-role="value-chamfered"]')!.checked).toBe(false);
  });
});

// The choice rows: a plain select stays the native one; a richer one is a
// button over a popover; a radio shows every option. All three hold, read
// and dirty alike.

const SIZES = ['m3', 'm4', 'm5'].map(v => ({ label: v.toUpperCase(), value: v, image: `./clip/${v}.svg` }));

const CLIP: FeatureMetaSnapshot = {
  ...VENT,
  id: 'acme.clip',
  label: 'Clip',
  params: {
    size: { type: 'select', label: 'Size', default: 'm4', display: 'grid', columns: 2, options: SIZES },
    finish: {
      type: 'select', label: 'Finish', optional: true,
      options: [{ label: 'Matte', value: 'matte', description: 'Bead blasted' }, { label: 'Gloss', value: 'gloss' }],
    },
    stock: {
      type: 'select', label: 'Stock', default: 1, display: 'list',
      options: Array.from({ length: 13 }, (_, i) => ({ label: `Bar ${i + 1}`, value: i + 1 })),
    },
    head: {
      type: 'radio', label: 'Head', default: 'pan', display: 'cards', columns: 3,
      options: [{ label: 'Pan', value: 'pan', image: './clip/pan.svg' }, { label: 'Hex', value: 'hex', image: './clip/hex.svg' }],
    },
    turns: { type: 'radio', label: 'Turns', default: 1, display: 'inline', options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] },
    tone: { type: 'radio', label: 'Tone', default: 'dark', display: 'buttons', options: [{ label: 'Dark', value: 'dark' }, { label: 'Light', value: 'light' }] },
    lock: { type: 'radio', label: 'Lock', optional: true, options: [{ label: 'Nylon', value: 'nylon' }, { label: 'Split', value: 'split' }] },
    washer: { type: 'length', label: 'Washer', default: 1, visibleWhen: { head: 'pan' } },
  },
};

describe('the choice rows of a schema dialog', () => {
  let revision = 0;
  const clip = () => {
    revision = 0;
    const { panel, root } = mount(CLIP, { assetUrl: path => `asset:${path}${revision > 0 ? `?v=${revision}` : ''}` });
    const control = (name: string) => root.querySelector<HTMLElement>(`[data-role="value-${name}"]`)!;
    const field = (name: string) => panel.fields.get(name)!;
    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    /** Open a rich select's popover and press the option captioned `label`. */
    const pick = (name: string, label: string) => {
      control(name).click();
      options().find(o => o.textContent!.includes(label))!.click();
    };
    const radios = (name: string) => [...control(name).querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]')];
    const checked = (name: string) => radios(name).map(r => (r instanceof HTMLInputElement ? r.checked : r.getAttribute('aria-checked') === 'true'));
    return { panel, root, control, field, options, pick, radios, checked };
  };

  afterEach(() => {
    document.querySelectorAll<HTMLElement>('[role="option"]').forEach(o => o.closest<HTMLElement>('[data-mode]')?.remove());
  });

  it('keeps the native select for plain options with no display or search — the row an existing feature has', () => {
    const { root } = mount();
    const row = root.querySelector<HTMLElement>('[data-param="style"]')!;
    expect(row.className).toBe('flex flex-col gap-1.5');
    expect([...row.children].map(c => c.tagName)).toEqual(['SPAN', 'SELECT']);
    const select = row.querySelector('select')!;
    expect(select.dataset.role).toBe('value-style');
    expect(select.className).toBe('select select-sm select-bordered w-full text-xs');
    expect([...select.options].map(o => [o.value, o.textContent])).toEqual([['0', 'Slots'], ['1', 'Holes']]);
    expect(select.selectedIndex).toBe(0);
  });

  it('draws a select with images or a display as a button over a popover: seeded clean, read after a choice', () => {
    const { control, field, options, pick, panel } = clip();
    const size = control('size');
    expect(size.tagName).toBe('BUTTON');
    expect(size.closest<HTMLElement>('[data-param]')!.dataset.param).toBe('size');
    expect(size.textContent).toContain('M4');
    expect(size.querySelector('img')!.getAttribute('src')).toBe('asset:./clip/m4.svg');
    expect(field('size').dirty).toBe(false);
    expect(panel.scalars().size).toBe('m4');

    size.click();
    const panelEl = options()[0].closest<HTMLElement>('[data-mode]')!;
    expect(panelEl.dataset.mode).toBe('grid');
    expect(panelEl.dataset.columns).toBe('2');
    expect(options().map(o => o.textContent!.trim())).toEqual(['M3', 'M4', 'M5']);
    expect(options().map(o => o.querySelector('img')?.getAttribute('src'))).toEqual(SIZES.map(o => `asset:${o.image}`));
    // Three options: no search box unless the declaration asks.
    expect(panelEl.querySelector('input[type="search"]')).toBeNull();
    options()[0].click();
    expect(field('size').read()).toEqual({ value: 'm3' });
    expect(field('size').dirty).toBe(true);
    expect(size.textContent).toContain('M3');
  });

  it('closes a rich select\'s popover when its dialog hides, and when its row does', () => {
    const { control, field, options, panel } = clip();
    control('size').click();
    expect(options().length).toBeGreaterThan(0);
    panel.hide();
    expect(options()).toEqual([]);

    control('size').click();
    expect(options().length).toBeGreaterThan(0);
    field('size').setVisible(false);
    expect(options()).toEqual([]);
  });

  it('searches a rich select above twelve options, and reads a numeric option as its number', () => {
    const { control, field, options, pick } = clip();
    control('stock').click();
    expect(options()).toHaveLength(13);
    expect(options()[0].closest('[data-mode]')!.querySelector('input[type="search"]')).not.toBeNull();
    control('stock').click();
    pick('stock', 'Bar 7');
    expect(field('stock').read()).toEqual({ value: 7 });
  });

  it('offers a rich select that may hold nothing the empty choice, first — chosen, the row writes nothing', () => {
    const { control, field, options, pick, panel } = clip();
    expect(control('finish').textContent).toContain('—');
    expect(field('finish').read()).toEqual({ empty: true });
    expect(panel.scalars().finish).toBeUndefined();
    control('finish').click();
    expect(options().map(o => o.textContent!.trim())).toEqual(['—', 'MatteBead blasted', 'Gloss']);
    control('finish').click();
    pick('finish', 'Gloss');
    expect(field('finish').read()).toEqual({ value: 'gloss' });
    expect(field('finish').dirty).toBe(true);
    pick('finish', '—');
    expect(field('finish').read()).toEqual({ empty: true });
    // An edited statement's value seeds clean; one it lacks shows nothing chosen.
    field('finish').seed('matte');
    expect(control('finish').textContent).toContain('Matte');
    expect(field('finish').dirty).toBe(false);
    field('finish').seed(undefined);
    expect(control('finish').textContent).toContain('—');
  });

  it.each([
    ['head', 'cards', 'hex'],
    ['turns', 'inline', 2],
    ['tone', 'buttons', 'light'],
  ] as const)('seeds, reads and dirties a radio shown as %s (%s)', (name, display, second) => {
    const { control, field, radios, checked, panel } = clip();
    expect(control(name).getAttribute('role')).toBe('radiogroup');
    expect(control(name).dataset.display).toBe(display);
    expect(control(name).closest<HTMLElement>('[data-param]')!.dataset.param).toBe(name);
    expect(checked(name)).toEqual([true, false]);
    expect(field(name).dirty).toBe(false);
    expect(control(name).textContent).not.toContain('Clear');
    radios(name)[1].click();
    expect(checked(name)).toEqual([false, true]);
    expect(field(name).read()).toEqual({ value: second });
    expect(panel.scalars()[name]).toBe(second);
    expect(field(name).dirty).toBe(true);
    field(name).seed(second);
    expect(field(name).dirty).toBe(false);
  });

  it('resolves a radio option\'s image through the dialog, and lays cards out in the declared columns', () => {
    const { control } = clip();
    expect(control('head').dataset.columns).toBe('3');
    expect([...control('head').querySelectorAll('img')].map(i => i.getAttribute('src'))).toEqual(['asset:./clip/pan.svg', 'asset:./clip/hex.svg']);
  });

  it('shows a radio that may hold nothing with none chosen, reads it empty, and clears a choice again', () => {
    const { control, field, radios, checked, panel } = clip();
    expect(control('lock').dataset.display).toBe('list');
    expect(checked('lock')).toEqual([false, false]);
    expect(field('lock').read()).toEqual({ empty: true });
    expect(panel.scalars().lock).toBeUndefined();
    expect(field('lock').dirty).toBe(false);
    radios('lock')[1].click();
    expect(field('lock').read()).toEqual({ value: 'split' });
    const clear = [...control('lock').querySelectorAll('button')].find(b => b.textContent === 'Clear')!;
    clear.click();
    expect(field('lock').read()).toEqual({ empty: true });
    expect(field('lock').dirty).toBe(true);
  });

  it("hides and shows a row whose visibleWhen names a radio's value", () => {
    const { root, radios } = clip();
    const washer = () => root.querySelector('[data-param="washer"]');
    expect(shown(washer())).toBe(true);
    radios('head')[1].click();
    expect(shown(washer())).toBe(false);
    radios('head')[0].click();
    expect(shown(washer())).toBe(true);
  });

  it('asks for the option images again after a save, keeping each row\'s value and whether the user set it', () => {
    const { control, field, radios, checked, panel, options } = clip();
    radios('head')[1].click();
    revision = 3;
    panel.refreshImages();
    expect([...control('head').querySelectorAll('img')].map(i => i.getAttribute('src'))).toEqual(['asset:./clip/pan.svg?v=3', 'asset:./clip/hex.svg?v=3']);
    expect(checked('head')).toEqual([false, true]);
    expect(field('head').dirty).toBe(true);
    expect(control('size').querySelector('img')!.getAttribute('src')).toBe('asset:./clip/m4.svg?v=3');
    expect(field('size').dirty).toBe(false);
    expect(field('size').read()).toEqual({ value: 'm4' });
    control('size').click();
    expect(options()[0].querySelector('img')!.getAttribute('src')).toBe('asset:./clip/m3.svg?v=3');
    // The rebuilt group is the row's control still.
    radios('head')[0].click();
    expect(field('head').read()).toEqual({ value: 'pan' });
  });
});

describe('a select of several in a schema dialog', () => {
  const TREAT: FeatureMetaSnapshot = {
    ...VENT,
    id: 'acme.treat',
    label: 'Treat',
    params: {
      finishes: {
        type: 'select', multiple: true, label: 'Finishes', default: ['deburr'], min: 1, max: 2,
        options: [
          { label: 'Deburr', value: 'deburr', image: './treat/deburr.svg' },
          { label: 'Chamfer', value: 'chamfer', image: './treat/chamfer.svg' },
          { label: 'Polish', value: 'polish', image: './treat/polish.svg' },
        ],
      },
      marks: { type: 'select', multiple: true, label: 'Marks', default: [], options: [{ label: 'Lot', value: 1 }, { label: 'Date', value: 2 }] },
      size: { type: 'length', label: 'Mark size', default: 2, visibleWhen: { finishes: 'polish' } },
    },
  };
  let revision = 0;
  const treat = () => {
    revision = 0;
    const { panel, root } = mount(TREAT, { assetUrl: path => `asset:${path}${revision > 0 ? `?v=${revision}` : ''}` });
    const control = (name: string) => root.querySelector<HTMLElement>(`[data-role="value-${name}"]`)!;
    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    return { panel, root, control, options, field: (name: string) => panel.fields.get(name)! };
  };

  it('opens on the declared lists, nothing the user\'s, and neither row is required', () => {
    const { panel, control, field } = treat();
    expect(control('finishes').textContent).toBe('Deburr');
    expect(control('marks').textContent).toBe('None');
    expect(field('finishes').dirty).toBe(false);
    expect(field('marks').dirty).toBe(false);
    expect(field('finishes').read()).toEqual({ value: ['deburr'] });
    expect(field('marks').read()).toEqual({ value: [] });
    expect(panel.schema.required('finishes')).toBe(false);
    expect(panel.schema.required('marks')).toBe(false);
    panel.hide();
  });

  it('compares no list in a visibleWhen: the row is undefined among the scalars, and a row that names it stays hidden', () => {
    const { panel, control, options, root } = treat();
    expect('finishes' in panel.scalars()).toBe(true);
    expect(panel.scalars().finishes).toBeUndefined();
    control('finishes').click();
    options()[2].click();
    expect(panel.scalars().finishes).toBeUndefined();
    expect(shown(root.querySelector('[data-role="value-size"]'))).toBe(false);
    panel.hide();
  });

  it('toggles with the popover open, says its limits, and closes the popover when the dialog hides', () => {
    const { panel, control, options, field } = treat();
    control('finishes').click();
    options()[0].click();
    expect(control('finishes').textContent).toBe('None');
    expect(field('finishes').read()).toEqual({ error: 'Finishes takes at least 1.' });
    options()[2].click();
    options()[1].click();
    expect(control('finishes').textContent).toBe('Chamfer, Polish');
    options()[0].click();
    expect(control('finishes').textContent).toBe('3 selected');
    expect(field('finishes').read()).toEqual({ error: 'Finishes takes at most 2.' });
    expect(control('finishes').getAttribute('aria-expanded')).toBe('true');
    expect(field('finishes').dirty).toBe(true);

    panel.hide();
    expect(options()).toEqual([]);
    expect(control('finishes').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens an edit on the statement\'s list, the default for one it leaves out, nothing changed', () => {
    const { panel, control, field } = treat();
    panel.showEdit({ values: { finishes: ['polish', 'chamfer'] }, operation: 'remove', seedPicks: () => {} });
    expect(control('finishes').textContent).toBe('Chamfer, Polish');
    expect(field('finishes').read()).toEqual({ value: ['chamfer', 'polish'] });
    expect(control('marks').textContent).toBe('None');
    expect(field('finishes').dirty).toBe(false);
    panel.hide();
  });

  it('asks for its options\' images again on a saved file, keeping the list and staying untouched', () => {
    const { panel, control, options, field } = treat();
    panel.showEdit({ values: { finishes: ['deburr', 'polish'] }, operation: 'remove', seedPicks: () => {} });
    revision = 1;
    panel.refreshImages();
    expect(control('finishes').textContent).toBe('Deburr, Polish');
    expect(field('finishes').dirty).toBe(false);
    control('finishes').click();
    expect(options()[0].querySelector('img')!.getAttribute('src')).toBe('asset:./treat/deburr.svg?v=1');
    expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'true']);
    panel.hide();
  });
});

describe("dependent options in a schema dialog: an option's 'when'", () => {
  const SIZES = [
    { label: 'M3', value: 'm3', when: { standard: 'iso' } },
    { label: 'M4', value: 'm4', when: { standard: 'iso' } },
    { label: '#4', value: 'n4', when: { standard: 'unc' } },
  ];
  const SCREW: FeatureMetaSnapshot = {
    ...VENT,
    id: 'acme.screw',
    label: 'Screw',
    params: {
      standard: { type: 'select', label: 'Standard', default: 'iso', options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }, { label: 'Other', value: 'other' }] },
      // The three select paths — the native one, the popover, the list — and a radio at the end of a chain: standard → size → thread.
      size: { type: 'select', label: 'Size', default: 'm3', options: SIZES },
      grid: { type: 'select', label: 'Grid', default: 'm3', display: 'grid', options: SIZES },
      several: { type: 'select', multiple: true, label: 'Several', default: ['m3'], options: [...SIZES, { label: 'Custom', value: 'custom' }] },
      thread: {
        type: 'radio', label: 'Thread', default: 'coarse',
        options: [{ label: 'Coarse', value: 'coarse', when: { size: 'm3' } }, { label: 'Fine', value: 'fine', when: { size: ['m3', 'm4'] } }, { label: 'UNC', value: 'unc', when: { size: 'n4' } }],
      },
      stamp: { type: 'select', label: 'Stamp', optional: true, options: [{ label: 'Lot', value: 'lot', when: { standard: 'unc' } }] },
    },
  };
  const panels: SchemaFeaturePanel[] = [];
  const screw = () => {
    const { panel, root } = mount(SCREW);
    panels.push(panel);
    const control = (name: string) => root.querySelector<HTMLElement>(`[data-role="value-${name}"]`)!;
    const listed = (name: string) => [...(control(name) as HTMLSelectElement).options].map(option => option.textContent);
    const pick = (name: string, label: string) => {
      const select = control(name) as HTMLSelectElement;
      select.selectedIndex = listed(name).indexOf(label);
      select.dispatchEvent(new Event('change'));
    };
    const field = (name: string) => panel.fields.get(name)!;
    const dirty = () => [...panel.fields].filter(([, each]) => each.dirty).map(([name]) => name);
    // The muted line is made the first time a row has no option; shown is there and not hidden.
    const note = (name: string) => field(name).row.querySelector<HTMLElement>('[data-role="no-options"]');
    const none = (name: string) => ({ hidden: note(name)?.hidden ?? true, textContent: note(name)?.textContent });
    return { panel, root, control, listed, pick, field, dirty, none };
  };

  afterEach(() => {
    panels.splice(0).forEach(panel => panel.destroy());
  });

  it('opens on what the defaults offer, with nothing the user\'s — an untouched create writes nothing', () => {
    const { control, listed, field, dirty, none } = screw();
    expect(listed('size')).toEqual(['M3', 'M4']);
    expect(control('grid').textContent).toContain('M3');
    expect(field('several').read()).toEqual({ value: ['m3'] });
    expect([...control('thread').querySelectorAll('input[type="radio"], [role="radio"]')]).toHaveLength(2);
    expect(dirty()).toEqual([]);
    // An optional row with nothing offered shows so, and holds nothing.
    expect(none('stamp').hidden).toBe(false);
    expect(control('stamp').hidden).toBe(true);
    expect(field('stamp').read()).toEqual({ empty: true });
    expect(none('size').hidden).toBe(true);
  });

  it('moves a choice that fell away to the first one offered, on every path and down the chain, as one change', () => {
    const { panel, control, listed, pick, field, dirty, none } = screw();
    let changes = 0;
    panel.onChange = () => changes++;
    pick('standard', 'Imperial');
    expect(changes).toBe(1);
    expect(listed('size')).toEqual(['#4']);
    expect(field('size').read()).toEqual({ value: 'n4' });
    expect(field('grid').read()).toEqual({ value: 'n4' });
    expect(control('grid').textContent).toContain('#4');
    // A list drops what is no longer offered and keeps the rest.
    expect(field('several').read()).toEqual({ value: [] });
    // The radio waits on `size`, which moved in the same pass.
    expect(field('thread').read()).toEqual({ value: 'unc' });
    expect([...control('thread').querySelectorAll('input[type="radio"], [role="radio"]')]).toHaveLength(1);
    expect(dirty()).toEqual(['standard', 'size', 'grid', 'several', 'thread']);
    // The optional row has an option now, and still holds nothing: it had none to lose.
    expect(none('stamp').hidden).toBe(true);
    expect(listed('stamp')).toEqual(['—', 'Lot']);
    expect(field('stamp').read()).toEqual({ empty: true });
  });

  it('shows "No options" where none is offered, and a required row then blocks with its reason', () => {
    const { control, pick, field, none } = screw();
    pick('standard', 'Other');
    expect(none('size').hidden).toBe(false);
    expect(none('size').textContent).toBe('No options');
    expect(control('size').hidden).toBe(true);
    expect(field('size').read()).toEqual({ error: 'Size has no option to choose.' });
    expect(field('thread').read()).toEqual({ error: 'Thread has no option to choose.' });
    // A list keeps the option that carries no `when`.
    expect(field('several').read()).toEqual({ value: [] });
    expect(none('several').hidden).toBe(true);
    pick('standard', 'Metric');
    expect(none('size').hidden).toBe(true);
    expect(field('size').read()).toEqual({ value: 'm3' });
    expect(field('thread').read()).toEqual({ value: 'coarse' });
  });

  it('shows what an edited statement says though its \'when\' fails, clean until the other values narrow it away', () => {
    const { panel, listed, pick, field, dirty } = screw();
    panel.showEdit({ values: { standard: 'iso', size: 'n4', grid: 'n4', several: ['n4', 'custom'], thread: 'unc' }, operation: 'new', seedPicks: () => {} });
    expect(listed('size')).toEqual(['M3', 'M4', '#4']);
    expect(field('size').read()).toEqual({ value: 'n4' });
    expect(field('grid').read()).toEqual({ value: 'n4' });
    expect(field('several').read()).toEqual({ value: ['n4', 'custom'] });
    expect(field('thread').read()).toEqual({ value: 'unc' });
    expect(dirty()).toEqual([]);
    // Offered under the other standard, it stays and stays clean; back again, it is no longer the statement's to keep.
    pick('standard', 'Imperial');
    expect(dirty()).toEqual(['standard']);
    pick('standard', 'Metric');
    expect(listed('size')).toEqual(['M3', 'M4']);
    expect(field('size').read()).toEqual({ value: 'm3' });
    expect(field('several').read()).toEqual({ value: ['custom'] });
    expect(dirty()).toEqual(['standard', 'size', 'grid', 'several', 'thread']);
    // A fresh dialog after it starts from the defaults again, clean.
    panel.show();
    expect(listed('size')).toEqual(['M3', 'M4']);
    expect(dirty()).toEqual([]);
  });
});
