import { SceneObject } from "../common/scene-object.js";
import type { ParamDefinition, SelectOption } from "../param-registry.js";
import { Feature, type FeatureClass } from "./feature.js";
import type { FeatureScalar, FeatureValues } from "./feature-inputs.js";
import { FeatureCall, type CallShape, type FeatureOperation } from "./call-shape.js";
import { FeatureKey } from "./feature-key.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import { SceneTypes } from "../common/scene-types.js";
import { Axis, isStandardAxis } from "../math/axis.js";
import { Plane, isPlaneLike } from "../math/plane.js";
import { AxisObject } from "../features/axis.js";
import { AxisFromConnector } from "../features/axis-from-connector.js";
import { ConnectorAxis } from "../features/connector-axis.js";
import { PlaneObject } from "../features/plane.js";
import { normalizeAxis, normalizePlane } from "../helpers/normalize.js";
import { Locations, type LocationKind } from "../features/locations.js";
import { AnchoredLazyVertex } from "../features/anchored-vertex.js";
import { FeatureLayouts, type FeatureDialogWidth, type FeatureLayout, type FeatureLayoutChecks, type FeatureStaticItem } from "./layout.js";

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
export const PICKED_SURFACES: readonly PickedSurface[] = ['planar', 'cylinder', 'cone', 'sphere', 'torus', 'other'];

/**
 * A condition on a picked value, for a `visibleWhen` that names it — every
 * field given must hold:
 * - `picked`: whether the value holds anything;
 * - `surface`: the value holds picks, and each is a face of this surface (or
 *   of one of these);
 * - `not`: the condition given does not hold.
 *
 * `{ at: { not: { surface: 'cylinder' } } }` shows a row until a cylindrical
 * face is picked for `at`; `{ at: { picked: false } }` while nothing is.
 */
export type PickCondition = {
  readonly picked?: boolean;
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
  /** Only features of these types or ids. */
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
 * than in a dialog that cannot be built.
 */
class FeatureMetaValidator {

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
  ];

  /**
   * A picker kind's fields refused by name rather than as unknown, each with
   * why it is left out — on that kind and on every union that takes it.
   */
  private static readonly PICKER_LEFT_OUT: Partial<Record<PickerKind, [string, string][]>> = {
    edge: [['tangents', 'tangent chains are for fillet and chamfer only']],
    axis: [['connector', 'an axis picker always takes connectors']],
  };

  private static readonly ID_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

  private static readonly NAME = /^[A-Za-z_$][\w$]*$/;

  private static readonly COMMON_FIELDS = ['label', 'description', 'group', 'tab', 'hint', 'aside', 'visibleWhen', 'optional'];

  private static readonly NUMBER_FIELDS = ['default', 'min', 'max', 'step'];

  /** What a number type may declare: its numbers, and how its row looks. */
  private static readonly NUMBER_SPEC_FIELDS = [...FeatureMetaValidator.NUMBER_FIELDS, 'display', 'suffix'];

  private static readonly SCALAR_FIELDS: Record<ScalarParamType, string[]> = {
    number: FeatureMetaValidator.NUMBER_SPEC_FIELDS,
    integer: FeatureMetaValidator.NUMBER_SPEC_FIELDS,
    length: FeatureMetaValidator.NUMBER_SPEC_FIELDS,
    angle: FeatureMetaValidator.NUMBER_SPEC_FIELDS,
    boolean: ['default', 'display'],
    select: ['default', 'options', 'display', 'columns', 'search', 'multiple', 'min', 'max'],
    radio: ['default', 'options', 'display', 'columns'],
    text: ['default', 'multiline', 'placeholder', 'maxLength', 'pattern'],
  };

  /** Each number type's displays; leaving `display` out is the plain input. */
  private static readonly NUMBER_DISPLAYS: Record<NumberParamSpec['type'], readonly string[]> = {
    number: ['slider', 'stepper'],
    integer: ['slider', 'stepper'],
    length: ['slider'],
    angle: ['slider'],
  };

  /** The most characters a `suffix` may have. */
  private static readonly SUFFIX_LENGTH = 8;

  /** What one option of a select or a radio may carry. */
  private static readonly OPTION_FIELDS = ['label', 'value', 'image', 'description', 'group', 'keywords', 'when'];

  /** Each choice type's displays, the default first, and the one of them that has columns. */
  private static readonly CHOICES: Record<'select' | 'radio', { displays: readonly string[]; columned: string }> = {
    select: { displays: ['list', 'grid'], columned: 'grid' },
    radio: { displays: ['list', 'inline', 'buttons', 'cards'], columned: 'cards' },
  };

  private static readonly LIST_FIELDS = ['multiple', 'max', 'ordered'];

  /** Each picker kind: whether it may pick a list, and its own fields. */
  private static readonly PICKERS: Record<PickerKind, { list: boolean; fields: string[] }> = {
    sketch: { list: true, fields: ['implicitDefault', 'hasGeometry', 'wire'] },
    face: { list: true, fields: ['surface', 'sameFile'] },
    edge: { list: true, fields: ['curve', 'facesAsEdges'] },
    axis: { list: false, fields: [] },
    plane: { list: false, fields: [] },
    solid: { list: true, fields: [] },
    feature: { list: true, fields: ['types'] },
    connector: { list: true, fields: [] },
    point: { list: true, fields: [] },
    anchor: { list: true, fields: ['anchors'] },
  };

  private static readonly ENUMS: Record<string, readonly string[]> = {
    surface: ['planar', 'cylinder', 'cone', 'torus'],
    curve: ['line', 'circle', 'arc'],
  };

  private static readonly BOOLEAN_FIELDS = new Set([
    'optional', 'multiple', 'ordered', 'implicitDefault', 'hasGeometry', 'wire', 'sameFile', 'facesAsEdges', 'search', 'multiline',
  ]);

  private static readonly ANCHORS = ['center', 'start', 'end', 'offset'];

  /**
   * The clicks each picker kind takes — in the viewport, or a timeline row.
   * The kinds of a union must take different ones, so every pick lands in
   * exactly one of them.
   */
  private static readonly CLICKS: Record<PickerKind, string[]> = {
    sketch: ['a sketch wire', 'a sketch row'],
    face: ['a face'],
    edge: ['an edge'],
    axis: ['an edge', 'an axis line', 'a world axis', 'an axis row', 'a connector', 'a connector row'],
    plane: ['a face', 'a plane quad', 'an origin plane', 'a plane row'],
    solid: ['a face', 'an edge', 'a feature row'],
    feature: ['a feature row'],
    connector: ['a connector', 'a connector row'],
    point: ['a vertex'],
    anchor: ['a face', 'an edge'],
  };

  private static readonly IMAGE = /\.(svg|png|jpe?g|webp)$/i;

  /** Who the messages name: the feature once its id is known. */
  private where = 'feature metadata';

  constructor(
    private readonly meta: unknown,
    private readonly builtIn: boolean,
  ) {}

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

  /** What the layout's checks borrow: the values, this validator's refusals, its clause check and its image check. */
  private layoutChecks(params: Record<string, ParamSpec>): FeatureLayoutChecks {
    return {
      params,
      fail: message => this.fail(message),
      clauses: (where, value) => this.clauses(where, '', value, params, true),
      image: (value, where) => this.image(value, 'image', where),
      describe: value => FeatureMetaValidator.describe(value),
    };
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

  private params(value: unknown): Record<string, ParamSpec> {
    if (!FeatureCall.isPlainObject(value)) {
      this.fail(`'params' must be an object of the feature's values by name, got ${FeatureMetaValidator.describe(value)}`);
    }
    const params = value as Record<string, unknown>;
    const out: Record<string, ParamSpec> = {};
    for (const [name, spec] of Object.entries(params)) {
      if (!FeatureMetaValidator.NAME.test(name)) {
        this.fail(`the value name '${name}' is not an identifier`);
      }
      out[name] = this.param(name, spec);
    }
    for (const [name, spec] of Object.entries(out)) {
      if (spec.visibleWhen !== undefined) {
        this.clauses(`param '${name}': 'visibleWhen'`, name, spec.visibleWhen, out, true);
      }
      for (const option of FeatureMetaValidator.optionsOf(spec)) {
        if (option.when !== undefined) {
          this.optionWhen(`param '${name}': option ${JSON.stringify(option.value)}: 'when'`, name, option.when, out);
        }
      }
    }
    return Object.freeze(this.atRest(out, params));
  }

  private param(name: string, value: unknown): ParamSpec {
    const where = `param '${name}'`;
    if (!FeatureCall.isPlainObject(value)) {
      this.fail(`${where} must be an object such as { type: 'length' } or { picker: 'face' }, got ${FeatureMetaValidator.describe(value)}`);
    }
    const spec = value as Record<string, unknown>;
    if (('type' in spec) === ('picker' in spec)) {
      this.fail(`${where} declares ${'type' in spec ? "both a 'type' and a 'picker'" : "neither a 'type' nor a 'picker'"}`);
    }
    const fields = 'type' in spec ? this.scalarFields(where, spec) : this.pickerFields(where, spec);
    for (const field of Object.keys(spec)) {
      if (field !== 'type' && field !== 'picker' && !fields.includes(field)) {
        this.fail(`${where}: unknown field '${field}' for ${FeatureMetaValidator.kindName(spec)} — its fields are ${fields.join(', ')}`);
      }
    }

    for (const field of ['label', 'description', 'group', 'tab', 'hint']) {
      if (spec[field] !== undefined) {
        this.text(spec[field], `${where}: '${field}'`, field === 'description');
      }
    }
    for (const field of FeatureMetaValidator.BOOLEAN_FIELDS) {
      if (spec[field] !== undefined && typeof spec[field] !== 'boolean') {
        this.fail(`${where}: '${field}' must be true or false, got ${FeatureMetaValidator.describe(spec[field])}`);
      }
    }
    if ('type' in spec) {
      this.checkScalar(where, spec);
    } else {
      this.checkPicker(where, spec);
    }
    return FeatureMetaValidator.frozenCopy(FeatureMetas.withDefault(spec as ParamSpec)) as ParamSpec;
  }

  private scalarFields(where: string, spec: Record<string, unknown>): string[] {
    if (spec.type === 'radio' && spec.multiple !== undefined) {
      this.fail(`${where}: 'multiple' is for a select — a radio holds one value`);
    }
    if (typeof spec.type !== 'string' || !FeatureMetaValidator.owns(FeatureMetaValidator.SCALAR_FIELDS, spec.type)) {
      this.fail(`${where}: unknown type ${FeatureMetaValidator.describe(spec.type)} — the types are ${Object.keys(FeatureMetaValidator.SCALAR_FIELDS).join(', ')}`);
    }
    return [...FeatureMetaValidator.COMMON_FIELDS, ...FeatureMetaValidator.SCALAR_FIELDS[spec.type as ScalarParamType]];
  }

  private pickerFields(where: string, spec: Record<string, unknown>): string[] {
    const kinds = this.pickerKinds(where, spec);
    for (const kind of kinds) {
      this.leftOut(spec, FeatureMetaValidator.PICKER_LEFT_OUT[kind] ?? [], `${where}: `);
    }
    if ('default' in spec) {
      this.fail(`${where}: a picker takes no default — its value is what the user picks`);
    }
    const single = kinds.find(kind => !FeatureMetaValidator.PICKERS[kind].list);
    if (single) {
      const listField = FeatureMetaValidator.LIST_FIELDS.find(field => field in spec);
      if (listField) {
        this.fail(kinds.length === 1
          ? `${where}: ${FeatureMetaValidator.article(single)} ${single} picker picks one ${single}, so it takes no '${listField}'`
          : `${where}: a picker that takes ${FeatureMetaValidator.article(single)} ${single} picks one thing, so it takes no '${listField}'`);
      }
    }
    const fields = kinds.flatMap(kind => FeatureMetaValidator.PICKERS[kind].fields);
    return [...new Set([...FeatureMetaValidator.COMMON_FIELDS, ...(single ? [] : FeatureMetaValidator.LIST_FIELDS), ...fields])];
  }

  /**
   * The kinds a picker takes: one, or a union of several (`['connector',
   * 'point', 'anchor']`) whose kinds take different clicks — each pick is
   * routed to the one kind that takes it.
   */
  private pickerKinds(where: string, spec: Record<string, unknown>): PickerKind[] {
    const known = Object.keys(FeatureMetaValidator.PICKERS);
    const listed = Array.isArray(spec.picker) ? spec.picker as unknown[] : [spec.picker];
    if (Array.isArray(spec.picker) && listed.length < 2) {
      this.fail(`${where}: a picker that takes several kinds lists at least two, such as ['connector', 'point', 'anchor']${listed.length === 1 ? ` — for one, write picker: ${FeatureMetaValidator.describe(listed[0])}` : ''}`);
    }
    for (const kind of listed) {
      if (typeof kind !== 'string' || !FeatureMetaValidator.owns(FeatureMetaValidator.PICKERS, kind)) {
        this.fail(`${where}: unknown picker ${FeatureMetaValidator.describe(kind)} — the pickers are ${known.join(', ')}`);
      }
    }
    const kinds = listed as PickerKind[];
    this.distinct(kinds, `${where}: 'picker'`);
    if (kinds.includes('axis') && kinds.includes('connector')) {
      this.fail(`${where}: an axis picker already takes connectors (a connector's Z axis) — leave 'connector' out of the list`);
    }
    if (kinds.length > 1) {
      if (spec.implicitDefault !== undefined) {
        this.fail(`${where}: only a picker that takes sketches alone can default to the active sketch — leave 'implicitDefault' out`);
      }
      const taken = new Map<string, PickerKind>();
      for (const kind of kinds) {
        const clicks = [...FeatureMetaValidator.CLICKS[kind], ...(kind === 'edge' && spec.facesAsEdges === true ? ['a face'] : [])];
        for (const click of clicks) {
          const other = taken.get(click);
          if (other && other !== kind) {
            this.fail(`${where}: both '${other}' and '${kind}' take ${click} click — a picker of several kinds routes each click to the one kind that takes it; leave one out, or declare two values`);
          }
          taken.set(click, kind);
        }
      }
    }
    return kinds;
  }

  private checkScalar(where: string, spec: Record<string, unknown>): void {
    const type = spec.type as ScalarParamType;
    const value = spec.default;
    if (type === 'boolean' || type === 'text') {
      const expected = type === 'boolean' ? 'boolean' : 'string';
      if (value !== undefined && typeof value !== expected) {
        this.fail(`${where}: the default must be ${type === 'boolean' ? 'true or false' : 'a string'}, got ${FeatureMetaValidator.describe(value)}`);
      }
      if (type === 'boolean') {
        if (spec.display !== undefined && spec.display !== 'checkbox') {
          this.fail(`${where}: 'display' must be 'checkbox' — leave it out for the toggle — got ${FeatureMetaValidator.describe(spec.display)}`);
        }
      } else {
        this.checkText(where, spec);
      }
      return;
    }
    if (type === 'select' || type === 'radio') {
      this.checkChoice(where, type, spec);
      return;
    }

    for (const field of FeatureMetaValidator.NUMBER_FIELDS) {
      if (spec[field] !== undefined && !(typeof spec[field] === 'number' && Number.isFinite(spec[field]))) {
        this.fail(`${where}: '${field}' must be a finite number, got ${FeatureMetaValidator.describe(spec[field])}`);
      }
    }
    const { min, max, step } = spec as { min?: number; max?: number; step?: number };
    if (min !== undefined && max !== undefined && min > max) {
      this.fail(`${where}: min (${min}) is above max (${max})`);
    }
    if (step !== undefined && step <= 0) {
      this.fail(`${where}: step must be above 0, got ${step}`);
    }
    if (typeof value === 'number') {
      if (type === 'integer' && !Number.isInteger(value)) {
        this.fail(`${where}: the default of an integer must be a whole number, got ${value}`);
      }
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        this.fail(`${where}: the default (${value}) is outside ${FeatureMetaValidator.range(min, max)}`);
      }
    }
    this.checkNumberLook(where, type, spec);
  }

  /** How a number's row looks: its `display`, which its type must have, and its `suffix`. */
  private checkNumberLook(where: string, type: NumberParamSpec['type'], spec: Record<string, unknown>): void {
    if (spec.display !== undefined) {
      const displays = FeatureMetaValidator.NUMBER_DISPLAYS[type];
      if (spec.display === 'stepper' && !displays.includes('stepper')) {
        this.fail(`${where}: display: 'stepper' is for a number or an integer — ${type === 'angle' ? 'an angle' : 'a length'} takes 'slider', or leave it out`);
      }
      if (typeof spec.display !== 'string' || !displays.includes(spec.display)) {
        this.fail(`${where}: 'display' must be one of ${displays.join(', ')} — leave it out for the plain input — got ${FeatureMetaValidator.describe(spec.display)}`);
      }
    }
    if (spec.display === 'slider') {
      if (spec.min === undefined || spec.max === undefined) {
        this.fail(`${where}: display: 'slider' needs both 'min' and 'max' — the track runs from one to the other`);
      }
      if (type === 'integer' && !Number.isInteger(spec.min)) {
        this.fail(`${where}: the min of an integer slider must be a whole number, got ${spec.min} — without a default the slider starts there`);
      }
    }
    if (spec.suffix !== undefined) {
      const suffix = spec.suffix;
      if (typeof suffix !== 'string' || suffix.trim() === '' || suffix.length > FeatureMetaValidator.SUFFIX_LENGTH) {
        this.fail(`${where}: 'suffix' must be a non-empty string of at most ${FeatureMetaValidator.SUFFIX_LENGTH} characters, got ${FeatureMetaValidator.describe(suffix)}`);
      }
    }
  }

  /** A text's own fields: its placeholder, its limits, and a default that keeps to them. */
  private checkText(where: string, spec: Record<string, unknown>): void {
    if (spec.placeholder !== undefined) {
      this.text(spec.placeholder, `${where}: 'placeholder'`);
    }
    const { maxLength, pattern } = spec;
    if (maxLength !== undefined && !(typeof maxLength === 'number' && Number.isInteger(maxLength) && maxLength >= 1)) {
      this.fail(`${where}: 'maxLength' must be a whole number of 1 or more, got ${FeatureMetaValidator.describe(maxLength)}`);
    }
    if (pattern !== undefined) {
      if (typeof pattern !== 'string' || pattern === '') {
        this.fail(`${where}: 'pattern' must be a regular expression as a non-empty string, got ${FeatureMetaValidator.describe(pattern)}`);
      }
      try {
        FeatureMetas.wholePattern(pattern);
      } catch (error) {
        this.fail(`${where}: 'pattern' is not a regular expression: ${(error as Error).message}`);
      }
    }
    if (typeof spec.default === 'string') {
      const fault = FeatureMetas.textFault(spec as TextParamSpec, spec.default);
      if (fault) {
        this.fail(`${where}: the default ${fault}`);
      }
    }
  }

  /** What a select and a radio share: their options, their default, and how they are laid out. */
  private checkChoice(where: string, type: 'select' | 'radio', spec: Record<string, unknown>): void {
    const options = spec.options;
    if (!Array.isArray(options) || options.length === 0) {
      this.fail(`${where}: a ${type} needs 'options', a list of { label, value }`);
    }
    for (const option of options) {
      this.checkOption(where, option);
    }
    this.distinct(options.map(option => option.value), `${where}: 'options'`);
    if (spec.multiple === true) {
      this.checkChoices(where, spec, options.map(option => option.value));
    } else {
      for (const field of ['min', 'max']) {
        if (spec[field] !== undefined) {
          this.fail(`${where}: '${field}' counts the values of a select with 'multiple: true' — add it or leave '${field}' out`);
        }
      }
      if (spec.default !== undefined && !options.some(option => option.value === spec.default)) {
        this.fail(`${where}: the default ${JSON.stringify(spec.default)} is not one of its options' values`);
      }
    }

    const { displays, columned } = FeatureMetaValidator.CHOICES[type];
    if (spec.display !== undefined) {
      this.oneOf(spec.display, `${where}: 'display'`, displays);
    }
    if (spec.columns !== undefined) {
      if (spec.display !== columned) {
        this.fail(`${where}: 'columns' is for display: '${columned}' — leave it out`);
      }
      if (typeof spec.columns !== 'number' || !Number.isInteger(spec.columns) || spec.columns < 2 || spec.columns > 6) {
        this.fail(`${where}: 'columns' must be a whole number from 2 to 6, got ${FeatureMetaValidator.describe(spec.columns)}`);
      }
    }
  }

  /** A multi-select's own rules: its counts, and a default that is a list its own counts accept. */
  private checkChoices(where: string, spec: Record<string, unknown>, values: unknown[]): void {
    if (spec.min !== undefined && !(typeof spec.min === 'number' && Number.isInteger(spec.min) && spec.min >= 0)) {
      this.fail(`${where}: 'min' must be a whole number, 0 or more, got ${FeatureMetaValidator.describe(spec.min)}`);
    }
    if (spec.max !== undefined && !(typeof spec.max === 'number' && Number.isInteger(spec.max) && spec.max >= 1)) {
      this.fail(`${where}: 'max' must be a whole number, 1 or more, got ${FeatureMetaValidator.describe(spec.max)}`);
    }
    const { min, max } = spec as { min?: number; max?: number };
    if (min !== undefined && max !== undefined && min > max) {
      this.fail(`${where}: 'min' (${min}) is above 'max' (${max})`);
    }
    for (const [field, count] of [['min', min], ['max', max]] as const) {
      if (count !== undefined && count > values.length) {
        this.fail(`${where}: '${field}' (${count}) is more than its ${values.length} options`);
      }
    }
    const fallback = spec.default;
    if (fallback === undefined) {
      if (min !== undefined && min > 0) {
        this.fail(`${where}: with 'min: ${min}' it needs a 'default' — left out, the list starts empty, which its own 'min' refuses`);
      }
      return;
    }
    if (!Array.isArray(fallback)) {
      this.fail(`${where}: the default must be a list of its options' values, got ${FeatureMetaValidator.describe(fallback)}`);
    }
    for (const value of fallback) {
      if (!values.includes(value)) {
        this.fail(`${where}: the default's ${JSON.stringify(value)} is not one of its options' values`);
      }
    }
    this.distinct(fallback, `${where}: the default`);
    if (min !== undefined && fallback.length < min) {
      this.fail(`${where}: the default holds ${fallback.length}, under its 'min' (${min})`);
    }
    if (max !== undefined && fallback.length > max) {
      this.fail(`${where}: the default holds ${fallback.length}, over its 'max' (${max})`);
    }
  }

  private checkOption(where: string, option: unknown): void {
    const entry = option as Record<string, unknown>;
    if (!FeatureCall.isPlainObject(option) || typeof entry.label !== 'string' || entry.label.trim() === ''
        || (typeof entry.value !== 'string' && typeof entry.value !== 'number')) {
      this.fail(`${where}: each option is { label, value } with a string or number value, got ${JSON.stringify(option)}`);
    }
    const at = `${where}: option ${JSON.stringify(entry.value)}`;
    for (const field of Object.keys(entry)) {
      if (!FeatureMetaValidator.OPTION_FIELDS.includes(field)) {
        this.fail(`${at}: unknown field '${field}' — an option's fields are ${FeatureMetaValidator.OPTION_FIELDS.join(', ')}`);
      }
    }
    if (entry.image !== undefined) {
      this.image(entry.image, 'image', `${at}: `);
    }
    if (entry.description !== undefined) {
      this.text(entry.description, `${at}: 'description'`, true);
    }
    if (entry.group !== undefined) {
      this.text(entry.group, `${at}: 'group'`);
    }
    if (entry.keywords !== undefined) {
      const keywords = entry.keywords;
      if (!Array.isArray(keywords) || keywords.length === 0) {
        this.fail(`${at}: 'keywords' must be a non-empty list of words — leave it out when the option has none, got ${FeatureMetaValidator.describe(keywords)}`);
      }
      for (const keyword of keywords) {
        this.text(keyword, `${at}: each of 'keywords'`);
      }
    }
  }

  private checkPicker(where: string, spec: Record<string, unknown>): void {
    const kinds = Array.isArray(spec.picker) ? spec.picker as PickerKind[] : [spec.picker as PickerKind];
    const isList = spec.multiple === true || spec.max !== undefined;
    if (spec.max !== undefined) {
      if (!(typeof spec.max === 'number' && Number.isInteger(spec.max) && spec.max >= 2)) {
        this.fail(`${where}: 'max' must be a whole number of at least 2, got ${FeatureMetaValidator.describe(spec.max)}`);
      }
      if (spec.multiple === false) {
        this.fail(`${where}: 'max' makes the value a list, so it can't be 'multiple: false'`);
      }
    }
    if (spec.ordered === true && !isList) {
      this.fail(`${where}: only a list can be 'ordered' — add 'multiple: true'`);
    }
    if (kinds.includes('sketch') && spec.implicitDefault === true && isList) {
      this.fail(`${where}: only a single sketch can default to the active one`);
    }
    for (const [field, values] of Object.entries(FeatureMetaValidator.ENUMS)) {
      if (spec[field] !== undefined && !values.includes(spec[field] as string)) {
        this.fail(`${where}: '${field}' must be one of ${values.join(', ')}, got ${FeatureMetaValidator.describe(spec[field])}`);
      }
    }
    if (spec.types !== undefined) {
      const types = this.list(spec.types, `${where}: 'types'`);
      for (const type of types) {
        this.text(type, `${where}: each of 'types'`);
      }
      this.distinct(types, `${where}: 'types'`);
    }
    if (spec.anchors !== undefined) {
      const anchors = this.list(spec.anchors, `${where}: 'anchors'`);
      for (const anchor of anchors) {
        this.oneOf(anchor, `${where}: 'anchors'`, FeatureMetaValidator.ANCHORS);
      }
      this.distinct(anchors, `${where}: 'anchors'`);
    }
  }

  /**
   * The values at rest — every one at its resolved default, which is what an
   * untouched dialog shows — and the defaults that depend on them: a select
   * or a radio whose options carry `when` must have its default offered
   * there, and with none declared takes the first option that is. Values are
   * settled in the order their options depend on each other, which is why a
   * circle of them is refused.
   */
  private atRest(params: Record<string, ParamSpec>, declared: Record<string, unknown>): Record<string, ParamSpec> {
    const order: string[] = [];
    const settled = new Map<string, boolean>();
    for (const name of Object.keys(params)) {
      this.settle(name, params, settled, [], order);
    }
    const out = { ...params };
    const rest: Record<string, unknown> = {};
    for (const name of order) {
      const given = (declared[name] as Record<string, unknown>).default !== undefined;
      out[name] = this.offeredDefault(name, params[name], given, rest);
      rest[name] = FeatureMetas.defaultOf(out[name]);
    }
    return out;
  }

  /** Depth first over the values a value's options name: `order` gets each after those it waits on. */
  private settle(name: string, params: Record<string, ParamSpec>, settled: Map<string, boolean>, chain: string[], order: string[]): void {
    if (settled.get(name) === true) {
      return;
    }
    if (settled.get(name) === false) {
      const circle = [...chain.slice(chain.indexOf(name)), name].join(' → ');
      this.fail(`param '${name}': the 'when' of its options comes back round to it (${circle}) — options that wait on each other have no first one to offer`);
    }
    settled.set(name, false);
    const named = new Set(FeatureMetaValidator.optionsOf(params[name]).flatMap(option => FeatureMetas.casesOf(option.when).flatMap(Object.keys)));
    for (const other of named) {
      this.settle(other, params, settled, [...chain, name], order);
    }
    settled.set(name, true);
    order.push(name);
  }

  /** `spec` with a default that is offered at `rest`, or a refusal saying why it has none. */
  private offeredDefault(name: string, spec: ParamSpec, given: boolean, rest: Record<string, unknown>): ParamSpec {
    const options = FeatureMetaValidator.optionsOf(spec);
    if (!options.some(option => option.when !== undefined)) {
      return spec;
    }
    const where = `param '${name}'`;
    const offered = options.filter(option => FeatureMetas.holds(option.when, rest)).map(option => option.value);
    const atRest = `while the other values are at their defaults`;
    if (FeatureMetas.isChoices(spec)) {
      for (const value of spec.default ?? []) {
        if (!offered.includes(value)) {
          this.fail(`${where}: the default's ${JSON.stringify(value)} is not offered ${atRest} — an untouched dialog would show one thing and the builder get another`);
        }
      }
      return spec;
    }
    const choice = spec as SelectParamSpec | RadioParamSpec;
    if (given) {
      if (!offered.includes(choice.default as string | number)) {
        this.fail(`${where}: the default ${JSON.stringify(choice.default)} is not offered ${atRest} — an untouched dialog would show one thing and the builder get another`);
      }
      return spec;
    }
    if (choice.optional) {
      return spec;
    }
    if (offered.length === 0) {
      this.fail(`${where}: none of its options is offered ${atRest} — leave the 'when' off one, or make the value 'optional'`);
    }
    return Object.freeze({ ...choice, default: offered[0] }) as ParamSpec;
  }

  /** The options of a select or a radio; none for any other value. */
  private static optionsOf(spec: ParamSpec): readonly ChoiceOption[] {
    return 'type' in spec && (spec.type === 'select' || spec.type === 'radio') ? spec.options : [];
  }

  /**
   * An option's `when`: one object of clauses, or a non-empty list of them,
   * each checked as one is.
   */
  private optionWhen(where: string, name: string, value: unknown, params: Record<string, ParamSpec>): void {
    if (!Array.isArray(value)) {
      this.clauses(where, name, value, params, false);
      return;
    }
    if (value.length === 0) {
      this.fail(`${where}: the list is empty — list the cases the option is offered in, such as [{ shape: 'single' }, { shape: 'double', height: 20 }], or leave 'when' off to always offer it`);
    }
    value.forEach((each, index) => {
      const at = `${where}[${index}]`;
      if (!FeatureCall.isPlainObject(each)) {
        this.fail(`${at} must be an object of values to match, such as { shape: 'single', height: 40 }, got ${FeatureMetaValidator.describe(each)}`);
      }
      if (Object.keys(each).length === 0) {
        this.fail(`${at} is empty, which would offer the option whatever the other values are — name the values it waits on, or leave 'when' off to always offer it`);
      }
      this.clauses(at, name, each, params, false);
    });
  }

  /**
   * The clauses of a `visibleWhen` or of an option's `when`: each names
   * another typed-in value, compared with values of its own type — or, in a
   * `visibleWhen` (`picks`), a picked value with a {@link PickCondition}.
   */
  private clauses(where: string, name: string, value: unknown, params: Record<string, ParamSpec>, picks: boolean): void {
    if (!FeatureCall.isPlainObject(value) || Object.keys(value).length === 0) {
      this.fail(`${where} must be an object of values to match, such as { style: 'counterbore' }`);
    }
    for (const [other, expected] of Object.entries(value as Record<string, unknown>)) {
      const target = params[other];
      if (other === name) {
        this.fail(`${where} names the value itself`);
      }
      if (!target) {
        this.fail(`${where} names '${other}', which is not one of the feature's values`);
      }
      if (!('type' in target)) {
        if (!picks) {
          this.fail(`${where} names '${other}', a picked value — it can only name a typed-in one`);
        }
        this.pickCondition(`${where}: '${other}'`, other, target, expected);
        continue;
      }
      if (FeatureMetas.isChoices(target)) {
        this.fail(`${where} names '${other}', a select with 'multiple: true' — it can only name a value that holds one thing`);
      }
      const candidates = Array.isArray(expected) ? expected : [expected];
      if (candidates.length === 0) {
        this.fail(`${where}: the values listed for '${other}' are empty`);
      }
      for (const candidate of candidates) {
        if (!FeatureMetaValidator.fits(target, candidate)) {
          this.fail(`${where}: ${JSON.stringify(candidate)} is not a value '${other}' can take`);
        }
      }
    }
  }

  /**
   * A picked value's condition: an object of `picked`, `surface` and `not`,
   * a `surface` only for a value that takes faces.
   */
  private pickCondition(where: string, name: string, target: PickerParamSpec, value: unknown): void {
    if (!FeatureCall.isPlainObject(value) || Object.keys(value).length === 0) {
      this.fail(`${where} is a picked value: give it a condition such as { picked: true } or { surface: 'cylinder' }, got ${FeatureMetaValidator.describe(value)}`);
    }
    for (const [field, given] of Object.entries(value as Record<string, unknown>)) {
      if (field === 'picked') {
        if (typeof given !== 'boolean') {
          this.fail(`${where}: 'picked' must be true or false, got ${FeatureMetaValidator.describe(given)}`);
        }
      } else if (field === 'surface') {
        const kinds = typeof target.picker === 'string' ? [target.picker] : target.picker;
        if (!kinds.includes('face')) {
          this.fail(`${where}: 'surface' tells picked faces apart, and '${name}' picks no faces`);
        }
        const surfaces = Array.isArray(given) ? given : [given];
        if (surfaces.length === 0) {
          this.fail(`${where}: the surfaces listed are empty`);
        }
        for (const surface of surfaces) {
          if (!(PICKED_SURFACES as readonly unknown[]).includes(surface)) {
            this.fail(`${where}: 'surface' takes ${PICKED_SURFACES.map(v => `'${v}'`).join(', ')}, got ${FeatureMetaValidator.describe(surface)}`);
          }
        }
      } else if (field === 'not') {
        this.pickCondition(`${where}: 'not'`, name, target, given);
      } else {
        this.fail(`${where}: unknown field '${field}' — a picked value's condition takes 'picked', 'surface' and 'not'`);
      }
    }
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
    if (call.rest !== null && !FeatureMetas.isList(params[call.rest])) {
      this.fail(`the rest value '...${call.rest}' must be a list — a picker with 'multiple: true'`);
    }
    return FeatureMetaValidator.frozenCopy(value) as CallShape;
  }

  /** Refuse each field `table` leaves out, by name and why — even one left undefined. */
  private leftOut(fields: Record<string, unknown>, table: [string, string][], prefix = ''): void {
    for (const [field, why] of table) {
      if (field in fields) {
        this.fail(`${prefix}leave '${field}' out — ${why}`);
      }
    }
  }

  // The checks below name what they check as `subject`: the field, quoted,
  // and where it sits — `'label'`, `param 'face': 'types'`.

  private text(value: unknown, subject: string, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
      this.fail(`${subject} must be ${allowEmpty ? 'a string' : 'a non-empty string'}, got ${FeatureMetaValidator.describe(value)}`);
    }
    return value;
  }

  /** The image a field names — the feature's icon, an option's picture: an asset of the image kinds. */
  private image(value: unknown, field: string, where = ''): string {
    return this.assetPath(value, field, FeatureMetaValidator.IMAGE, 'an image (.svg, .png, .jpg or .webp)', where);
  }

  /** A path to a file next to the module: relative, inside its directory, of the given kind. */
  private assetPath(value: unknown, field: string, extension: RegExp, kind: string, where = ''): string {
    const path = this.text(value, `${where}'${field}'`);
    const segments = path.replace(/^\.\//, '').split('/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.includes('\\') || segments.some(segment => segment === '..' || segment === '')) {
      this.fail(`${where}'${field}' must be a relative path inside the module's directory, such as './${field}.svg', got '${path}'`);
    }
    if (!extension.test(path)) {
      this.fail(`${where}'${field}' must be ${kind}, got '${path}'`);
    }
    return path;
  }

  private oneOf(value: unknown, subject: string, values: readonly string[]): string {
    if (typeof value !== 'string' || !values.includes(value)) {
      this.fail(`${subject} must be one of ${values.join(', ')}, got ${FeatureMetaValidator.describe(value)}`);
    }
    return value;
  }

  private list(value: unknown, subject: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0) {
      this.fail(`${subject} must be a non-empty list, got ${FeatureMetaValidator.describe(value)}`);
    }
    return value;
  }

  private distinct(values: unknown[], subject: string): void {
    const repeated = values.find((value, i) => values.indexOf(value) !== i);
    if (repeated !== undefined) {
      this.fail(`${subject} lists ${JSON.stringify(repeated)} twice`);
    }
  }

  private fail(message: string): never {
    throw new Error(`${this.where}: ${message}`);
  }

  private static owns(object: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /** Whether `value` is one a typed-in value of `spec` could hold. */
  private static fits(spec: ScalarParamSpec, value: unknown): boolean {
    switch (spec.type) {
      case 'boolean':
        return typeof value === 'boolean';
      case 'text':
        return typeof value === 'string';
      case 'select':
      case 'radio':
        return spec.options.some(option => option.value === value);
      default:
        return typeof value === 'number' && Number.isFinite(value);
    }
  }

  private static kindName(spec: Record<string, unknown>): string {
    if (Array.isArray(spec.picker)) {
      return `a picker of ${FeatureMetaValidator.listed(spec.picker.map(String))}`;
    }
    const name = String('type' in spec ? spec.type : spec.picker);
    return `${FeatureMetaValidator.article(name)} ${name} ${'type' in spec ? 'value' : 'picker'}`;
  }

  /** `a, b or c`. */
  static listed(words: string[]): string {
    return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  }

  static article(word: string): string {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
  }

  /** `object` without its undefined entries. */
  static defined(object: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
  }

  private static range(min: number | undefined, max: number | undefined): string {
    if (min !== undefined && max !== undefined) {
      return `${min} to ${max}`;
    }
    return min !== undefined ? `${min} and up` : `up to ${max}`;
  }

  static describe(value: unknown): string {
    if (value === undefined) {
      return 'nothing';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return 'a list';
    }
    return typeof value === 'function' ? 'a function' : `${FeatureMetaValidator.article(typeof value)} ${typeof value}`;
  }

  /** A deep copy of plain data, frozen. */
  private static frozenCopy(value: unknown): unknown {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(entry => FeatureMetaValidator.frozenCopy(entry)));
    }
    if (FeatureCall.isPlainObject(value)) {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, FeatureMetaValidator.frozenCopy(entry)])));
    }
    return value;
  }
}

/**
 * Feature metadata from the engine's side: checking it, attaching it to a
 * builder, finding the builders a module exports, reading a builder's
 * arguments by it, and the JSON snapshot the editor sends the UI.
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
   * timeline rows read, and the operations its statements may choose, with
   * the default one a statement without a chain applies.
   */
  static attach(builder: Function, meta: ResolvedFeatureMeta): void {
    Object.defineProperty(builder, FeatureMetas.KEY, { value: meta });
    Feature.register(meta.class, { label: meta.label, operations: meta.operations, defaultOperation: meta.defaultOperation });
  }

  /** What `defineFeature()` takes from the class rather than its metadata, and why. */
  private static readonly FROM_THE_CLASS: [string, string][] = [
    ['class', "the class is defineFeature()'s first argument"],
    ['params', 'the values are the class\'s own, declared with Feature.with({ … })'],
    ['kind', 'it is read from the class: one that implements buildTool() is a tool, one that overrides build() a modifier'],
    ['buckets', 'declare buckets on the class: Feature.with(params, { buckets })'],
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
      const copy = FeatureMetas.json(FeatureMetas.withDefault(spec)) as ParamSpecSnapshot;
      params[name] = { ...copy, label: FeatureMetas.labelOf(name, spec) };
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
      if (spec && FeatureMetas.requires(spec)) {
        throw new Error(`${FeatureMetas.calleeOf(meta.id)}(): '${name}' is required — it comes before the options`);
      }
    }
    return FeatureMetas.complete(meta, read);
  }

  /** Whether a value left out of a call fails it: nothing fills it — no default, not optional. */
  static requires(spec: ParamSpec): boolean {
    if ('picker' in spec) {
      return !spec.optional && !(spec.picker === 'sketch' && spec.implicitDefault);
    }
    return !spec.optional && !FeatureMetas.isChoices(spec) && FeatureMetas.defaultOf(spec) === undefined;
  }

  /**
   * Values by name — however they were gathered: read off a call, or put
   * together by the editor's preview — completed and checked as
   * {@link values} does: every declared value present, defaults filled,
   * each value checked against its declaration.
   */
  static complete(meta: ResolvedFeatureMeta, read: Readonly<Record<string, unknown>>): FeatureValues {
    const callee = FeatureMetas.calleeOf(meta.id);
    const values: FeatureValues = {};
    for (const [name, spec] of Object.entries(meta.params)) {
      let value = read[name];
      if (value === undefined || value === null) {
        value = FeatureMetas.defaultOf(spec) ?? value;
      }
      values[name] = 'type' in spec
        ? FeatureMetas.scalarValue(callee, name, spec, value)
        : FeatureMetas.pickedValue(callee, name, spec, value);
    }
    return values;
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

  /**
   * The value a call that leaves `spec`'s value out (or passes `null`) gives
   * the feature — what the builder fills, what the snapshot carries and what
   * the dialog shows, so a row left untouched writes nothing and still
   * builds: the declared `default`; else, for a control that always shows a
   * value, the one it shows — `false` for a boolean, the first option for a
   * select or a radio that isn't `optional`, `min` for a slider (its track
   * always shows a position). Nothing for the rest: a picked
   * value, a number or a text without a default (the dialog shows those
   * empty, and asks for one that isn't optional), an optional select or radio
   * without one (the dialog offers an empty choice, or shows none chosen).
   * A select with `multiple: true` always has one: its declared list, or the
   * empty list.
   */
  static defaultOf(spec: ParamSpec): FeatureScalar | readonly (string | number)[] | undefined {
    if (!('type' in spec)) {
      return undefined;
    }
    if (FeatureMetas.isChoices(spec)) {
      return spec.default ?? [];
    }
    if (spec.default !== undefined) {
      return spec.default;
    }
    if (spec.type === 'boolean') {
      return false;
    }
    if (spec.type !== 'select' && spec.type !== 'radio' && spec.type !== 'text' && spec.display === 'slider') {
      return spec.min;
    }
    if ((spec.type === 'select' || spec.type === 'radio') && !spec.optional) {
      return spec.options[0]?.value;
    }
    return undefined;
  }

  /** A text's `pattern` as it is matched: against the whole value. Throws when it doesn't compile. */
  static wholePattern(pattern: string): RegExp {
    return new RegExp(`^(?:${pattern})$`, 'u');
  }

  /**
   * What is wrong with a text value by its spec's `maxLength` and `pattern`,
   * as the rest of a sentence about it ("must be at most 12 characters, got
   * 14"); nothing when it keeps to both.
   */
  static textFault(spec: Pick<TextParamSpec, 'maxLength' | 'pattern'>, value: string): string | undefined {
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      return `must be at most ${spec.maxLength} characters, got ${value.length}`;
    }
    if (spec.pattern !== undefined && !FeatureMetas.wholePattern(spec.pattern).test(value)) {
      return `must match ${spec.pattern}, got ${JSON.stringify(value)}`;
    }
    return undefined;
  }

  /**
   * Whether an option's `when` holds for `values` by name: every clause of
   * one object, or of any one of a list. A value that is not there holds no
   * clause; no clauses always hold.
   */
  static holds(when: OptionWhen | undefined, values: Readonly<Record<string, unknown>>): boolean {
    if (Array.isArray(when)) {
      return FeatureMetas.casesOf(when).some(each => FeatureMetas.holds(each, values));
    }
    return Object.entries((when ?? {}) as OptionCase).every(([name, expected]) => {
      const value = values[name];
      return value !== undefined && (Array.isArray(expected) ? expected.includes(value) : expected === value);
    });
  }

  /** The cases of an option's `when`: the one object, each of a list, or none. */
  static casesOf(when: OptionWhen | undefined): readonly OptionCase[] {
    return when === undefined ? [] : Array.isArray(when) ? when as readonly OptionCase[] : [when as OptionCase];
  }

  /**
   * Whether a picked value meets its condition, given what it holds: how
   * many picks, and the surface of each (`null` for a pick that is not a
   * face, or not yet told apart).
   */
  static pickHolds(condition: PickCondition, picks: readonly (PickedSurface | null)[]): boolean {
    if (condition.picked !== undefined && condition.picked !== picks.length > 0) {
      return false;
    }
    if (condition.surface !== undefined) {
      const wanted: readonly PickedSurface[] = typeof condition.surface === 'string' ? [condition.surface] : condition.surface;
      if (picks.length === 0 || !picks.every(surface => surface !== null && wanted.includes(surface))) {
        return false;
      }
    }
    return condition.not === undefined || !FeatureMetas.pickHolds(condition.not, picks);
  }

  /** `spec` with its resolved default ({@link defaultOf}) written in, when it resolves to one. */
  static withDefault(spec: ParamSpec): ParamSpec {
    const fallback = FeatureMetas.defaultOf(spec);
    return fallback === undefined || ('default' in spec && spec.default === fallback)
      ? spec
      : { ...spec, default: fallback } as ParamSpec;
  }

  /** Whether a value is a select with `multiple: true`: the typed-in value that is a list of option values. */
  static isChoices(spec: ParamSpec | undefined): spec is MultiSelectParamSpec {
    return !!spec && 'type' in spec && spec.type === 'select' && spec.multiple === true;
  }

  /**
   * A multi-select's value, checked: a list (one value alone is not one) of
   * option values, none twice, as many as `min` and `max` allow — a copy, in
   * the order written.
   */
  private static choicesValue(callee: string, name: string, spec: MultiSelectParamSpec, value: unknown): (string | number)[] {
    const offered = spec.options.map(option => JSON.stringify(option.value)).join(', ');
    if (!Array.isArray(value)) {
      throw new Error(`${callee}(): '${name}' must be a list of ${offered}, got ${FeatureMetaValidator.describe(value)}`);
    }
    for (const [index, entry] of value.entries()) {
      if (!spec.options.some(option => option.value === entry)) {
        throw new Error(`${callee}(): each of '${name}' must be one of ${offered}, got ${FeatureMetaValidator.describe(entry)}`);
      }
      if (value.indexOf(entry) !== index) {
        throw new Error(`${callee}(): '${name}' lists ${JSON.stringify(entry)} twice`);
      }
    }
    if (spec.min !== undefined && value.length < spec.min) {
      throw new Error(`${callee}(): '${name}' takes at least ${spec.min}, got ${value.length}`);
    }
    if (spec.max !== undefined && value.length > spec.max) {
      throw new Error(`${callee}(): '${name}' takes at most ${spec.max}, got ${value.length}`);
    }
    return [...value];
  }

  /** Whether a value is a list: a picker with `multiple` or a `max`. */
  static isList(spec: ParamSpec | undefined): boolean {
    if (!spec || !('picker' in spec)) {
      return false;
    }
    const list = spec as ListPicker;
    return list.multiple === true || list.max !== undefined;
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

  private static scalarValue(callee: string, name: string, spec: ScalarParamSpec, value: unknown): FeatureValues[string] {
    if (FeatureMetas.isChoices(spec)) {
      return FeatureMetas.choicesValue(callee, name, spec, value ?? []);
    }
    if (value === undefined || value === null) {
      if (!spec.optional) {
        throw new Error(`${callee}(): '${name}' is required`);
      }
      return value as null | undefined;
    }
    const got = FeatureMetaValidator.describe(value);
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`${callee}(): '${name}' must be true or false, got ${got}`);
        }
        return value;
      case 'text':
        if (typeof value !== 'string') {
          throw new Error(`${callee}(): '${name}' must be a string, got ${got}`);
        }
        {
          const fault = FeatureMetas.textFault(spec, value);
          if (fault) {
            throw new Error(`${callee}(): '${name}' ${fault}`);
          }
        }
        return value;
      case 'select':
      case 'radio':
        if (!spec.options.some(option => option.value === value)) {
          throw new Error(`${callee}(): '${name}' must be one of ${spec.options.map(option => JSON.stringify(option.value)).join(', ')}, got ${got}`);
        }
        return value as string | number;
      default: {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`${callee}(): '${name}' must be a number, got ${got}`);
        }
        if (spec.type === 'integer' && !Number.isInteger(value)) {
          throw new Error(`${callee}(): '${name}' must be a whole number, got ${value}`);
        }
        if (spec.min !== undefined && value < spec.min) {
          throw new Error(`${callee}(): '${name}' must be at least ${spec.min}, got ${value}`);
        }
        if (spec.max !== undefined && value > spec.max) {
          throw new Error(`${callee}(): '${name}' must be at most ${spec.max}, got ${value}`);
        }
        return value;
      }
    }
  }

  private static pickedValue(callee: string, name: string, spec: PickerParamSpec, value: unknown): FeatureValues[string] {
    const kinds = FeatureMetas.kindsOf(spec);
    const required = !spec.optional && !(spec.picker === 'sketch' && spec.implicitDefault);
    const picked = (entry: unknown, subject: string): SceneObject => {
      const datum = FeatureMetas.datum(kinds, entry);
      const refusal = FeatureMetas.refusal(kinds, spec, datum);
      if (refusal) {
        throw new Error(`${callee}(): ${subject} must be ${refusal}, got ${FeatureMetas.describeValue(entry)}`);
      }
      return datum as SceneObject;
    };
    if (FeatureMetas.isList(spec)) {
      const list = (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])
        .map(entry => picked(entry, `each of '${name}'`));
      if (required && list.length === 0) {
        throw new Error(`${callee}(): '${name}' is required — pick at least one ${FeatureMetaValidator.listed(kinds)}`);
      }
      const max = (spec as ListPicker).max;
      if (max !== undefined && list.length > max) {
        throw new Error(`${callee}(): '${name}' takes at most ${max}, got ${list.length}`);
      }
      return list;
    }
    if (value === undefined || value === null) {
      if (required) {
        throw new Error(`${callee}(): '${name}' is required`);
      }
      return value as null | undefined;
    }
    return picked(value, `'${name}'`);
  }

  /** The kinds a picked value takes: its picker's one kind, or each of a union's. */
  static kindsOf(spec: PickerParamSpec): PickerKind[] {
    return Array.isArray(spec.picker) ? [...spec.picker as readonly PickerKind[]] : [spec.picker as PickerKind];
  }

  /**
   * Why a value can't be picked for a value of `kinds`, as what it must be
   * instead — or null when one of the kinds takes it. A connector, a point
   * and an anchor are read as locations, so each must be one; every other
   * kind takes any scene object (its picker in the dialog is what tells
   * them apart).
   */
  private static refusal(kinds: PickerKind[], spec: PickerParamSpec, value: unknown): string | null {
    const anchors = (spec as { anchors?: readonly ('center' | 'start' | 'end' | 'offset')[] }).anchors;
    if (!(value instanceof SceneObject)) {
      return FeatureMetas.takes(kinds, anchors);
    }
    const fits = kinds.some(kind => !FeatureMetas.isLocation(kind) || Locations.accepts(kind as LocationKind, value, anchors));
    return fits ? null : FeatureMetas.takes(kinds, anchors);
  }

  private static isLocation(kind: PickerKind): boolean {
    return kind === 'connector' || kind === 'point' || kind === 'anchor';
  }

  /** What a value of `kinds` takes, as a refusal names it — an anchor at the points `anchors` lists, when it lists some. */
  private static takes(kinds: PickerKind[], anchors?: readonly string[]): string {
    if (kinds.every(kind => FeatureMetas.isLocation(kind))) {
      return FeatureMetaValidator.listed(kinds.map(kind => kind === 'anchor' && anchors && anchors.length > 0
        ? `an anchor at ${FeatureMetaValidator.listed(anchors.map(anchor => `${anchor}()`))} (e.endFaces().center())`
        : FeatureMetas.LOCATION_NAMES[kind as LocationKind]));
    }
    const datums = [
      ...(kinds.includes('axis') ? ['an axis, a world axis or a connector'] : []),
      ...(kinds.includes('plane') ? ['a plane or an origin plane'] : []),
    ];
    return `a scene object (a selection, a sketch, a feature${datums.map(datum => `, ${datum}`).join('')})`;
  }

  private static readonly LOCATION_NAMES: Record<LocationKind, string> = {
    connector: 'a connector (bolt, bolt.instance(2))',
    point: 'a point (s.geometries.c.center(), e.endEdges(0).start())',
    anchor: 'an anchor (e.endFaces().center())',
  };

  /** What a refused value was, for the message: a location's kind, or what the value is. */
  private static describeValue(value: unknown): string {
    if (value instanceof AnchoredLazyVertex) {
      return `an anchor at ${value.getAnchorSpec().kind}()`;
    }
    if (value instanceof SceneObject) {
      const kinds = Locations.kindsOf(value);
      const kind = kinds.length > 0 ? kinds[kinds.length - 1] : value.getType();
      return `${FeatureMetaValidator.article(kind)} ${kind}`;
    }
    return FeatureMetaValidator.describe(value);
  }

  /**
   * An axis value may name a world axis (`'z'`) or a connector (`bolt`,
   * `bolt.instance(2)` — its Z axis through its origin) and a plane value
   * an origin plane (`'xy'`, `'front'`) — the way every built-in takes them,
   * and what the dialog writes for one picked in the viewport; a resolved
   * `Axis` or `Plane` works too. Each becomes the scene object `axis('z')`,
   * `revolve(bolt, …)` or `plane('xy')` would build, so the feature reads
   * every axis and every plane one way ({@link Feature.axisOf}, {@link
   * Feature.planeOf}) and the builder's `addTo()` puts it in the scene ahead
   * of the feature. It serves the feature's statement alone, so the
   * timeline leaves it out, as it does the plane `sketch('xy', …)` makes
   * itself.
   */
  private static datum(kinds: PickerKind[], value: unknown): unknown {
    let datum: SceneObject | null = null;
    const connector = kinds.includes('axis') ? ConnectorAxis.connectorOf(value) : null;
    if (connector) {
      // A connector is an axis — its Z axis through its origin — read the
      // way every built-in reads one (`resolveAxis`); internal already.
      return AxisFromConnector.inline(connector);
    }
    if (kinds.includes('axis') && (isStandardAxis(value) || value instanceof Axis)) {
      datum = new AxisObject(value instanceof Axis ? value : normalizeAxis(value));
    } else if (kinds.includes('plane') && (value instanceof Plane || (typeof value === 'string' && isPlaneLike(value)))) {
      datum = new PlaneObject(normalizePlane(value));
    }
    if (!datum) {
      return value;
    }
    datum.markInternal();
    return datum;
  }

  private static json(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /** A value's label: the one it declares, or its name made readable. */
  static labelOf(name: string, spec: ParamSpec): string {
    return spec.label ?? FeatureMetas.humanize(name);
  }

  /** `holeDiameter` → `Hole diameter`. */
  private static humanize(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
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
