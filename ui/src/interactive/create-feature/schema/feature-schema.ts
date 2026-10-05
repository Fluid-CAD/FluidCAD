import type {
  FeatureMetaSnapshot, FeatureOpKind, FeatureParam, FeaturePickerKind, FeaturePickerParam, FeatureScalarParam,
  FeatureScalarValue,
} from '../../../api';

/** Rows gathered under one group heading (`group: null` — a row of its own). */
export type SchemaBlock = { group: string | null; names: string[] };

/** Where a feature's rows sit: above the tabs, then one pane per tab. */
export type SchemaLayout = {
  top: SchemaBlock[];
  tabs: { name: string; blocks: SchemaBlock[] }[];
};

const OPERATION_LABELS: Record<FeatureOpKind, { label: string; title: string }> = {
  add: { label: 'Add', title: 'Join the result to the solids it touches' },
  remove: { label: 'Remove', title: 'Cut the result from the solids it touches — .remove()' },
  new: { label: 'New', title: 'Keep the result as a separate body — .new()' },
};

/**
 * A custom feature's dialog, described by its metadata snapshot: which rows
 * it has and where they sit (groups, tabs), when each row shows
 * (`visibleWhen`), what a fresh dialog shows in each, and the checks a
 * typed-in value must pass before the engine sees it. Pure data — the
 * panel renders it and the service drives it.
 */
export class FeatureSchema {
  /**
   * The feature's module reaches raw OpenCascade (the catalog's
   * `usesOcct`): its cell in the Custom dropdown carries the mark; its
   * dialog carries none.
   */
  readonly usesOcct: boolean;

  constructor(readonly meta: FeatureMetaSnapshot, opts: { usesOcct?: boolean } = {}) {
    this.usesOcct = opts.usesOcct === true;
  }

  get id(): string {
    return this.meta.id;
  }

  get label(): string {
    return this.meta.label;
  }

  /** What the feature's button or menu cell says on hover: its label, and its description when it has one. */
  get tip(): string {
    return this.meta.description ? `${this.label} — ${this.meta.description}` : this.label;
  }

  /** Every value's name, in declaration order. */
  get names(): string[] {
    return Object.keys(this.meta.params);
  }

  param(name: string): FeatureParam {
    return this.meta.params[name];
  }

  /** The picked values, in declaration order. */
  get pickerNames(): string[] {
    return this.names.filter(name => FeatureSchema.isPicker(this.param(name)));
  }

  /** The typed-in values, in declaration order. */
  get scalarNames(): string[] {
    return this.names.filter(name => !FeatureSchema.isPicker(this.param(name)));
  }

  static isPicker(spec: FeatureParam): spec is FeaturePickerParam {
    return 'picker' in spec;
  }

  /** A picked value that holds a list. */
  static isList(spec: FeaturePickerParam): boolean {
    return spec.multiple === true || spec.max !== undefined;
  }

  /** The kinds a picked value takes: its picker's one kind, or each kind of a picker of several. */
  static kindsOf(spec: FeaturePickerParam): FeaturePickerKind[] {
    return Array.isArray(spec.picker) ? [...spec.picker] : [spec.picker];
  }

  /** The operations the feature offers, in the product's order (Add, Remove, New), or none. */
  get operations(): { op: FeatureOpKind; label: string; title: string }[] {
    return (['add', 'remove', 'new'] as const)
      .filter(op => this.meta.operations.includes(op))
      .map(op => ({ op, ...OPERATION_LABELS[op] }));
  }

  /**
   * Whether the dialog shows operation tabs: only when there is a choice.
   * A feature with one operation always applies it, so the dialog says
   * nothing about it — a bolt circle that only cuts shows no Remove tab.
   */
  get offersOperationChoice(): boolean {
    return this.operations.length > 1;
  }

  /**
   * The operation a fresh dialog opens on — what a statement without an
   * operation chain does, as the engine's metadata says (Add when offered,
   * else the first the feature lists) — or null for a feature without
   * operations.
   */
  get defaultOperation(): FeatureOpKind | null {
    return this.meta.defaultOperation ?? null;
  }

  /**
   * The rows above the tabs, then each tab's — in the order their first row
   * is declared. Within each, a grouped row joins the heading its group got
   * where the group first appeared; an ungrouped row stands alone.
   */
  layout(): SchemaLayout {
    const top: SchemaBlock[] = [];
    const tabs = new Map<string, SchemaBlock[]>();
    for (const name of this.names) {
      const spec = this.param(name);
      let blocks = top;
      if (spec.tab) {
        blocks = tabs.get(spec.tab) ?? [];
        tabs.set(spec.tab, blocks);
      }
      const group = spec.group ?? null;
      const existing = group === null ? undefined : blocks.find(b => b.group === group);
      if (existing) {
        existing.names.push(name);
      } else {
        blocks.push({ group, names: [name] });
      }
    }
    return { top, tabs: [...tabs].map(([name, blocks]) => ({ name, blocks })) };
  }

  /**
   * Whether a row shows for the typed-in values `scalars`: every value its
   * `visibleWhen` names must equal the one given, or one of a list.
   */
  isVisible(name: string, scalars: Readonly<Record<string, FeatureScalarValue | undefined>>): boolean {
    const when = this.param(name).visibleWhen;
    if (!when) {
      return true;
    }
    return Object.entries(when).every(([other, expected]) => {
      const current = scalars[other];
      return Array.isArray(expected) ? expected.some(e => e === current) : expected === current;
    });
  }

  /**
   * What a fresh dialog shows for a typed-in value, and what the builder
   * fills when a create leaves it out: its default as the engine resolved
   * it — declared, or a boolean's `false` and a select's first option when
   * it declares none — or nothing (a number or a text without a default, an
   * optional select without one). The dialog shows it as it is, so a row
   * left untouched shows what the builder gets.
   */
  defaultOf(name: string): FeatureScalarValue | undefined {
    const spec = this.param(name);
    return FeatureSchema.isPicker(spec) ? undefined : spec.default;
  }

  /**
   * A create must say this value: nothing stands in for one left out — not
   * optional, no default, and (a sketch) not the active sketch implicitly.
   * The dialog shows such a row empty and blocks Apply until it holds one.
   */
  required(name: string): boolean {
    const spec = this.param(name);
    if (spec.optional) {
      return false;
    }
    if (FeatureSchema.isPicker(spec)) {
      return !(spec.picker === 'sketch' && spec.implicitDefault === true);
    }
    return this.defaultOf(name) === undefined;
  }

  /** Why a typed-in number can't be this value, or null — the engine's own checks, before it sees it. */
  static numberError(spec: FeatureScalarParam, value: number): string | null {
    if (spec.type !== 'number' && spec.type !== 'integer' && spec.type !== 'length' && spec.type !== 'angle') {
      return null;
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      return `${spec.label} must be a whole number.`;
    }
    if (spec.min !== undefined && value < spec.min) {
      return `${spec.label} must be at least ${spec.min}.`;
    }
    if (spec.max !== undefined && value > spec.max) {
      return `${spec.label} must be at most ${spec.max}.`;
    }
    return null;
  }
}
