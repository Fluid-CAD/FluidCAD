import type { ParamDefinition, SelectOption } from "../param-registry.js";
import { Feature, type FeatureClass } from "./feature.js";
import type { FeatureScalar, FeatureValues } from "./feature-inputs.js";
import { FeatureCall, type CallShape, type FeatureOperation } from "./call-shape.js";
import { FeatureKey } from "./feature-key.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import { SceneTypes } from "../common/scene-types.js";
import { FeatureLayouts, type FeatureDialogWidth, type FeatureLayout, type FeatureStaticItem } from "./layout.js";
import { SchemaValidator, ValueSchema } from "./value-schema.js";

/** Where a feature's button sits: with the features that make solids, or those that change them. */
export type FeatureGroup = 'create' | 'modify';

/**
 * How a feature builds: a `tool` returns its solids from `buildTool()` and
 * the base applies the operation; a `modifier` overrides `build()`. It must
 * match the class.
 */
export type FeatureKind = 'tool' | 'modifier';

/** Where a feature may be used: `part` is a part body or a part file. */
export type FeatureContext = 'part';

/**
 * How a feature's dialog draws its preview: `toggle` behind a Preview toggle
 * the user turns on (for a build that may be slow), `always` from the start
 * with no toggle (for a cheap one).
 */
export type FeatureGhostMode = 'toggle' | 'always';

/** A value the dialog types in: lengths are in the document's unit, angles in degrees. */
export type ScalarParamType = 'number' | 'integer' | 'length' | 'angle' | 'boolean' | 'select' | 'radio' | 'text';

/** A value the dialog picks in the viewport or the timeline. */
export type PickerKind = 'sketch' | 'face' | 'edge' | 'axis' | 'plane' | 'solid' | 'feature' | 'connector' | 'point' | 'anchor';

/** What a picked face is, as a `visibleWhen` tells picked faces apart: a face picker's `surface` names and a few more. */
export type PickedSurface = 'planar' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** The surfaces a {@link PickCondition} may name. */
export { PICKED_SURFACES } from "./value-schema.js";

/**
 * A condition on a picked value, for a `visibleWhen` that names it — every
 * field given must hold:
 * - `picked`: whether the value holds anything;
 * - `count`: the value holds this many picks (or one of these counts) — a
 *   face picked as a statement's faces counts each face;
 * - `surface`: the value holds picks, and each is a face of this surface (or
 *   of one of these);
 * - `not`: the condition given does not hold.
 *
 * `{ at: { not: { surface: 'cylinder' } } }` shows a row until a cylindrical
 * face is picked for `at`; `{ at: { picked: false } }` while nothing is;
 * `{ faces: { not: { count: 3 } } }` until a third face is.
 */
export type PickCondition = {
  readonly picked?: boolean;
  readonly count?: number | readonly number[];
  readonly surface?: PickedSurface | readonly PickedSurface[];
  readonly not?: PickCondition;
};

/**
 * One case an option is offered in: every named typed-in value must equal
 * the given one, or one of the listed ones — `{ style: ['counterbore', 'countersink'], thin: true }`.
 */
export type OptionCase = { readonly [param: string]: FeatureScalar | readonly FeatureScalar[] };

/**
 * When an option is offered: one {@link OptionCase}, or a list of them of
 * which any one holds — `[{ shape: 'single', height: 40 }, { shape: 'double', height: [20, 80] }]`.
 */
export type OptionWhen = OptionCase | readonly OptionCase[];

/**
 * When a value's row (or a layout item) shows: every named typed-in value
 * must equal the given one, or one of the listed ones, and every named picked
 * value must meet its {@link PickCondition} —
 * `{ style: ['counterbore', 'countersink'], at: { not: { surface: 'cylinder' } } }`.
 */
export type VisibleWhen = { readonly [param: string]: FeatureScalar | readonly FeatureScalar[] | PickCondition };

/**
 * One conditional default of a typed-in value: the value it takes while
 * `when` holds — the grammar of an option's `when` ({@link OptionWhen}),
 * naming typed-in values that declare no `defaults` themselves (one level:
 * no chains, no circles) and no picked ones.
 *
 * A value's `defaults` are read in order: the first entry whose `when`
 * holds is its default, and its plain `default` applies when none does —
 * for a call that leaves the value out (worked out from the call's other
 * values, their own defaults filled), and for a dialog row the user has not
 * touched, which follows it live. Each `value` is checked as `default` is —
 * its type, range and options — and must be offered where its `when` holds
 * while the other values sit at their defaults. A value with `defaults`
 * needs a plain default to fall back on.
 *
 * ```js
 * height: {
 *   type: 'length', default: 900, min: 300, max: 3000,
 *   defaults: [
 *     { when: { type: 'wall' }, value: 720 },
 *     { when: { type: 'wardrobe' }, value: 2400 },
 *   ],
 * },
 * ```
 */
export type ConditionalDefault<T> = { readonly when: OptionWhen; readonly value: T };

/** What every value declares, in the part parameters' own words where they have them. */
type ParamCommon = Partial<Pick<ParamDefinition, 'label' | 'description' | 'group'>> & {
  /** The dialog tab the row sits on; rows without one sit above the tabs. */
  tab?: string;
  /** A line of small text under the row's control; `description` stays the tooltip. */
  hint?: string;
  /**
   * Notes, images and dividers about this value: the card beside the dialog
   * shows them in place of the feature's own `aside` while the value's row
   * has the focus or the pointer — a diagram of what the value measures.
   */
  aside?: readonly FeatureStaticItem[];
  visibleWhen?: VisibleWhen;
  /**
   * The value may be left out; without a default it then reaches the feature
   * as `undefined`. A boolean always has a value (`false` without a
   * default), so it changes nothing there; a select or a radio without a
   * default stays unset rather than taking its first option.
   */
  optional?: boolean;
};

export type NumberParamSpec = ParamCommon & Partial<Pick<ParamDefinition, 'min' | 'max' | 'step'>> & {
  type: 'number' | 'integer' | 'length' | 'angle';
  defaults?: readonly ConditionalDefault<number>[];
  /**
   * Left out, the dialog shows the row empty and asks for a value — unless
   * it is a `slider`: a track always shows a position, so it is then `min`.
   */
  default?: number;
  /**
   * How the row looks beside its input, which stays (a variable or an
   * expression still types in): a `slider` is a track from `min` to `max`,
   * both of which it needs; a `stepper` is − / + buttons, for a `number` or
   * an `integer` only. Left out, the plain input.
   */
  display?: 'slider' | 'stepper';
  /** A short unit shown at the end of the input, at most 8 characters: `'mm'`. */
  suffix?: string;
};

export type BooleanParamSpec = ParamCommon & {
  type: 'boolean';
  /** Left out, `false`: the toggle the dialog shows off. */
  default?: boolean;
  defaults?: readonly ConditionalDefault<boolean>[];
  /** A `checkbox` in place of the toggle. Left out, the toggle. */
  display?: 'checkbox';
};

/**
 * One choice of a select or a radio: the part parameters' `{ label, value }`,
 * and what the dialog may show with it. Only `value` reaches the feature.
 */
export type ChoiceOption = SelectOption & {
  /** A picture of the choice: an image file next to the module, as `icon` is. */
  image?: string;
  /** A line under the label. */
  description?: string;
  /** The heading the option is listed under. */
  group?: string;
  /** Further words a search finds the option by. */
  keywords?: readonly string[];
  /**
   * When the dialog offers the option: the grammar of a value's `visibleWhen`,
   * `{ otherValue: scalar | scalar[] }`, every clause holding — or a list of
   * such objects, any one of them holding. An option without one is always
   * offered. It narrows the dialog only: a call written by hand may pass any
   * declared option whatever the other values are, and the builder gets it. The default must be offered while every other value
   * is at its own default; left out, the default is the first option offered
   * there. It names typed-in values only.
   */
  when?: OptionWhen;
};

export type SelectParamSpec = ParamCommon & {
  type: 'select';
  options: readonly ChoiceOption[];
  /** How the options are laid out: a `list` of rows (the default) or a `grid` of images. */
  display?: 'list' | 'grid';
  /** How many columns a `grid` has, 2 to 6. */
  columns?: number;
  /** Whether the options can be searched by label, description and keywords. */
  search?: boolean;
} & (SingleSelect | MultiSelect);

/** A select that holds one of its options. */
type SingleSelect = {
  multiple?: false;
  /**
   * Left out, the first option's value — the one the dialog shows — unless
   * the value is `optional`: it then stays unset, and the dialog offers an
   * empty choice.
   */
  default?: string | number;
  defaults?: readonly ConditionalDefault<string | number>[];
};

/**
 * A select that holds several of its options: its value is a list of option
 * values, in the order the call wrote them, none twice. The list is always
 * there — empty when nothing is chosen, never `undefined` — so `optional`
 * changes nothing.
 */
type MultiSelect = {
  multiple: true;
  /** A list of option values within `min` and `max`. Left out, the empty list — which a `min` above 0 refuses, so that needs one. */
  default?: readonly (string | number)[];
  defaults?: readonly ConditionalDefault<readonly (string | number)[]>[];
  /** The fewest values the list may hold: a whole number, 0 or more. */
  min?: number;
  /** The most values the list may hold: a whole number, 1 or more, at most the number of options. */
  max?: number;
};

/** A select with `multiple: true`: the one typed-in value that is a list. */
export type MultiSelectParamSpec = SelectParamSpec & { multiple: true };

/** One of a few choices, all of them on show: a select's value, default rule and options. */
export type RadioParamSpec = ParamCommon & {
  type: 'radio';
  options: readonly ChoiceOption[];
  /** Left out, the first option's value, unless the value is `optional`: it then stays unset. */
  default?: string | number;
  defaults?: readonly ConditionalDefault<string | number>[];
  /**
   * How the options are laid out: a `list` of stacked radios (the default),
   * `inline` on one line, a row of `buttons`, or image `cards`.
   */
  display?: 'list' | 'inline' | 'buttons' | 'cards';
  /** How many columns `cards` have, 2 to 6. */
  columns?: number;
};

export type TextParamSpec = ParamCommon & {
  type: 'text';
  default?: string;
  defaults?: readonly ConditionalDefault<string>[];
  /** Several lines: Enter is a new line, Ctrl/Cmd+Enter applies. */
  multiline?: boolean;
  /** What the empty input shows. */
  placeholder?: string;
  /** The most characters the text may have, 1 or more. */
  maxLength?: number;
  /** A regular expression the whole text must match: `'[A-Z0-9-]*'`. */
  pattern?: string;
};

export type ScalarParamSpec = NumberParamSpec | BooleanParamSpec | SelectParamSpec | RadioParamSpec | TextParamSpec;

/** What a picker that may pick several things declares. */
type ListPicker = {
  /** The value is a list. */
  multiple?: boolean;
  /** The value is a list of at most this many (2 or more). */
  max?: number;
  /** The list's order matters, and the dialog lets it be changed. */
  ordered?: boolean;
};

export type SketchPickerSpec = ParamCommon & ListPicker & {
  picker: 'sketch';
  /** Left out, the value is the active sketch, as `extrude(25)` takes it. */
  implicitDefault?: boolean;
  /** Only sketches that hold geometry. */
  hasGeometry?: boolean;
  /** Helices and other wire sources too. */
  wire?: boolean;
};

export type FacePickerSpec = ParamCommon & ListPicker & {
  picker: 'face';
  /** Only faces of this surface; checked by the engine. */
  surface?: 'planar' | 'cylinder' | 'cone' | 'torus';
  /** Only faces of the model's own file (the default). */
  sameFile?: boolean;
};

export type EdgePickerSpec = ParamCommon & ListPicker & {
  picker: 'edge';
  /** Only edges of this curve; checked by the engine. */
  curve?: 'line' | 'circle' | 'arc';
  /** A picked face stands for all of its edges. */
  facesAsEdges?: boolean;
};

/**
 * An axis: a world axis, an `axis()` statement, a straight edge — or a
 * connector, standing for its Z axis through its origin. Every axis picker
 * takes all of them; the feature reads each the same way, with `axisOf()`.
 */
export type AxisPickerSpec = ParamCommon & { picker: 'axis' };

export type PlanePickerSpec = ParamCommon & { picker: 'plane' };

export type SolidPickerSpec = ParamCommon & ListPicker & { picker: 'solid' };

export type FeaturePickerSpec = ParamCommon & ListPicker & {
  picker: 'feature';
  /**
   * Only features of these types or ids. With them, the dialog also takes a
   * click on a face or an edge such a feature made (a hole's wall or rim)
   * as that feature — ahead of a face, anchor or edge kind beside it.
   */
  types?: readonly string[];
};

export type ConnectorPickerSpec = ParamCommon & ListPicker & { picker: 'connector' };

export type PointPickerSpec = ParamCommon & ListPicker & { picker: 'point' };

export type AnchorPickerSpec = ParamCommon & ListPicker & {
  picker: 'anchor';
  /** The anchors offered on a face or an edge; all of them when left out. */
  anchors?: readonly ('center' | 'start' | 'end' | 'offset')[];
};

/**
 * A value that takes more than one kind of pick, routed by what was
 * clicked: `{ picker: ['connector', 'point', 'anchor'], multiple: true }`
 * places a feature at connectors, points and anchors alike, and
 * `['solid', 'connector']` copies either. The kinds must take different
 * clicks — a face click can't be both a face and an anchor — so each pick
 * lands in exactly one of them. Each kind reads its own fields (`surface`
 * for a face, `anchors` for an anchor); a value whose kinds include an axis
 * or a plane picks one thing.
 */
export type UnionPickerSpec = ParamCommon & ListPicker & {
  picker: readonly PickerKind[];
  hasGeometry?: boolean;
  wire?: boolean;
  surface?: FacePickerSpec['surface'];
  sameFile?: boolean;
  curve?: EdgePickerSpec['curve'];
  facesAsEdges?: boolean;
  types?: readonly string[];
  anchors?: AnchorPickerSpec['anchors'];
};

export type PickerParamSpec =
  | SketchPickerSpec | FacePickerSpec | EdgePickerSpec | AxisPickerSpec | PlanePickerSpec
  | SolidPickerSpec | FeaturePickerSpec | ConnectorPickerSpec | PointPickerSpec | AnchorPickerSpec
  | UnionPickerSpec;

/** One value of a feature, as its dialog shows it: typed in (`type`) or picked (`picker`). */
export type ParamSpec = ScalarParamSpec | PickerParamSpec;

/**
 * A custom feature, described for the editor: the toolbar button, the
 * dialog's values, and the call the dialog writes. Passed to
 * `registerBuilder(build, { feature })`.
 *
 * ```js
 * registerBuilder(build, {
 *   feature: {
 *     class: Standoff, label: 'Standoff', group: 'create', kind: 'tool',
 *     operations: ['add', 'new'],
 *     params: {
 *       face: { picker: 'face', label: 'On face', surface: 'planar' },
 *       height: { type: 'length', default: 10, min: 0 },
 *     },
 *     call: ['face', { height: 'height' }],
 *   },
 * });
 * ```
 */
export type FeatureMeta = {
  /** The feature's class; its `static id` is the feature's id. */
  class: FeatureClass<any>;
  label: string;
  description?: string;
  /** An image next to the module, by relative path: `'./icons/standoff.svg'`. */
  icon?: string;
  group: FeatureGroup;
  kind: FeatureKind;
  /**
   * The operations the dialog offers, for a tool; left out, it offers none.
   * A statement with no operation chain applies the default: `add` when it
   * is offered, else the first listed — `['remove']` cuts without a chain.
   */
  operations?: readonly FeatureOperation[];
  /** The feature's values, in dialog order: exactly what its class is constructed from. */
  params: Record<string, ParamSpec>;
  /** How the builder's call lays the values out (see `CallShape`). */
  call: CallShape;
  /**
   * Whether and how the dialog draws a preview of the feature while its
   * values are typed — the feature chooses:
   * - `'toggle'` (`true`, or left out): a Preview toggle the user turns on,
   *   remembered per feature — for a feature whose build may be slow;
   * - `'always'`: no toggle, the preview drawn from the start — for a cheap
   *   build;
   * - `false`: no preview.
   * A tool can always preview; a modifier only when its class overrides
   * `ghost(ctx)`.
   */
  ghost?: boolean | FeatureGhostMode;
  /** Where the feature may be used; `['part']`, the only context so far, when left out. */
  contexts?: readonly FeatureContext[];
  /**
   * The dialog's rows, top to bottom (see {@link FeatureLayout}): every
   * value placed exactly once, and none carrying a `group` or `tab` of its
   * own. Left out, it is derived from the values' `group` and `tab`.
   */
  layout?: FeatureLayout;
  /** How wide the dialog opens; the default width when left out. */
  width?: FeatureDialogWidth;
  /** Notes, images and dividers shown beside the rows. */
  aside?: readonly FeatureStaticItem[];
};

/**
 * A feature's metadata once `registerBuilder` checked it: the id read from
 * the class, every default filled — a value's too, where it resolves to one
 * it doesn't declare (see {@link FeatureMetas.defaultOf}).
 */
export type ResolvedFeatureMeta = Readonly<Omit<FeatureMeta, 'operations' | 'ghost' | 'contexts' | 'layout'> & {
  id: string;
  operations: readonly FeatureOperation[];
  /** What a statement without an operation chain does (see `FeatureCall.defaultOperationOf`); null without operations. */
  defaultOperation: FeatureOperation | null;
  /** Whether the dialog draws a preview: the metadata allows one and the class has one to draw. */
  ghost: boolean;
  /** How the dialog draws it: behind the Preview toggle, or always (see {@link FeatureMeta.ghost}). */
  ghostMode: FeatureGhostMode;
  contexts: readonly FeatureContext[];
  /** The dialog's rows: the author's, or the one derived from the values' `group` and `tab` (see {@link FeatureLayouts.derive}). */
  layout: FeatureLayout;
}>;

/** A value's spec in a snapshot: as declared, its label and its resolved default filled in (see {@link FeatureMetas.defaultOf}). */
export type ParamSpecSnapshot = ParamSpec & { label: string };

/**
 * A feature's metadata as plain JSON — what the editor's catalog sends the
 * UI, which never runs feature code. The class is left out: it becomes its id.
 */
export type FeatureMetaSnapshot = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  group: FeatureGroup;
  kind: FeatureKind;
  operations: FeatureOperation[];
  /** The operation a statement without an operation chain applies — the dialog's preselected one; null without operations. */
  defaultOperation: FeatureOperation | null;
  params: Record<string, ParamSpecSnapshot>;
  call: CallShape;
  /** Whether the dialog draws a preview — the UI asks for none when false. */
  ghost: boolean;
  /**
   * `'always'` when the dialog draws it from the start with no toggle; left
   * out otherwise — behind the Preview toggle, as every snapshot an older
   * engine packed reads — so a feature that keeps the default packs to the
   * same bytes as before.
   */
  ghostMode?: 'always';
  contexts: FeatureContext[];
  /** The dialog's rows, always there: as the author wrote them, or derived from the values' `group` and `tab`. */
  layout: FeatureLayout;
  width?: FeatureDialogWidth;
  aside?: readonly FeatureStaticItem[];
};

/** A module export that is a feature's builder. */
export type FeatureExport = { exportName: string; meta: ResolvedFeatureMeta };

/**
 * Checks a feature's metadata and resolves it: every refusal names the
 * feature and the field, so a typo fails where the module is loaded rather
 * than in a dialog that cannot be built. The values (`params`) are checked
 * by the schema's own rules, which it extends ({@link SchemaValidator}).
 */
class FeatureMetaValidator extends SchemaValidator {

  private static readonly FIELDS = new Set([
    'class', 'label', 'description', 'icon', 'group', 'kind', 'operations',
    'params', 'call', 'ghost', 'contexts', 'layout', 'width', 'aside',
  ]);

  /** Fields refused by name rather than as unknown, each with why it is left out. */
  private static readonly LEFT_OUT: [string, string][] = [
    ['id', "the feature's id is its class's static id"],
    ['defaultOperation', "a feature adds by default when it offers 'add', else it applies the first of its 'operations'"],
    ['illustration', "illustrations aren't supported (custom controls are planned)"],
    ['onChange', "onChange hooks aren't supported (custom controls are planned)"],
    ['buckets', 'declare buckets on the class: Feature.with(params, { buckets }), or static buckets on a plain Feature subclass'],
    ['frames', 'declare frames on the class: Feature.with(params, { frames }), or static frames on a plain Feature subclass'],
  ];

  private static readonly ID_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

  constructor(
    private readonly meta: unknown,
    private readonly builtIn: boolean,
  ) {
    // Who the messages name: the feature once its id is known.
    super('feature metadata');
  }

  resolve(): ResolvedFeatureMeta {
    if (!FeatureCall.isPlainObject(this.meta)) {
      this.fail('the feature is described by an object: { class, label, group, kind, params, call, … }');
    }
    const meta = this.meta as Record<string, unknown>;
    this.leftOut(meta, FeatureMetaValidator.LEFT_OUT);
    for (const field of Object.keys(meta)) {
      if (!FeatureMetaValidator.FIELDS.has(field)) {
        this.fail(`unknown field '${field}' — the fields are ${[...FeatureMetaValidator.FIELDS].join(', ')}`);
      }
    }

    const featureClass = meta.class;
    const id = this.idOf(featureClass);
    this.where = `feature '${id}'`;

    const label = this.text(meta.label, "'label'");
    const description = meta.description === undefined ? undefined : this.text(meta.description, "'description'", true);
    const icon = meta.icon === undefined ? undefined : this.image(meta.icon, 'icon');
    const group = this.oneOf(meta.group, "'group'", ['create', 'modify']) as FeatureGroup;
    const kind = this.oneOf(meta.kind, "'kind'", ['tool', 'modifier']) as FeatureKind;
    this.checkKind(featureClass as typeof Feature, kind);
    const operations = this.operations(meta.operations, kind);
    const params = this.params(meta.params);
    const call = this.call(meta.call, operations, params, id);
    const ghost = this.ghost(meta.ghost, featureClass as typeof Feature);
    const ghostMode = FeatureMetas.ghostModeOf(meta.ghost);
    const contexts = this.contexts(meta.contexts);
    const checks = this.layoutChecks(params);
    const layout = meta.layout === undefined ? FeatureLayouts.derive(params) : FeatureLayouts.check(meta.layout, checks);
    const width = meta.width === undefined ? undefined : this.oneOf(meta.width, "'width'", FeatureLayouts.WIDTHS);
    const aside = meta.aside === undefined ? undefined : FeatureLayouts.checkAside(meta.aside, checks);
    for (const [name, spec] of Object.entries(params)) {
      if (spec.aside !== undefined) {
        FeatureLayouts.checkAside(spec.aside, checks, `param '${name}': 'aside'`, `param '${name}': aside: `);
      }
    }

    const resolved: Record<string, unknown> = {
      id, class: featureClass, label, description, icon, group, kind, operations,
      defaultOperation: FeatureCall.defaultOperationOf(operations), params, call, ghost, ghostMode, contexts,
      layout, width, aside,
    };
    return Object.freeze(FeatureMetaValidator.defined(resolved)) as ResolvedFeatureMeta;
  }

  /** The class's id, refusing anything but a `Feature` subclass with a well-formed one. */
  private idOf(featureClass: unknown): string {
    if (typeof featureClass !== 'function') {
      this.fail(`'class' must be the feature's class, got ${FeatureMetaValidator.describe(featureClass)}`);
    }
    if (featureClass === Feature || !(featureClass.prototype instanceof Feature)) {
      this.fail(`'class' must extend Feature from 'fluidcad/sdk'${featureClass === Feature ? ', not be Feature itself' : ''}`);
    }
    // Claimed while its module evaluates: a class an installed package
    // defines is keyed by the package. The engine's own never are.
    if (!this.builtIn) {
      FeatureNamespaces.claim(featureClass);
    }
    let id: string;
    try {
      id = Feature.plainIdOf(featureClass as typeof Feature);
    } catch (error) {
      this.fail((error as Error).message);
    }
    const segments = id.split('.');
    if (!segments.every(segment => FeatureMetaValidator.ID_SEGMENT.test(segment))) {
      this.fail(`the id '${id}' is not well formed — dot-separated names of letters, digits, '-' and '_', each starting with a letter, such as 'standoff'`);
    }
    if (!this.builtIn && SceneTypes.isEngineType(id)) {
      this.fail(`'${id}' is one of the engine's own types: give the feature another id`);
    }
    return Feature.idOf(featureClass as typeof Feature);
  }

  /** A tool leaves `build()` to the base and implements `buildTool()`; a modifier overrides `build()`. */
  private checkKind(featureClass: typeof Feature, kind: FeatureKind): void {
    const prototype = featureClass.prototype;
    const isTool = prototype.build === Feature.prototype.build;
    if (kind === 'tool' && !isTool) {
      this.fail("is declared kind 'tool' but its class overrides build() — a tool implements buildTool() and leaves build() to the base; a feature that overrides build() is kind 'modifier'");
    }
    if (kind === 'tool' && prototype.buildTool === Feature.prototype.buildTool) {
      this.fail("is declared kind 'tool' but its class implements no buildTool()");
    }
    if (kind === 'modifier' && isTool) {
      this.fail("is declared kind 'modifier' but its class leaves build() to the base — a modifier overrides build(ctx); a feature that implements buildTool() is kind 'tool'");
    }
  }

  /**
   * Whether the dialog draws a preview: unless the metadata turns it off,
   * whenever the class has one to draw — a tool always, a modifier when it
   * overrides `ghost(ctx)`. Asking for one a modifier can't draw is refused.
   * How it draws it (`'toggle'` or `'always'`) is {@link FeatureMetas.ghostModeOf}.
   */
  private ghost(value: unknown, featureClass: typeof Feature): boolean {
    if (value !== undefined && typeof value !== 'boolean' && !FeatureMetas.GHOST_MODES.includes(value as FeatureGhostMode)) {
      this.fail(`'ghost' must be true, false, 'toggle' or 'always', got ${FeatureMetaValidator.describe(value)}`);
    }
    const previews = Feature.previews(featureClass);
    if (value !== undefined && value !== false && !previews) {
      this.fail(`'ghost: ${typeof value === 'string' ? `"${value}"` : value}' needs a preview to draw — a modifier draws one only when its class overrides ghost(ctx); override it, or leave 'ghost' out`);
    }
    return value !== false && previews;
  }

  private operations(value: unknown, kind: FeatureKind): FeatureOperation[] {
    if (value === undefined) {
      return [];
    }
    if (kind === 'modifier') {
      this.fail("a modifier takes no 'operations' — its build() decides what it does to the solids");
    }
    const list = this.list(value, "'operations'");
    for (const operation of list) {
      this.oneOf(operation, "'operations'", ['add', 'new', 'remove']);
    }
    this.distinct(list, "'operations'");
    return Object.freeze([...list]) as FeatureOperation[];
  }

  private contexts(value: unknown): FeatureContext[] {
    if (value === undefined) {
      return Object.freeze(['part']) as FeatureContext[];
    }
    const list = this.list(value, "'contexts'");
    for (const context of list) {
      if (context === 'assembly') {
        this.fail("custom features run in parts only for now — 'contexts' takes 'part'");
      }
      this.oneOf(context, "'contexts'", ['part']);
    }
    this.distinct(list, "'contexts'");
    return Object.freeze([...list]) as FeatureContext[];
  }

  /** The call shape, checked against the values: each named exactly once, the rest one a list. */
  private call(value: unknown, operations: FeatureOperation[], params: Record<string, ParamSpec>, id: string): CallShape {
    let call: FeatureCall;
    try {
      call = new FeatureCall(value as CallShape, operations, FeatureMetas.calleeOf(id));
    } catch (error) {
      this.fail((error as Error).message);
    }
    const named = call.params();
    for (const name of named) {
      if (!FeatureMetaValidator.owns(params, name)) {
        this.fail(`the call shape names '${name}', which is not one of the feature's values`);
      }
    }
    for (const name of Object.keys(params)) {
      if (!named.includes(name)) {
        this.fail(`the value '${name}' has no place in the call shape`);
      }
    }
    if (call.rest !== null && !ValueSchema.isList(params[call.rest])) {
      this.fail(`the rest value '...${call.rest}' must be a list — a picker with 'multiple: true'`);
    }
    return FeatureMetaValidator.frozenCopy(value) as CallShape;
  }
}

/**
 * Feature metadata from the engine's side: checking it, attaching it to a
 * builder, finding the builders a module exports, reading a builder's
 * arguments by it, and the JSON snapshot the editor sends the UI. The
 * values themselves are checked and defaulted by the feature's schema
 * ({@link ValueSchema}), the one class a generated part's insert uses too.
 */
export class FeatureMetas {

  /**
   * The property a builder carries its metadata under. A registry symbol, so
   * a server that loads the kernel apart from the workspace's still finds it.
   */
  static readonly KEY: symbol = Symbol.for('fluidcad.feature-meta');

  /** Each checked metadata object, by what the author passed and by itself. */
  private static readonly resolvedByMeta = new WeakMap<object, ResolvedFeatureMeta>();

  private static readonly calls = new WeakMap<object, FeatureCall>();

  /**
   * Check `meta` and resolve it, refusing it with a message naming the
   * feature and the field. The resolved `id` is the class's catalog key
   * (`Feature.idOf`): its plain id, keyed by the package when an installed
   * package defines it. `builtIn` admits the engine's own types (`draft`)
   * and never keys them.
   */
  static resolve(meta: unknown, builtIn = false): ResolvedFeatureMeta {
    const known = meta !== null && typeof meta === 'object' ? FeatureMetas.resolvedByMeta.get(meta) : undefined;
    if (known) {
      return known;
    }
    const resolved = new FeatureMetaValidator(meta, builtIn).resolve();
    FeatureMetas.resolvedByMeta.set(meta as object, resolved);
    FeatureMetas.resolvedByMeta.set(resolved, resolved);
    return resolved;
  }

  /**
   * The metadata `registerBuilder` was handed, resolved: a feature runs
   * where its `contexts` say, so it takes no `allowAssemblyTopLevel`.
   */
  static forBuilder(options: { feature?: unknown; builtIn?: boolean; allowAssemblyTopLevel?: boolean }): ResolvedFeatureMeta {
    const meta = FeatureMetas.resolve(options.feature, options.builtIn === true);
    if (options.allowAssemblyTopLevel) {
      throw new Error(`feature '${meta.id}': a feature runs where its 'contexts' say — leave allowAssemblyTopLevel out`);
    }
    return meta;
  }

  /**
   * Mark `builder` as the builder of the feature `meta` describes, and tell
   * the feature's class what its metadata says of it: the label its
   * timeline rows read, the operations its statements may choose, with
   * the default one a statement without a chain applies, and its dialog's
   * rows, which a generated part of the class borrows (`definePart`).
   */
  static attach(builder: Function, meta: ResolvedFeatureMeta): void {
    Object.defineProperty(builder, FeatureMetas.KEY, { value: meta });
    Feature.register(meta.class, {
      label: meta.label,
      operations: meta.operations,
      defaultOperation: meta.defaultOperation,
      dialog: { layout: meta.layout, width: meta.width, aside: meta.aside },
    });
  }

  /** What `defineFeature()` takes from the class rather than its metadata, and why. */
  private static readonly FROM_THE_CLASS: [string, string][] = [
    ['class', "the class is defineFeature()'s first argument"],
    ['params', 'the values are the class\'s own, declared with Feature.with({ … })'],
    ['kind', 'it is read from the class: one that implements buildTool() is a tool, one that overrides build() a modifier'],
    ['buckets', 'declare buckets on the class: Feature.with(params, { buckets })'],
    ['frames', 'declare frames on the class: Feature.with(params, { frames })'],
  ];

  /**
   * The metadata `defineFeature(featureClass, meta)` registers: `meta`, plus
   * the class, the values it declares (its `static params`, which
   * `Feature.with()` gives it) and its kind, read from what it implements.
   * Everything else is checked as `registerBuilder` checks any metadata.
   */
  static define(featureClass: unknown, meta: unknown): FeatureMeta {
    if (typeof featureClass !== 'function' || !(featureClass.prototype instanceof Feature)) {
      throw new Error(`defineFeature(): the first argument is the feature's class, one that extends Feature.with({ … }), got ${FeatureMetaValidator.describe(featureClass)}`);
    }
    const name = featureClass.name || 'the class';
    const where = featureClass.name ? `defineFeature(${featureClass.name})` : 'defineFeature()';
    const params = (featureClass as { params?: unknown }).params;
    if (params === undefined) {
      throw new Error(`${where}: ${name} declares no values — declare them with Feature.with({ … }): class ${name} extends Feature.with({ height: { type: 'length' } })`);
    }
    if (!FeatureCall.isPlainObject(meta)) {
      throw new Error(`${where}: the second argument describes the feature, such as { label: 'Standoff', group: 'create', call: […] } — got ${FeatureMetaValidator.describe(meta)}`);
    }
    for (const [field, why] of FeatureMetas.FROM_THE_CLASS) {
      if (field in meta) {
        throw new Error(`${where}: leave '${field}' out — ${why}`);
      }
    }
    return { ...meta, class: featureClass, params, kind: FeatureMetas.kindOf(featureClass as typeof Feature, where) } as FeatureMeta;
  }

  /** A class's kind: a modifier overrides `build()`, a tool leaves it to the base and implements `buildTool()`. */
  private static kindOf(featureClass: typeof Feature, where: string): FeatureKind {
    const prototype = featureClass.prototype;
    if (prototype.build !== Feature.prototype.build) {
      return 'modifier';
    }
    if (prototype.buildTool === Feature.prototype.buildTool) {
      throw new Error(`${where}: ${featureClass.name || 'the class'} implements neither buildTool() nor build() — a tool returns its solids from buildTool(ctx), a modifier overrides build(ctx)`);
    }
    return 'tool';
  }

  /** The metadata a builder carries, or null for a builder of no feature (or not a builder at all). */
  static of(builder: unknown): ResolvedFeatureMeta | null {
    if (typeof builder !== 'function') {
      return null;
    }
    return (builder as unknown as Record<symbol, ResolvedFeatureMeta | undefined>)[FeatureMetas.KEY] ?? null;
  }

  /**
   * The feature builders a module exports, by export name. A builder
   * exported under two names is listed once, under the first; a default
   * export is left out — the editor imports features by name.
   */
  static list(namespace: object): FeatureExport[] {
    const found: FeatureExport[] = [];
    const seen = new Set<unknown>();
    for (const exportName of Object.keys(namespace)) {
      if (exportName === 'default') {
        continue;
      }
      let value: unknown;
      try {
        value = (namespace as Record<string, unknown>)[exportName];
      } catch {
        // An export still in its temporal dead zone (a module mid-cycle) is no builder yet.
        continue;
      }
      const meta = FeatureMetas.of(value);
      if (meta && !seen.has(value)) {
        seen.add(value);
        found.push({ exportName, meta });
      }
    }
    return found;
  }

  /**
   * The metadata as plain JSON: the class left out (it becomes its id),
   * every default filled, each value's label filled from its name when it
   * declares none, the layout always there — the declared one as written,
   * else the derived one. Reads any metadata object, checked or not, and
   * whichever kernel checked it. A class's declared buckets stay on the
   * class: the editor reads them off the built feature.
   */
  static snapshot(meta: FeatureMeta | ResolvedFeatureMeta): FeatureMetaSnapshot {
    const resolved = meta as Partial<ResolvedFeatureMeta>;
    const params: Record<string, ParamSpecSnapshot> = {};
    for (const [name, spec] of Object.entries(meta.params ?? {})) {
      params[name] = ValueSchema.specSnapshot(name, spec);
    }
    return FeatureMetaValidator.defined({
      id: typeof resolved.id === 'string' ? resolved.id : Feature.idOf(meta.class),
      label: meta.label,
      description: meta.description,
      icon: meta.icon,
      group: meta.group,
      kind: meta.kind,
      operations: [...(meta.operations ?? [])],
      defaultOperation: FeatureCall.defaultOperationOf(meta.operations ?? []),
      params,
      call: FeatureMetas.json(meta.call ?? []),
      ghost: FeatureMetas.ghostOf(meta),
      ghostMode: FeatureMetas.ghostModeOf((meta as Partial<ResolvedFeatureMeta>).ghostMode ?? meta.ghost) === 'always' ? 'always' : undefined,
      contexts: [...(meta.contexts ?? ['part'])],
      layout: FeatureMetas.json(meta.layout ?? FeatureLayouts.derive(meta.params ?? {})),
      width: meta.width,
      aside: meta.aside === undefined ? undefined : FeatureMetas.json(meta.aside),
    }) as FeatureMetaSnapshot;
  }

  /**
   * Every file the metadata declares, each once, in order: the icon, the
   * options' images in declaration order, then the images of the layout,
   * of the aside and of the values' asides. Reads the metadata or its
   * snapshot; it is the whole list of what may be served for the feature.
   */
  static assetsOf(meta: FeatureMeta | ResolvedFeatureMeta | FeatureMetaSnapshot): string[] {
    const paths: unknown[] = [meta.icon];
    for (const spec of Object.values(meta.params ?? {})) {
      const options = 'options' in spec && Array.isArray(spec.options) ? spec.options as readonly ChoiceOption[] : [];
      paths.push(...options.map(option => option.image));
    }
    paths.push(...FeatureLayouts.images(meta.layout), ...FeatureLayouts.images(meta.aside));
    for (const spec of Object.values(meta.params ?? {})) {
      paths.push(...FeatureLayouts.images(spec.aside));
    }
    return [...new Set(paths.filter((path): path is string => typeof path === 'string'))];
  }

  /** The ways a dialog draws a preview: behind the Preview toggle, or always. */
  static readonly GHOST_MODES: readonly FeatureGhostMode[] = ['toggle', 'always'];

  /**
   * How the dialog draws a feature's preview, from its `ghost` (or a
   * resolved `ghostMode`): `'always'` only when asked for, else `'toggle'` —
   * also for `true`, `false` (which draws none) and a snapshot an older
   * engine packed without one.
   */
  static ghostModeOf(value: unknown): FeatureGhostMode {
    return value === 'always' ? 'always' : 'toggle';
  }

  /**
   * Whether the dialog draws a preview: what the checking kernel resolved,
   * or — for metadata nobody checked yet — the same rule read off the class.
   */
  private static ghostOf(meta: FeatureMeta | ResolvedFeatureMeta): boolean {
    const resolved = meta as Partial<ResolvedFeatureMeta>;
    if (typeof resolved.id === 'string' && typeof resolved.ghost === 'boolean') {
      return resolved.ghost;
    }
    return meta.ghost !== false && typeof meta.class === 'function' && Feature.previews(meta.class);
  }

  /**
   * A builder's arguments read by the feature's call shape into its values:
   * every declared value present (`undefined` for one left out), defaults
   * filled for values left out or `null`, each checked against its
   * declaration. A picked list is always a
   * list — one scene object passed for it becomes a list of one.
   */
  static values(meta: ResolvedFeatureMeta, args: ArrayLike<unknown>): FeatureValues {
    const call = FeatureMetas.callOf(meta);
    const read = call.parse(args);
    // A call that went straight to its options left the positionals before
    // them out: one that must be given says where it goes.
    for (const name of call.skipped(args, FeatureCall.VALUES)) {
      const spec = meta.params[name];
      if (spec && ValueSchema.requires(spec)) {
        throw new Error(`${FeatureMetas.calleeOf(meta.id)}(): '${name}' is required — it comes before the options`);
      }
    }
    return FeatureMetas.complete(meta, read);
  }

  /** Whether a value left out of a call fails it: nothing fills it — no default, not optional (see {@link ValueSchema.requires}). */
  static requires(spec: ParamSpec): boolean {
    return ValueSchema.requires(spec);
  }

  /**
   * Values by name — however they were gathered: read off a call, or put
   * together by the editor's preview — completed and checked as
   * {@link values} does, by the feature's schema ({@link ValueSchema.complete}):
   * every declared value present, defaults filled, each value checked
   * against its declaration, a refusal naming the feature's call.
   */
  static complete(meta: ResolvedFeatureMeta, read: Readonly<Record<string, unknown>>): FeatureValues {
    return FeatureMetas.schemaOf(meta).complete(`${FeatureMetas.calleeOf(meta.id)}()`, read);
  }

  /** The schema of a feature's values: its resolved `params`, checked and defaulted by {@link ValueSchema}. */
  static schemaOf(meta: ResolvedFeatureMeta): ValueSchema {
    return ValueSchema.of(meta.params);
  }

  /** The feature's call shape, ready to read and lay out calls. */
  static callOf(meta: ResolvedFeatureMeta): FeatureCall {
    let call = FeatureMetas.calls.get(meta);
    if (!call) {
      call = new FeatureCall(meta.call, meta.operations, FeatureMetas.calleeOf(meta.id));
      FeatureMetas.calls.set(meta, call);
    }
    return call;
  }

  /** A shape's call, ready to read and lay out calls. */
  static callOfShape(shape: CallShape): FeatureCall {
    let call = FeatureMetas.calls.get(shape);
    if (!call) {
      call = new FeatureCall(shape);
      FeatureMetas.calls.set(shape, call);
    }
    return call;
  }

  /** The value a call that leaves `spec`'s value out gives the feature (see {@link ValueSchema.defaultOf}). */
  static defaultOf(spec: ParamSpec): FeatureScalar | readonly (string | number)[] | undefined {
    return ValueSchema.defaultOf(spec);
  }

  /** The value a call that leaves `spec`'s value out gives the feature when its other values are `values` — its conditional defaults read (see {@link ValueSchema.defaultIn}). */
  static defaultIn(spec: ParamSpec, values: Readonly<Record<string, unknown>>): FeatureScalar | readonly (string | number)[] | undefined {
    return ValueSchema.defaultIn(spec, values);
  }

  /** Whether an option's `when` holds for `values` by name (see {@link ValueSchema.holds}). */
  static holds(when: OptionWhen | undefined, values: Readonly<Record<string, unknown>>): boolean {
    return ValueSchema.holds(when, values);
  }

  /** Whether a picked value meets its condition (see {@link ValueSchema.pickHolds}). */
  static pickHolds(condition: PickCondition, picks: readonly (PickedSurface | null)[]): boolean {
    return ValueSchema.pickHolds(condition, picks);
  }

  /** The kinds a picked value takes (see {@link ValueSchema.kindsOf}). */
  static kindsOf(spec: PickerParamSpec): PickerKind[] {
    return ValueSchema.kindsOf(spec);
  }

  /**
   * The scene objects a call hands over, lists and the object of options
   * opened — what a feature builder's call claims as its operands.
   */
  static operands(args: ArrayLike<unknown>): unknown[] {
    return Array.from(args).flatMap(arg => {
      if (Array.isArray(arg)) {
        return arg;
      }
      if (FeatureCall.isPlainObject(arg)) {
        return Object.values(arg).flatMap(value => Array.isArray(value) ? value : [value]);
      }
      return [arg];
    });
  }

  /** What messages call a feature's builder: its plain id's last segment (`@acme/kit:standoff` → `standoff`, see `FeatureKey.calleeOf`). */
  static calleeOf(id: string): string {
    return FeatureKey.calleeOf(id);
  }

  /** @internal One typed-in value checked against its declaration, as {@link complete} checks a call's; a picker declaration is refused. */
  static checkScalar(callee: string, name: string, spec: ParamSpec, value: unknown): FeatureValues[string] {
    return ValueSchema.checkScalar(`${callee}()`, name, spec, value);
  }

  private static json(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
}

/**
 * Read a builder's arguments into the feature's values. Given the feature's
 * metadata, each value is checked against its declaration and its default
 * filled; given only a call shape, the arguments are read as they are.
 *
 * ```js
 * export const standoff = registerBuilder(
 *   context => (...args) => new Standoff(parseCall(meta, args)).addTo(context),
 *   { feature: meta },
 * );
 * ```
 */
export function parseCall<V extends FeatureValues = FeatureValues>(meta: FeatureMeta | CallShape, args: ArrayLike<unknown>): V {
  if (Array.isArray(meta)) {
    return FeatureMetas.callOfShape(meta as CallShape).parse(args) as V;
  }
  return FeatureMetas.values(FeatureMetas.resolve(meta), args) as V;
}

/** The metadata a feature builder carries, or null for any other function. */
export function getFeatureMeta(builder: unknown): ResolvedFeatureMeta | null {
  return FeatureMetas.of(builder);
}

/** The feature builders a module namespace exports (see {@link FeatureMetas.list}). */
export function listFeatureExports(namespace: object): FeatureExport[] {
  return FeatureMetas.list(namespace);
}

/** A feature's metadata as plain JSON, functions left out (see {@link FeatureMetas.snapshot}). */
export function snapshotFeatureMeta(meta: FeatureMeta | ResolvedFeatureMeta): FeatureMetaSnapshot {
  return FeatureMetas.snapshot(meta);
}

/** Every file a feature's metadata declares — its icon, its options' images, its layout's and aside's (see {@link FeatureMetas.assetsOf}). */
export function listFeatureAssets(meta: FeatureMeta | ResolvedFeatureMeta | FeatureMetaSnapshot): string[] {
  return FeatureMetas.assetsOf(meta);
}

// A value `derive()` fixes is checked as a call's is (see Feature.scalarCheck).
Feature.scalarCheck = (callee, name, spec, value) => FeatureMetas.checkScalar(callee, name, spec, value);
