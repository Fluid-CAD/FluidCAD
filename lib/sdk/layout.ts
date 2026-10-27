import type { ParamSpec, VisibleWhen } from "./meta.js";

/** A line of text in the dialog: a remark on the rows around it. */
export type FeatureLayoutNote = {
  note: string;
  /** How it reads: plain information when left out. */
  tone?: 'info' | 'warning';
  visibleWhen?: VisibleWhen;
};

/** A picture in the dialog, by relative path next to the module: `'./dims.svg'`. */
export type FeatureLayoutImage = {
  image: string;
  alt?: string;
  /** Its height in pixels, 16 to 480; its own when left out. */
  height?: number;
  visibleWhen?: VisibleWhen;
};

/** A rule between rows. */
export type FeatureLayoutDivider = { divider: true };

/** An item that shows no value: what `aside` is made of. */
export type FeatureStaticItem = FeatureLayoutNote | FeatureLayoutImage | FeatureLayoutDivider;

/** Two to four cells side by side: typed-in values by name, notes, images. */
export type FeatureLayoutRow<N extends string = string> = {
  row: readonly (N | FeatureLayoutNote | FeatureLayoutImage)[];
  /** The cells' relative widths, one per cell; equal when left out. */
  widths?: readonly number[];
  visibleWhen?: VisibleWhen;
};

/** Rows under a heading; `collapsed` opens it folded, and so makes it collapsible. */
export type FeatureLayoutSection<N extends string = string> = {
  section: string;
  items: readonly (N | FeatureLayoutRow<N> | FeatureStaticItem)[];
  collapsible?: boolean;
  collapsed?: boolean;
  visibleWhen?: VisibleWhen;
};

/** One pane of the dialog's tabs. */
export type FeatureLayoutTab<N extends string = string> = {
  label: string;
  items: readonly (N | FeatureLayoutRow<N> | FeatureLayoutSection<N> | FeatureStaticItem)[];
};

/** The dialog's tabs: at the top level only, once. */
export type FeatureLayoutTabs<N extends string = string> = { tabs: readonly FeatureLayoutTab<N>[] };

/**
 * One item of a dialog's layout over the values `P` declares: a value's row
 * by name — so a misspelled name is an error in the editor — a row of
 * cells, a section, the tabs, a note, an image or a divider.
 */
export type FeatureLayoutItem<P = Record<string, unknown>> =
  | (keyof P & string)
  | FeatureLayoutRow<keyof P & string>
  | FeatureLayoutSection<keyof P & string>
  | FeatureLayoutTabs<keyof P & string>
  | FeatureStaticItem;

/** A dialog's layout, top to bottom: every value placed exactly once. */
export type FeatureLayout<P = Record<string, unknown>> = readonly FeatureLayoutItem<P>[];

/** How wide the dialog opens; the default width when left out. */
export type FeatureDialogWidth = 'wide' | 'wider';

/** What the metadata's validator lends the layout's checks: its values, its refusals, its one clause and image check. */
export type FeatureLayoutChecks = {
  params: Record<string, ParamSpec>;
  fail(message: string): never;
  /** The clauses of a `visibleWhen`, checked like a value's. */
  clauses(where: string, value: unknown): void;
  /** A declared image: `${where}'image'` names it in a refusal. */
  image(value: unknown, where: string): string;
  describe(value: unknown): string;
};

type Item = Record<string, unknown>;
type ItemKind = 'row' | 'section' | 'tabs' | 'note' | 'image' | 'divider';

/**
 * A feature dialog's layout tree: checking the one an author wrote, deriving
 * the one a feature without a `layout` gets from its values' `group` and
 * `tab`, and reading the images a tree declares.
 */
export class FeatureLayouts {

  static readonly WIDTHS: readonly FeatureDialogWidth[] = ['wide', 'wider'];

  private static readonly KINDS: readonly ItemKind[] = ['row', 'section', 'tabs', 'note', 'image', 'divider'];

  private static readonly FIELDS: Record<ItemKind, string[]> = {
    row: ['row', 'widths', 'visibleWhen'],
    section: ['section', 'items', 'collapsible', 'collapsed', 'visibleWhen'],
    tabs: ['tabs'],
    note: ['note', 'tone', 'visibleWhen'],
    image: ['image', 'alt', 'height', 'visibleWhen'],
    divider: ['divider'],
  };

  private static readonly TAB_FIELDS = ['label', 'items'];

  private static readonly STATIC: readonly ItemKind[] = ['note', 'image', 'divider'];

  /** What each holder takes besides a value's name, and how a refusal lists it. */
  private static readonly HOLDS: Record<'layout' | 'tab' | 'section' | 'row' | 'aside', { kinds: readonly ItemKind[]; takes: string }> = {
    layout: { kinds: FeatureLayouts.KINDS, takes: 'values, rows, sections, tabs, notes, images and dividers' },
    tab: { kinds: ['row', 'section', 'note', 'image', 'divider'], takes: 'values, rows, sections, notes, images and dividers' },
    section: { kinds: ['row', 'note', 'image', 'divider'], takes: 'values, rows, notes, images and dividers' },
    row: { kinds: ['note', 'image'], takes: 'typed-in values, notes and images' },
    aside: { kinds: FeatureLayouts.STATIC, takes: 'notes, images and dividers' },
  };

  private static readonly HEIGHT = { min: 16, max: 480 };

  private static readonly ROW = { min: 2, max: 4 };

  /** The values placed so far, by name. */
  private readonly placed = new Set<string>();

  private tabbed = false;

  private constructor(private readonly checks: FeatureLayoutChecks) {}

  /**
   * An author's layout, checked and frozen: every item well-formed, every
   * value placed exactly once, no value carrying a `group` or `tab` of its own.
   */
  static check(value: unknown, checks: FeatureLayoutChecks): FeatureLayout {
    const layouts = new FeatureLayouts(checks);
    for (const [name, spec] of Object.entries(checks.params)) {
      for (const field of ['group', 'tab'] as const) {
        if (field in spec) {
          checks.fail(`param '${name}': leave '${field}' out — the layout places it`);
        }
      }
    }
    layouts.items(value, 'layout', "'layout'", 'layout: ');
    for (const name of Object.keys(checks.params)) {
      if (!layouts.placed.has(name)) {
        checks.fail(`the value '${name}' has no place in the layout`);
      }
    }
    return FeatureLayouts.frozen(value) as FeatureLayout;
  }

  /**
   * An `aside` — the dialog's, or a value's (`subject` and `at` then name
   * the value) — checked and frozen: static items only.
   */
  static checkAside(value: unknown, checks: FeatureLayoutChecks, subject = "'aside'", at = 'aside: '): readonly FeatureStaticItem[] {
    new FeatureLayouts(checks).items(value, 'aside', subject, at);
    return FeatureLayouts.frozen(value) as readonly FeatureStaticItem[];
  }

  /**
   * The layout of a feature that declares none, as the dialog always laid
   * its rows out: values in declaration order; a value with a `tab` on that
   * tab's pane, the panes in order of first appearance and gathered in one
   * `tabs` item after every un-tabbed row; at the top level and on each
   * pane, a value with a `group` joins the section its group got where the
   * group first appeared there, an ungrouped value stands alone. One tab
   * still makes a `tabs` item: the "two tabs or more" rule is for a layout
   * an author writes, not for this one.
   */
  static derive(params: Readonly<Record<string, Pick<ParamSpec, 'group' | 'tab'>>>): FeatureLayout {
    const top: unknown[] = [];
    const tabs = new Map<string, unknown[]>();
    const sections = new Map<unknown[], Map<string, string[]>>();
    for (const [name, spec] of Object.entries(params)) {
      let items = top;
      if (spec.tab) {
        items = tabs.get(spec.tab) ?? [];
        tabs.set(spec.tab, items);
      }
      if (spec.group === undefined || spec.group === null) {
        items.push(name);
        continue;
      }
      const groups = sections.get(items) ?? new Map<string, string[]>();
      sections.set(items, groups);
      const names = groups.get(spec.group);
      if (names) {
        names.push(name);
      } else {
        const first = [name];
        groups.set(spec.group, first);
        items.push({ section: spec.group, items: first });
      }
    }
    if (tabs.size > 0) {
      top.push({ tabs: [...tabs].map(([label, items]) => ({ label, items })) });
    }
    return FeatureLayouts.frozen(top) as FeatureLayout;
  }

  /** Every image a layout or an aside declares, in reading order. */
  static images(items: unknown): string[] {
    if (!Array.isArray(items)) {
      return [];
    }
    const paths: string[] = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const entry = item as Item;
      if (typeof entry.image === 'string') {
        paths.push(entry.image);
      }
      paths.push(...FeatureLayouts.images(entry.row), ...FeatureLayouts.images(entry.items), ...FeatureLayouts.images(entry.tabs));
    }
    return paths;
  }

  /** A deep copy of plain data, frozen. */
  private static frozen(value: unknown): unknown {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(entry => FeatureLayouts.frozen(entry)));
    }
    if (value !== null && typeof value === 'object') {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, FeatureLayouts.frozen(entry)])));
    }
    return value;
  }

  /** A holder's list of items: `subject` names the list, `at` prefixes what is said of each item. */
  private items(value: unknown, holder: keyof typeof FeatureLayouts.HOLDS, subject: string, at: string): void {
    if (!Array.isArray(value) || value.length === 0) {
      this.checks.fail(`${subject} must be a non-empty list, got ${this.checks.describe(value)}`);
    }
    for (const item of value) {
      this.item(item, holder, at);
    }
  }

  private item(item: unknown, holder: keyof typeof FeatureLayouts.HOLDS, at: string): void {
    const { kinds, takes } = FeatureLayouts.HOLDS[holder];
    const held = holder === 'layout' ? 'the layout' : holder === 'aside' ? "'aside'" : `a ${holder}`;
    if (typeof item === 'string') {
      if (holder === 'aside') {
        this.checks.fail(`${at}'${item}' is a value's row — 'aside' holds ${takes}`);
      }
      this.place(item, holder, at);
      return;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      this.checks.fail(`${at}an item is a value's name or an object with one of ${FeatureLayouts.KINDS.join(', ')}, got ${this.checks.describe(item)}`);
    }
    const entry = item as Item;
    const found = FeatureLayouts.KINDS.filter(kind => kind in entry);
    if (found.length !== 1) {
      this.checks.fail(`${at}an item has exactly one of ${FeatureLayouts.KINDS.join(', ')}, got ${found.length === 0 ? `{ ${Object.keys(entry).join(', ')} }` : found.join(' and ')}`);
    }
    const kind = found[0];
    const name = FeatureLayouts.nameOf(kind, entry);
    if (kind === 'tabs' && holder !== 'layout') {
      this.checks.fail(`${at}'tabs' sits at the top level of the layout only`);
    }
    if (!kinds.includes(kind)) {
      const why = kind === 'section' && holder === 'section' ? 'no section inside a section' : `${held} holds ${takes}`;
      this.checks.fail(`${at}${name} can't sit here — ${why}`);
    }
    for (const field of Object.keys(entry)) {
      if (!FeatureLayouts.FIELDS[kind].includes(field)) {
        this.checks.fail(`${at}${name}: unknown field '${field}' — ${kind === 'tabs' ? "'tabs' takes" : `a ${kind}'s fields are`} ${FeatureLayouts.FIELDS[kind].join(', ')}`);
      }
    }
    const where = `${at}${name}: `;
    if (entry.visibleWhen !== undefined) {
      this.checks.clauses(`${where}'visibleWhen'`, entry.visibleWhen);
    }
    this[kind](entry, where, at);
  }

  /** A value's row, by name: declared, placed once, typed-in when it is a row's cell. */
  private place(name: string, holder: string, at: string): void {
    const spec = Object.prototype.hasOwnProperty.call(this.checks.params, name) ? this.checks.params[name] : undefined;
    if (!spec) {
      this.checks.fail(`${at}names '${name}', which is not one of the feature's values`);
    }
    if (holder === 'row' && !('type' in spec)) {
      this.checks.fail(`${at}names '${name}' — a picked value takes a full row`);
    }
    if (this.placed.has(name)) {
      this.checks.fail(`the value '${name}' is placed twice in the layout`);
    }
    this.placed.add(name);
  }

  /** How a refusal names an item: `section 'Depth'`, `row [count, start]`, `note 'The holes…'`. */
  private static nameOf(kind: ItemKind, entry: Item): string {
    const value = entry[kind];
    if (kind === 'row') {
      const cells = Array.isArray(value) ? value : [];
      return `row [${cells.map(cell => typeof cell === 'string' ? cell : FeatureLayouts.KINDS.find(k => cell !== null && typeof cell === 'object' && k in cell) ?? '?').join(', ')}]`;
    }
    if (kind === 'tabs' || kind === 'divider' || typeof value !== 'string') {
      return kind;
    }
    return `${kind} '${value.length > 24 ? `${value.slice(0, 24)}…` : value}'`;
  }

  private row(entry: Item, where: string): void {
    const { min, max } = FeatureLayouts.ROW;
    const cells = entry.row;
    if (!Array.isArray(cells) || cells.length < min || cells.length > max) {
      this.checks.fail(`${where}a row is a list of ${min} to ${max} cells, got ${Array.isArray(cells) ? `${cells.length}` : this.checks.describe(cells)}`);
    }
    for (const cell of cells) {
      this.item(cell, 'row', where);
    }
    const widths = entry.widths;
    if (widths !== undefined && (!Array.isArray(widths) || widths.length !== cells.length || widths.some(width => typeof width !== 'number' || !Number.isFinite(width) || width <= 0))) {
      this.checks.fail(`${where}'widths' must be ${cells.length} positive numbers, one per cell, got ${JSON.stringify(widths)}`);
    }
  }

  private section(entry: Item, where: string, at: string): void {
    this.text(entry.section, `${at}a section's title`);
    for (const field of ['collapsible', 'collapsed']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
        this.checks.fail(`${where}'${field}' must be true or false, got ${this.checks.describe(entry[field])}`);
      }
    }
    if (entry.collapsed === true && entry.collapsible === false) {
      this.checks.fail(`${where}'collapsed: true' needs a section that collapses — leave 'collapsible: false' out`);
    }
    this.items(entry.items, 'section', `${where}'items'`, where);
  }

  private tabs(entry: Item, where: string, at: string): void {
    if (this.tabbed) {
      this.checks.fail(`${at}'tabs' is given twice — a layout has one set of tabs`);
    }
    this.tabbed = true;
    const tabs = entry.tabs;
    if (!Array.isArray(tabs) || tabs.length < 2) {
      this.checks.fail(`${at}'tabs' must be a list of two tabs or more, got ${Array.isArray(tabs) ? `${tabs.length}` : this.checks.describe(tabs)}`);
    }
    const labels: string[] = [];
    for (const tab of tabs) {
      if (tab === null || typeof tab !== 'object' || Array.isArray(tab)) {
        this.checks.fail(`${where}a tab is an object { label, items }, got ${this.checks.describe(tab)}`);
      }
      const pane = tab as Item;
      const label = this.text(pane.label, `${where}a tab's 'label'`);
      for (const field of Object.keys(pane)) {
        if (!FeatureLayouts.TAB_FIELDS.includes(field)) {
          this.checks.fail(`${at}tab '${label}': unknown field '${field}' — a tab's fields are ${FeatureLayouts.TAB_FIELDS.join(', ')}`);
        }
      }
      if (labels.includes(label)) {
        this.checks.fail(`${where}two tabs are labelled '${label}'`);
      }
      labels.push(label);
      this.items(pane.items, 'tab', `${at}tab '${label}': 'items'`, `${at}tab '${label}': `);
    }
  }

  private note(entry: Item, where: string, at: string): void {
    this.text(entry.note, `${at}'note'`);
    if (entry.tone !== undefined && entry.tone !== 'info' && entry.tone !== 'warning') {
      this.checks.fail(`${where}'tone' must be one of info, warning, got ${this.checks.describe(entry.tone)}`);
    }
  }

  private image(entry: Item, where: string, at: string): void {
    this.checks.image(entry.image, at);
    if (entry.alt !== undefined && typeof entry.alt !== 'string') {
      this.checks.fail(`${where}'alt' must be a string, got ${this.checks.describe(entry.alt)}`);
    }
    const { min, max } = FeatureLayouts.HEIGHT;
    const height = entry.height;
    if (height !== undefined && (typeof height !== 'number' || !(height >= min && height <= max))) {
      this.checks.fail(`${where}'height' must be a number of pixels from ${min} to ${max}, got ${this.checks.describe(height)}`);
    }
  }

  private divider(entry: Item, _where: string, at: string): void {
    if (entry.divider !== true) {
      this.checks.fail(`${at}'divider' must be true, got ${this.checks.describe(entry.divider)}`);
    }
  }

  private text(value: unknown, subject: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.checks.fail(`${subject} must be a non-empty string, got ${this.checks.describe(value)}`);
    }
    return value;
  }
}
