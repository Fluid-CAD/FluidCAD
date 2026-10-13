import type {
  FeatureLayoutItem, FeatureLayoutSection,
  FeatureMetaSnapshot, FeatureOpKind, FeatureParam, FeaturePickerKind, FeaturePickerParam, FeatureScalarParam,
  FeatureListValue,
  FeatureOptionWhen,
  FeaturePickCondition,
  FeaturePickedSurface,
  FeaturePickState,
  FeatureScalarValue,
  FeatureVisibleWhen,
} from '../../../api';

/** The values a `visibleWhen` reads: typed-in values by name, and each picked value's {@link FeaturePickState}. */
export type DialogValues = Readonly<Record<string, FeatureScalarValue | FeaturePickState | undefined>>;

const OPERATION_LABELS: Record<FeatureOpKind, { label: string; title: string }> = {
  add: { label: 'Add', title: 'Join the result to the solids it touches' },
  remove: { label: 'Remove', title: 'Cut the result from the solids it touches — .remove()' },
  new: { label: 'New', title: 'Keep the result as a separate body — .new()' },
};

/**
 * A custom feature's dialog, described by its metadata snapshot: which rows
 * it has and where they sit (the layout tree), when each row shows
 * (`visibleWhen`), what a fresh dialog shows in each, and the checks a
 * typed-in value must pass before the engine sees it. Pure data — the
 * panel renders it and the service drives it.
 */
export class FeatureSchema {
  private readonly resolveAsset: ((path: string) => string) | undefined;

  /**
   * `assetUrl`: where a file the feature declares is served (the catalog's,
   * for a workspace feature). A built-in declares none.
   */
  constructor(readonly meta: FeatureMetaSnapshot, opts: { assetUrl?: (path: string) => string } = {}) {
    this.resolveAsset = opts.assetUrl;
  }

  /**
   * Where a declared file (an option's image) is served, as of the module's
   * latest save — asked again after one, the answer fetches the file fresh.
   * With nowhere to serve it from, the path as declared.
   */
  assetUrl(path: string): string {
    return this.resolveAsset ? this.resolveAsset(path) : path;
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
   * Where every row sits: the tree the engine resolved — the author's, or
   * the one it derived from the values' `group` and `tab`. A snapshot
   * without one lists the values in declaration order.
   */
  layout(): FeatureLayoutItem[] {
    return this.meta.layout ?? this.names;
  }

  /** The declared value names an item places, in the order they read — the item itself when it is one. */
  static namesIn(item: FeatureLayoutItem): string[] {
    if (typeof item === 'string') {
      return [item];
    }
    if ('row' in item) {
      return item.row.filter((cell): cell is string => typeof cell === 'string');
    }
    if ('section' in item) {
      return item.items.flatMap(each => FeatureSchema.namesIn(each));
    }
    if ('tabs' in item) {
      return item.tabs.flatMap(tab => tab.items.flatMap(each => FeatureSchema.namesIn(each)));
    }
    return [];
  }

  /** Whether an item's own `visibleWhen` holds; an item that takes none always shows. */
  static itemShows(item: FeatureLayoutItem, scalars: DialogValues): boolean {
    if (typeof item === 'string' || 'divider' in item || 'tabs' in item) {
      return true;
    }
    return FeatureSchema.holds(item.visibleWhen, scalars);
  }

  /** Whether a section folds: `collapsible`, or `collapsed` — which starts it folded. */
  static folds(section: FeatureLayoutSection): boolean {
    return section.collapsible === true || section.collapsed === true;
  }

  /**
   * Whether a row shows for the values the dialog holds now: every typed-in
   * value its `visibleWhen` names must equal the one given, or one of a
   * list, and every picked value it names must meet its condition.
   */
  isVisible(name: string, scalars: DialogValues): boolean {
    return FeatureSchema.holds(this.param(name).visibleWhen, scalars);
  }

  /**
   * Whether every clause of a value's `visibleWhen` or of an option's `when`
   * holds for the values the dialog shows now: a typed-in value by equality,
   * a picked value (its {@link FeaturePickState}; none, nothing picked) by
   * its condition. No clauses always hold; an option's `when` that is a list
   * holds when any one of its cases does.
   */
  static holds(when: FeatureVisibleWhen | FeatureOptionWhen | undefined, scalars: DialogValues): boolean {
    if (Array.isArray(when)) {
      return when.some(each => FeatureSchema.holds(each, scalars));
    }
    return Object.entries(when ?? {}).every(([other, expected]) => {
      const current = scalars[other];
      if (FeatureSchema.isPickCondition(expected)) {
        const state = typeof current === 'object' ? current : undefined;
        return FeatureSchema.pickHolds(expected, state?.picks ?? []);
      }
      return Array.isArray(expected) ? expected.some(e => e === current) : expected === current;
    });
  }

  /** Whether a clause's expected value is a picked value's condition (an object), not values to match. */
  static isPickCondition(expected: unknown): expected is FeaturePickCondition {
    return typeof expected === 'object' && expected !== null && !Array.isArray(expected);
  }

  /** Whether a picked value holding `picks` (each pick's surface, null for no face) meets `condition`. */
  static pickHolds(condition: FeaturePickCondition, picks: readonly (FeaturePickedSurface | null)[]): boolean {
    if (condition.picked !== undefined && condition.picked !== picks.length > 0) {
      return false;
    }
    if (condition.surface !== undefined) {
      const wanted = Array.isArray(condition.surface) ? condition.surface : [condition.surface];
      if (picks.length === 0 || !picks.every(surface => surface !== null && wanted.includes(surface))) {
        return false;
      }
    }
    return condition.not === undefined || !FeatureSchema.pickHolds(condition.not, picks);
  }

  /**
   * What a fresh dialog shows for a typed-in value, and what the builder
   * fills when a create leaves it out: its default as the engine resolved
   * it — declared, or a boolean's `false` and a select's first option when
   * it declares none — or nothing (a number or a text without a default, an
   * optional select without one). The dialog shows it as it is, so a row
   * left untouched shows what the builder gets.
   */
  defaultOf(name: string): FeatureScalarValue | FeatureListValue | undefined {
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
    // A list always stands for itself: left out it is its default, and that may be empty.
    if (spec.type === 'select' && spec.multiple) {
      return false;
    }
    return this.defaultOf(name) === undefined;
  }

  /** Why a typed-in number can't be this value, or null — the engine's own checks, before it sees it. */
  /** A value's `hint` as a line of small text at the end of its row — a typed-in row's and a picker's alike. */
  static appendHint(row: HTMLElement, hint: string | undefined): void {
    if (!hint) {
      return;
    }
    const line = document.createElement('div');
    line.dataset.role = 'hint';
    line.className = 'w-full text-[11px] text-base-content/50';
    line.textContent = hint;
    row.classList.add('flex-wrap');
    row.append(line);
  }

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
