import { SceneObject } from "../common/scene-object.js";
import { GIVEN_VALUES } from "./feature-inputs.js";
import type { FeatureScalar, FeatureValues } from "./feature-inputs.js";
import { FeatureCall } from "./call-shape.js";
import { Axis, isStandardAxis } from "../math/axis.js";
import { Plane, isPlaneLike } from "../math/plane.js";
import { AxisObject } from "../features/axis.js";
import { AxisFromConnector } from "../features/axis-from-connector.js";
import { ConnectorAxis } from "../features/connector-axis.js";
import { PlaneObject } from "../features/plane.js";
import { normalizeAxis, normalizePlane } from "../helpers/normalize.js";
import { Locations, type LocationKind } from "../features/locations.js";
import { AnchoredLazyVertex } from "../features/anchored-vertex.js";
import type { FeatureLayoutChecks } from "./layout.js";
import { ValueConditions } from "./value-conditions.js";
import type {
  ChoiceOption, ConditionalDefault, MultiSelectParamSpec, NumberParamSpec, OptionCase, OptionWhen, ParamSpec, ParamSpecSnapshot, PickCondition,
  PickedSurface, PickerKind, PickerParamSpec, RadioParamSpec, ScalarParamSpec, ScalarParamType, SelectParamSpec, TextParamSpec, VisibleWhen,
} from "./meta.js";

/** The surfaces a {@link PickCondition} may name. */
export const PICKED_SURFACES: readonly PickedSurface[] = ['planar', 'cylinder', 'cone', 'sphere', 'torus', 'other'];

/** What a picker that may pick several things declares (see `ParamSpec`). */
type ListPicker = {
  multiple?: boolean;
  max?: number;
  ordered?: boolean;
};

/**
 * Checks a schema's value declarations — the `params` a feature, a
 * generated part and a generator declare with `Feature.with({ … })` — and
 * resolves them, and the checks every metadata validator built on it
 * shares: text, images, lists, enums. Every refusal names who it speaks of
 * (`where`, such as `feature 'standoff'`) and the field, so a typo fails
 * where the module is loaded rather than in a dialog that cannot be built.
 *
 * The feature metadata's validator extends it with the feature's own
 * fields (group, kind, call shape, operations); `definePart` with a part's
 * (label, icon, layout).
 */
export class SchemaValidator {

  private static readonly NAME = /^[A-Za-z_$][\w$]*$/;

  private static readonly COMMON_FIELDS = ['label', 'description', 'group', 'tab', 'hint', 'aside', 'visibleWhen', 'optional'];

  private static readonly NUMBER_FIELDS = ['default', 'min', 'max', 'step'];

  /** What a number type may declare: its numbers, its conditional defaults, and how its row looks. */
  private static readonly NUMBER_SPEC_FIELDS = [...SchemaValidator.NUMBER_FIELDS, 'defaults', 'display', 'suffix'];

  private static readonly SCALAR_FIELDS: Record<ScalarParamType, string[]> = {
    number: SchemaValidator.NUMBER_SPEC_FIELDS,
    integer: SchemaValidator.NUMBER_SPEC_FIELDS,
    length: SchemaValidator.NUMBER_SPEC_FIELDS,
    angle: SchemaValidator.NUMBER_SPEC_FIELDS,
    boolean: ['default', 'defaults', 'display'],
    select: ['default', 'defaults', 'options', 'display', 'columns', 'search', 'multiple', 'min', 'max'],
    radio: ['default', 'defaults', 'options', 'display', 'columns'],
    text: ['default', 'defaults', 'multiline', 'placeholder', 'maxLength', 'pattern'],
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

  /** What one entry of a value's `defaults` carries. */
  private static readonly DEFAULTS_FIELDS = ['when', 'value'];

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

  /**
   * A picker kind's fields refused by name rather than as unknown, each with
   * why it is left out — on that kind and on every union that takes it.
   */
  private static readonly PICKER_LEFT_OUT: Partial<Record<PickerKind, [string, string][]>> = {
    edge: [['tangents', 'tangent chains are for fillet and chamfer only']],
    axis: [['connector', 'an axis picker always takes connectors']],
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

  /** @param where Who the messages name, such as `feature 'standoff'`; a subclass may name it once it knows. */
  constructor(protected where: string) {}

  /**
   * The values `value` declares, by name, checked and resolved: each a
   * frozen copy with its resolved default written in — the one it settles
   * on at rest, where its options' `when` decides it (see
   * {@link ValueSchema.defaultOf}).
   */
  params(value: unknown): Record<string, ParamSpec> {
    if (!FeatureCall.isPlainObject(value)) {
      this.fail(`'params' must be an object of the feature's values by name, got ${SchemaValidator.describe(value)}`);
    }
    const params = value as Record<string, unknown>;
    const out: Record<string, ParamSpec> = {};
    for (const [name, spec] of Object.entries(params)) {
      if (!SchemaValidator.NAME.test(name)) {
        this.fail(`the value name '${name}' is not an identifier`);
      }
      out[name] = this.param(name, spec);
    }
    for (const [name, spec] of Object.entries(out)) {
      if (spec.visibleWhen !== undefined) {
        this.visibleWhen(`param '${name}': 'visibleWhen'`, name, spec.visibleWhen, out);
      }
      for (const option of SchemaValidator.optionsOf(spec)) {
        if (option.when !== undefined) {
          this.optionWhen(`param '${name}': option ${JSON.stringify(option.value)}: 'when'`, name, option.when, out);
        }
      }
      SchemaValidator.defaultsOf(spec).forEach((entry, index) => {
        const where = `param '${name}': defaults[${index}]: 'when'`;
        this.optionWhen(where, name, entry.when, out);
        for (const other of ValueConditions.namesOf(entry.when)) {
          if (ValueConditions.hasDefaults(out[other] as { defaults?: [] })) {
            this.fail(`${where} names '${other}', which declares 'defaults' itself — a conditional default waits only on values whose default is fixed (one level, no chains)`);
          }
        }
      });
    }
    return Object.freeze(this.atRest(out, params));
  }

  /**
   * What a layout's checks borrow over `params`: the values, this
   * validator's refusals, its clause check and an image check — by default
   * {@link image}, a path inside the module's directory.
   */
  layoutChecks(params: Record<string, ParamSpec>, image?: (value: unknown, where: string) => string): FeatureLayoutChecks {
    return {
      params,
      fail: message => this.fail(message),
      visibleWhen: (where, value) => this.visibleWhen(where, '', value, params),
      image: image ?? ((value, where) => this.image(value, 'image', where)),
      describe: value => SchemaValidator.describe(value),
    };
  }

  private param(name: string, value: unknown): ParamSpec {
    const where = `param '${name}'`;
    if (!FeatureCall.isPlainObject(value)) {
      this.fail(`${where} must be an object such as { type: 'length' } or { picker: 'face' }, got ${SchemaValidator.describe(value)}`);
    }
    const spec = value as Record<string, unknown>;
    if (('type' in spec) === ('picker' in spec)) {
      this.fail(`${where} declares ${'type' in spec ? "both a 'type' and a 'picker'" : "neither a 'type' nor a 'picker'"}`);
    }
    const fields = 'type' in spec ? this.scalarFields(where, spec) : this.pickerFields(where, spec);
    for (const field of Object.keys(spec)) {
      if (field !== 'type' && field !== 'picker' && !fields.includes(field)) {
        this.fail(`${where}: unknown field '${field}' for ${SchemaValidator.kindName(spec)} — its fields are ${fields.join(', ')}`);
      }
    }

    for (const field of ['label', 'description', 'group', 'tab', 'hint']) {
      if (spec[field] !== undefined) {
        this.text(spec[field], `${where}: '${field}'`, field === 'description');
      }
    }
    for (const field of SchemaValidator.BOOLEAN_FIELDS) {
      if (spec[field] !== undefined && typeof spec[field] !== 'boolean') {
        this.fail(`${where}: '${field}' must be true or false, got ${SchemaValidator.describe(spec[field])}`);
      }
    }
    if ('type' in spec) {
      this.checkScalar(where, spec);
      if (spec.defaults !== undefined) {
        this.checkDefaults(name, where, spec);
      }
    } else {
      this.checkPicker(where, spec);
    }
    return SchemaValidator.frozenCopy(ValueSchema.withDefault(spec as ParamSpec)) as ParamSpec;
  }

  private scalarFields(where: string, spec: Record<string, unknown>): string[] {
    if (spec.type === 'radio' && spec.multiple !== undefined) {
      this.fail(`${where}: 'multiple' is for a select — a radio holds one value`);
    }
    if (typeof spec.type !== 'string' || !SchemaValidator.owns(SchemaValidator.SCALAR_FIELDS, spec.type)) {
      this.fail(`${where}: unknown type ${SchemaValidator.describe(spec.type)} — the types are ${Object.keys(SchemaValidator.SCALAR_FIELDS).join(', ')}`);
    }
    return [...SchemaValidator.COMMON_FIELDS, ...SchemaValidator.SCALAR_FIELDS[spec.type as ScalarParamType]];
  }

  private pickerFields(where: string, spec: Record<string, unknown>): string[] {
    const kinds = this.pickerKinds(where, spec);
    for (const kind of kinds) {
      this.leftOut(spec, SchemaValidator.PICKER_LEFT_OUT[kind] ?? [], `${where}: `);
    }
    if ('default' in spec || 'defaults' in spec) {
      this.fail(`${where}: a picker takes no ${'default' in spec ? 'default' : 'defaults'} — its value is what the user picks`);
    }
    const single = kinds.find(kind => !SchemaValidator.PICKERS[kind].list);
    if (single) {
      const listField = SchemaValidator.LIST_FIELDS.find(field => field in spec);
      if (listField) {
        this.fail(kinds.length === 1
          ? `${where}: ${SchemaValidator.article(single)} ${single} picker picks one ${single}, so it takes no '${listField}'`
          : `${where}: a picker that takes ${SchemaValidator.article(single)} ${single} picks one thing, so it takes no '${listField}'`);
      }
    }
    const fields = kinds.flatMap(kind => SchemaValidator.PICKERS[kind].fields);
    return [...new Set([...SchemaValidator.COMMON_FIELDS, ...(single ? [] : SchemaValidator.LIST_FIELDS), ...fields])];
  }

  /**
   * The kinds a picker takes: one, or a union of several (`['connector',
   * 'point', 'anchor']`) whose kinds take different clicks — each pick is
   * routed to the one kind that takes it.
   */
  private pickerKinds(where: string, spec: Record<string, unknown>): PickerKind[] {
    const known = Object.keys(SchemaValidator.PICKERS);
    const listed = Array.isArray(spec.picker) ? spec.picker as unknown[] : [spec.picker];
    if (Array.isArray(spec.picker) && listed.length < 2) {
      this.fail(`${where}: a picker that takes several kinds lists at least two, such as ['connector', 'point', 'anchor']${listed.length === 1 ? ` — for one, write picker: ${SchemaValidator.describe(listed[0])}` : ''}`);
    }
    for (const kind of listed) {
      if (typeof kind !== 'string' || !SchemaValidator.owns(SchemaValidator.PICKERS, kind)) {
        this.fail(`${where}: unknown picker ${SchemaValidator.describe(kind)} — the pickers are ${known.join(', ')}`);
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
        const clicks = [...SchemaValidator.CLICKS[kind], ...(kind === 'edge' && spec.facesAsEdges === true ? ['a face'] : [])];
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
        this.fail(`${where}: the default must be ${type === 'boolean' ? 'true or false' : 'a string'}, got ${SchemaValidator.describe(value)}`);
      }
      if (type === 'boolean') {
        if (spec.display !== undefined && spec.display !== 'checkbox') {
          this.fail(`${where}: 'display' must be 'checkbox' — leave it out for the toggle — got ${SchemaValidator.describe(spec.display)}`);
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

    for (const field of SchemaValidator.NUMBER_FIELDS) {
      if (spec[field] !== undefined && !(typeof spec[field] === 'number' && Number.isFinite(spec[field]))) {
        this.fail(`${where}: '${field}' must be a finite number, got ${SchemaValidator.describe(spec[field])}`);
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
        this.fail(`${where}: the default (${value}) is outside ${SchemaValidator.range(min, max)}`);
      }
    }
    this.checkNumberLook(where, type, spec);
  }

  /**
   * A value's `defaults`: a non-empty list of `{ when, value }`, each value
   * checked as a call's value of the declaration is (its type, its range,
   * one of its options), and a plain default to fall back on. The `when` of
   * each is checked once every value is known (see {@link params}), and
   * what each offers where it holds once the values settle ({@link atRest}).
   */
  private checkDefaults(name: string, where: string, spec: Record<string, unknown>): void {
    const defaults = spec.defaults;
    if (!Array.isArray(defaults) || defaults.length === 0) {
      this.fail(`${where}: 'defaults' must be a non-empty list of { when, value }, such as [{ when: { type: 'wall' }, value: 720 }], got ${SchemaValidator.describe(defaults)}`);
    }
    defaults.forEach((entry, index) => {
      const at = `${where}: defaults[${index}]`;
      if (!FeatureCall.isPlainObject(entry)) {
        this.fail(`${at} must be { when, value }, such as { when: { type: 'wall' }, value: 720 }, got ${SchemaValidator.describe(entry)}`);
      }
      for (const field of Object.keys(entry)) {
        if (!SchemaValidator.DEFAULTS_FIELDS.includes(field)) {
          this.fail(`${at}: unknown field '${field}' — an entry of 'defaults' is { when, value }`);
        }
      }
      if (entry.when === undefined) {
        this.fail(`${at} needs a 'when': the values it waits on, such as { type: 'wall' }`);
      }
      if (entry.value === undefined || entry.value === null) {
        this.fail(`${at} needs a 'value': the default while its 'when' holds`);
      }
      try {
        ValueSchema.checkScalar(at, name, { ...spec, optional: false } as unknown as ParamSpec, entry.value);
      } catch (error) {
        this.fail((error as Error).message);
      }
    });
    if (ValueSchema.defaultOf(spec as unknown as ParamSpec) === undefined) {
      this.fail(`${where}: a value with 'defaults' needs a 'default' — the one it takes when none of them holds`);
    }
  }

  /** How a number's row looks: its `display`, which its type must have, and its `suffix`. */
  private checkNumberLook(where: string, type: NumberParamSpec['type'], spec: Record<string, unknown>): void {
    if (spec.display !== undefined) {
      const displays = SchemaValidator.NUMBER_DISPLAYS[type];
      if (spec.display === 'stepper' && !displays.includes('stepper')) {
        this.fail(`${where}: display: 'stepper' is for a number or an integer — ${type === 'angle' ? 'an angle' : 'a length'} takes 'slider', or leave it out`);
      }
      if (typeof spec.display !== 'string' || !displays.includes(spec.display)) {
        this.fail(`${where}: 'display' must be one of ${displays.join(', ')} — leave it out for the plain input — got ${SchemaValidator.describe(spec.display)}`);
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
      if (typeof suffix !== 'string' || suffix.trim() === '' || suffix.length > SchemaValidator.SUFFIX_LENGTH) {
        this.fail(`${where}: 'suffix' must be a non-empty string of at most ${SchemaValidator.SUFFIX_LENGTH} characters, got ${SchemaValidator.describe(suffix)}`);
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
      this.fail(`${where}: 'maxLength' must be a whole number of 1 or more, got ${SchemaValidator.describe(maxLength)}`);
    }
    if (pattern !== undefined) {
      if (typeof pattern !== 'string' || pattern === '') {
        this.fail(`${where}: 'pattern' must be a regular expression as a non-empty string, got ${SchemaValidator.describe(pattern)}`);
      }
      try {
        ValueSchema.wholePattern(pattern);
      } catch (error) {
        this.fail(`${where}: 'pattern' is not a regular expression: ${(error as Error).message}`);
      }
    }
    if (typeof spec.default === 'string') {
      const fault = ValueSchema.textFault(spec as TextParamSpec, spec.default);
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

    const { displays, columned } = SchemaValidator.CHOICES[type];
    if (spec.display !== undefined) {
      this.oneOf(spec.display, `${where}: 'display'`, displays);
    }
    if (spec.columns !== undefined) {
      if (spec.display !== columned) {
        this.fail(`${where}: 'columns' is for display: '${columned}' — leave it out`);
      }
      if (typeof spec.columns !== 'number' || !Number.isInteger(spec.columns) || spec.columns < 2 || spec.columns > 6) {
        this.fail(`${where}: 'columns' must be a whole number from 2 to 6, got ${SchemaValidator.describe(spec.columns)}`);
      }
    }
  }

  /** A multi-select's own rules: its counts, and a default that is a list its own counts accept. */
  private checkChoices(where: string, spec: Record<string, unknown>, values: unknown[]): void {
    if (spec.min !== undefined && !(typeof spec.min === 'number' && Number.isInteger(spec.min) && spec.min >= 0)) {
      this.fail(`${where}: 'min' must be a whole number, 0 or more, got ${SchemaValidator.describe(spec.min)}`);
    }
    if (spec.max !== undefined && !(typeof spec.max === 'number' && Number.isInteger(spec.max) && spec.max >= 1)) {
      this.fail(`${where}: 'max' must be a whole number, 1 or more, got ${SchemaValidator.describe(spec.max)}`);
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
      this.fail(`${where}: the default must be a list of its options' values, got ${SchemaValidator.describe(fallback)}`);
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
      if (!SchemaValidator.OPTION_FIELDS.includes(field)) {
        this.fail(`${at}: unknown field '${field}' — an option's fields are ${SchemaValidator.OPTION_FIELDS.join(', ')}`);
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
        this.fail(`${at}: 'keywords' must be a non-empty list of words — leave it out when the option has none, got ${SchemaValidator.describe(keywords)}`);
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
        this.fail(`${where}: 'max' must be a whole number of at least 2, got ${SchemaValidator.describe(spec.max)}`);
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
    for (const [field, values] of Object.entries(SchemaValidator.ENUMS)) {
      if (spec[field] !== undefined && !values.includes(spec[field] as string)) {
        this.fail(`${where}: '${field}' must be one of ${values.join(', ')}, got ${SchemaValidator.describe(spec[field])}`);
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
        this.oneOf(anchor, `${where}: 'anchors'`, SchemaValidator.ANCHORS);
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
      rest[name] = ValueSchema.defaultIn(out[name], rest);
    }
    for (const name of order) {
      this.offeredDefaults(name, out, rest, order);
    }
    return out;
  }

  /**
   * Each of a select's or a radio's conditional defaults must be offered
   * where it applies: in every case of its `when` (each value a case lists
   * taken in turn), the other values at their defaults — those with
   * defaults of their own following the case — or an untouched dialog would
   * show one thing and the builder get another.
   */
  private offeredDefaults(name: string, params: Record<string, ParamSpec>, rest: Record<string, unknown>, order: string[]): void {
    const spec = params[name];
    const options = SchemaValidator.optionsOf(spec);
    if (!options.some(option => option.when !== undefined)) {
      return;
    }
    SchemaValidator.defaultsOf(spec).forEach((entry, index) => {
      for (const state of SchemaValidator.statesOf(entry.when, params, rest, order)) {
        const offered = options.filter(option => ValueSchema.holds(option.when, state)).map(option => option.value);
        const values = Array.isArray(entry.value) ? entry.value : [entry.value];
        const missing = values.find(value => !offered.includes(value));
        if (missing !== undefined) {
          const holding = Object.entries(state).filter(([other]) => ValueConditions.namesOf(entry.when).includes(other))
            .map(([other, value]) => `${other} is ${JSON.stringify(value)}`).join(' and ');
          this.fail(`param '${name}': defaults[${index}]: ${JSON.stringify(missing)} is not offered while ${holding} and the other values are at their defaults — an untouched dialog would show one thing and the builder get another`);
        }
      }
    });
  }

  /**
   * The values as they stand in each case a `when` names: the values at
   * rest, those the case names set — one state for each value a case lists
   * — and every value whose own `defaults` follow them worked out again.
   */
  private static statesOf(when: OptionWhen, params: Record<string, ParamSpec>, rest: Record<string, unknown>, order: string[]): Record<string, unknown>[] {
    const states: Record<string, unknown>[] = [];
    for (const each of ValueSchema.casesOf(when)) {
      let combos: Record<string, unknown>[] = [{}];
      for (const [other, expected] of Object.entries(each)) {
        const candidates = Array.isArray(expected) ? expected : [expected];
        combos = combos.flatMap(combo => candidates.map(candidate => ({ ...combo, [other]: candidate })));
      }
      for (const combo of combos) {
        const state: Record<string, unknown> = { ...rest, ...combo };
        for (const other of order) {
          if (!(other in combo) && ValueConditions.hasDefaults(params[other] as { defaults?: [] })) {
            state[other] = ValueSchema.defaultIn(params[other], state);
          }
        }
        states.push(state);
      }
    }
    return states;
  }

  /**
   * Depth first over the values a value's options and its `defaults` name:
   * `order` gets each after those it waits on.
   */
  private settle(name: string, params: Record<string, ParamSpec>, settled: Map<string, boolean>, chain: string[], order: string[]): void {
    if (settled.get(name) === true) {
      return;
    }
    if (settled.get(name) === false) {
      const links = [...chain.slice(chain.indexOf(name)), name];
      const circle = links.join(' → ');
      if (links.some(link => ValueConditions.hasDefaults(params[link] as { defaults?: [] }))) {
        this.fail(`param '${name}': the 'when' of its options and of its 'defaults' comes back round to it (${circle}) — values that wait on each other have no first one to settle`);
      }
      this.fail(`param '${name}': the 'when' of its options comes back round to it (${circle}) — options that wait on each other have no first one to offer`);
    }
    settled.set(name, false);
    const named = new Set([
      ...SchemaValidator.optionsOf(params[name]).flatMap(option => ValueSchema.casesOf(option.when).flatMap(Object.keys)),
      ...ValueConditions.namedByDefaults(params[name] as { defaults?: [] }),
    ]);
    for (const other of named) {
      this.settle(other, params, settled, [...chain, name], order);
    }
    settled.set(name, true);
    order.push(name);
  }

  /** `spec` with a default that is offered at `rest`, or a refusal saying why it has none. */
  private offeredDefault(name: string, spec: ParamSpec, given: boolean, rest: Record<string, unknown>): ParamSpec {
    const options = SchemaValidator.optionsOf(spec);
    if (!options.some(option => option.when !== undefined)) {
      return spec;
    }
    const where = `param '${name}'`;
    const offered = options.filter(option => ValueSchema.holds(option.when, rest)).map(option => option.value);
    const atRest = `while the other values are at their defaults`;
    // One of its `defaults` holding at rest is what an untouched dialog
    // shows there, checked with the rest of them: the plain default is not.
    const shown = ValueConditions.matchingDefault(spec as { defaults?: [] }, rest) === null;
    if (ValueSchema.isChoices(spec)) {
      for (const value of shown ? spec.default ?? [] : []) {
        if (!offered.includes(value)) {
          this.fail(`${where}: the default's ${JSON.stringify(value)} is not offered ${atRest} — an untouched dialog would show one thing and the builder get another`);
        }
      }
      return spec;
    }
    const choice = spec as SelectParamSpec | RadioParamSpec;
    if (given) {
      if (shown && !offered.includes(choice.default as string | number)) {
        this.fail(`${where}: the default ${JSON.stringify(choice.default)} is not offered ${atRest} — an untouched dialog would show one thing and the builder get another`);
      }
      return spec;
    }
    if (choice.optional) {
      return spec;
    }
    if (offered.length === 0) {
      if (!shown) {
        return spec;
      }
      this.fail(`${where}: none of its options is offered ${atRest} — leave the 'when' off one, or make the value 'optional'`);
    }
    return Object.freeze({ ...choice, default: offered[0] }) as ParamSpec;
  }

  /** The options of a select or a radio; none for any other value. */
  private static optionsOf(spec: ParamSpec): readonly ChoiceOption[] {
    return 'type' in spec && (spec.type === 'select' || spec.type === 'radio') ? spec.options : [];
  }

  /** A typed-in value's conditional defaults; none for a picked value or one that declares none. */
  private static defaultsOf(spec: ParamSpec): readonly ConditionalDefault<unknown>[] {
    return 'type' in spec ? (spec.defaults ?? []) as readonly ConditionalDefault<unknown>[] : [];
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
        this.fail(`${at} must be an object of values to match, such as { shape: 'single', height: 40 }, got ${SchemaValidator.describe(each)}`);
      }
      if (Object.keys(each).length === 0) {
        this.fail(`${at} is empty, which would offer the option whatever the other values are — name the values it waits on, or leave 'when' off to always offer it`);
      }
      this.clauses(at, name, each, params, false);
    });
  }

  /**
   * A `visibleWhen`: one object of clauses, or a non-empty list of them of
   * which any one holds, each checked as one is — picked values named too.
   */
  private visibleWhen(where: string, name: string, value: unknown, params: Record<string, ParamSpec>): void {
    if (!Array.isArray(value)) {
      this.clauses(where, name, value, params, true);
      return;
    }
    if (value.length === 0) {
      this.fail(`${where}: the list is empty — list the cases it shows in, such as [{ type: 'wardrobe' }, { type: 'base', doors: true }], or leave 'visibleWhen' off to always show it`);
    }
    value.forEach((each, index) => {
      const at = `${where}[${index}]`;
      if (!FeatureCall.isPlainObject(each)) {
        this.fail(`${at} must be an object of values to match, such as { type: 'base', doors: true }, got ${SchemaValidator.describe(each)}`);
      }
      if (Object.keys(each).length === 0) {
        this.fail(`${at} is empty, which would show it whatever the other values are — name the values it waits on, or leave 'visibleWhen' off to always show it`);
      }
      this.clauses(at, name, each, params, true);
    });
  }

  /**
   * The clauses of one case of a `visibleWhen` or of an option's `when`: each names
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
      if (ValueSchema.isChoices(target)) {
        this.fail(`${where} names '${other}', a select with 'multiple: true' — it can only name a value that holds one thing`);
      }
      const candidates = Array.isArray(expected) ? expected : [expected];
      if (candidates.length === 0) {
        this.fail(`${where}: the values listed for '${other}' are empty`);
      }
      for (const candidate of candidates) {
        if (!SchemaValidator.fits(target, candidate)) {
          this.fail(`${where}: ${JSON.stringify(candidate)} is not a value '${other}' can take`);
        }
      }
    }
  }

  /**
   * A picked value's condition: an object of `picked`, `count`, `surface`
   * and `not`, a `surface` only for a value that takes faces.
   */
  private pickCondition(where: string, name: string, target: PickerParamSpec, value: unknown): void {
    if (!FeatureCall.isPlainObject(value) || Object.keys(value).length === 0) {
      this.fail(`${where} is a picked value: give it a condition such as { picked: true } or { surface: 'cylinder' }, got ${SchemaValidator.describe(value)}`);
    }
    for (const [field, given] of Object.entries(value as Record<string, unknown>)) {
      if (field === 'picked') {
        if (typeof given !== 'boolean') {
          this.fail(`${where}: 'picked' must be true or false, got ${SchemaValidator.describe(given)}`);
        }
      } else if (field === 'count') {
        const counts = Array.isArray(given) ? given : [given];
        if (counts.length === 0) {
          this.fail(`${where}: the counts listed are empty`);
        }
        for (const count of counts) {
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
            this.fail(`${where}: 'count' takes a whole number of picks, 0 or more, or a list of them, got ${SchemaValidator.describe(count)}`);
          }
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
            this.fail(`${where}: 'surface' takes ${PICKED_SURFACES.map(v => `'${v}'`).join(', ')}, got ${SchemaValidator.describe(surface)}`);
          }
        }
      } else if (field === 'not') {
        this.pickCondition(`${where}: 'not'`, name, target, given);
      } else {
        this.fail(`${where}: unknown field '${field}' — a picked value's condition takes 'picked', 'count', 'surface' and 'not'`);
      }
    }
  }

  /** Refuse each field `table` leaves out, by name and why — even one left undefined. */
  protected leftOut(fields: Record<string, unknown>, table: [string, string][], prefix = ''): void {
    for (const [field, why] of table) {
      if (field in fields) {
        this.fail(`${prefix}leave '${field}' out — ${why}`);
      }
    }
  }

  // The checks below name what they check as `subject`: the field, quoted,
  // and where it sits — `'label'`, `param 'face': 'types'`.

  protected text(value: unknown, subject: string, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
      this.fail(`${subject} must be ${allowEmpty ? 'a string' : 'a non-empty string'}, got ${SchemaValidator.describe(value)}`);
    }
    return value;
  }

  /** The image a field names — the feature's icon, an option's picture: an asset of the image kinds. */
  protected image(value: unknown, field: string, where = ''): string {
    return this.assetPath(value, field, SchemaValidator.IMAGE, 'an image (.svg, .png, .jpg or .webp)', where);
  }

  /**
   * An image a field names by a path that may climb out of the module's
   * directory (`../features/icons/gear.png`) but stays relative: no scheme,
   * no leading slash, no backslash, no empty segment. What reads it serves
   * it only from inside the package or the workspace.
   */
  protected relativeImage(value: unknown, field: string, where = ''): string {
    const path = this.text(value, `${where}'${field}'`);
    const segments = path.replace(/^\.\//, '').split('/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.includes('\\') || segments.some(segment => segment === '')) {
      this.fail(`${where}'${field}' must be a relative path from the module, such as './${field}.svg' or '../features/icons/${field}.svg', got '${path}'`);
    }
    if (!SchemaValidator.IMAGE.test(path)) {
      this.fail(`${where}'${field}' must be an image (.svg, .png, .jpg or .webp), got '${path}'`);
    }
    return path;
  }

  /** A path to a file next to the module: relative, inside its directory, of the given kind. */
  protected assetPath(value: unknown, field: string, extension: RegExp, kind: string, where = ''): string {
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

  protected oneOf(value: unknown, subject: string, values: readonly string[]): string {
    if (typeof value !== 'string' || !values.includes(value)) {
      this.fail(`${subject} must be one of ${values.join(', ')}, got ${SchemaValidator.describe(value)}`);
    }
    return value;
  }

  protected list(value: unknown, subject: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0) {
      this.fail(`${subject} must be a non-empty list, got ${SchemaValidator.describe(value)}`);
    }
    return value;
  }

  protected distinct(values: unknown[], subject: string): void {
    const repeated = values.find((value, i) => values.indexOf(value) !== i);
    if (repeated !== undefined) {
      this.fail(`${subject} lists ${JSON.stringify(repeated)} twice`);
    }
  }

  protected fail(message: string): never {
    throw new Error(`${this.where}: ${message}`);
  }

  static owns(object: object, key: string): boolean {
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
      return `a picker of ${SchemaValidator.listed(spec.picker.map(String))}`;
    }
    const name = String('type' in spec ? spec.type : spec.picker);
    return `${SchemaValidator.article(name)} ${name} ${'type' in spec ? 'value' : 'picker'}`;
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

  /** What a refusal says a value is: `'tip'`, `3`, `a list`, `an object`, `nothing`. */
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
    return typeof value === 'function' ? 'a function' : `${SchemaValidator.article(typeof value)} ${typeof value}`;
  }

  /** A deep copy of plain data, frozen. */
  static frozenCopy(value: unknown): unknown {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(entry => SchemaValidator.frozenCopy(entry)));
    }
    if (FeatureCall.isPlainObject(value)) {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SchemaValidator.frozenCopy(entry)])));
    }
    return value;
  }
}

/**
 * One schema of values, checked and resolved: the declarations of
 * `Feature.with({ … })` — what a feature's call is read into, what a
 * generated part's `insert(def, values)` takes by id (`definePart`), and
 * what a generator takes. One class checks and defaults the values for all
 * of them, so a value means the same in a call, an insert and a dialog.
 *
 * The rules:
 * - every declared value is present in the completed values — `undefined`
 *   for one left out with nothing to fill it;
 * - a value left out (or `null`) takes its resolved default
 *   ({@link defaultOf});
 * - each value is checked against its declaration: a number against its
 *   type and range, a select against its options, a text against its
 *   pattern, a pick against its kinds; a required value left out is refused;
 * - a picked list is always a list: one scene object passed for it becomes
 *   a list of one.
 *
 * Refusals lead with a `subject` — `standoff()` for a feature's call,
 * `part 'Gear'` for a generated part's insert — and name the value.
 */
export class ValueSchema {

  /** Each schema, by the resolved declarations it was made from. */
  private static readonly schemas = new WeakMap<object, ValueSchema>();

  private constructor(
    /** The declarations, by name, in declaration order: checked, frozen, each default resolved. */
    readonly params: Readonly<Record<string, ParamSpec>>,
  ) {}

  /**
   * Check `params` — the declarations as an author wrote them — and resolve
   * them into a schema, refusing a bad one with a message that leads with
   * `where` (`feature 'standoff'`) and names the value and the field.
   */
  static declare(params: unknown, where: string): ValueSchema {
    return ValueSchema.of(new SchemaValidator(where).params(params));
  }

  /** The schema of declarations already checked and resolved (a resolved feature metadata's `params`), made once for each. */
  static of(params: Readonly<Record<string, ParamSpec>>): ValueSchema {
    let schema = ValueSchema.schemas.get(params);
    if (!schema) {
      schema = new ValueSchema(params);
      ValueSchema.schemas.set(params, schema);
    }
    return schema;
  }

  /** The values' names, in declaration order. */
  names(): string[] {
    return Object.keys(this.params);
  }

  /** Whether `name` is one of the schema's values. */
  has(name: string): boolean {
    return SchemaValidator.owns(this.params, name);
  }

  /** The declaration of `name`; undefined for a name the schema doesn't declare. */
  spec(name: string): ParamSpec | undefined {
    return this.has(name) ? this.params[name] : undefined;
  }

  /** The picked values' names, in declaration order. */
  pickerNames(): string[] {
    return this.names().filter(name => 'picker' in this.params[name]);
  }

  /** The schema of the typed-in values alone, its picked values left out: what a generated part's insert takes. */
  typedIn(): ValueSchema {
    const pickers = this.pickerNames();
    if (pickers.length === 0) {
      return this;
    }
    return ValueSchema.of(Object.freeze(Object.fromEntries(Object.entries(this.params).filter(([name]) => !pickers.includes(name)))));
  }

  /**
   * Values by name — read off a call, put together by the editor's preview,
   * or passed to an insert by id — completed and checked: every declared
   * value present, defaults filled for values left out or `null`, each
   * value checked against its declaration. The names the read gave are
   * recorded on the result (`GIVEN_VALUES`), for the feature to tell apart
   * from the filled ones. A name the schema doesn't declare is ignored
   * here; {@link refuseUnknown} refuses it where that matters.
   */
  complete(subject: string, read: Readonly<Record<string, unknown>>): FeatureValues {
    const filled = this.filled(read);
    const values: FeatureValues = {};
    for (const [name, spec] of Object.entries(this.params)) {
      const value = filled[name];
      values[name] = 'type' in spec
        ? ValueSchema.scalarValue(subject, name, spec, value)
        : ValueSchema.pickedValue(subject, name, spec, value);
    }
    const given = new Set(Object.keys(read).filter(name => read[name] !== undefined && read[name] !== null && name in this.params));
    Object.defineProperty(values, GIVEN_VALUES, { value: given, enumerable: false });
    return values;
  }

  /**
   * `read` with every value it leaves out (or passes as `null`) filled with
   * its effective default: the values without `defaults` first — what the
   * read gave, else their plain default — then each value with `defaults`
   * from them ({@link defaultIn}). Nothing is checked here; a `when` only
   * names values without `defaults`, so one pass of each settles them all.
   */
  filled(read: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const absent = (name: string) => read[name] === undefined || read[name] === null;
    for (const [name, spec] of Object.entries(this.params)) {
      values[name] = absent(name) && !ValueSchema.hasDefaults(spec) ? ValueSchema.defaultOf(spec) ?? read[name] : read[name];
    }
    for (const [name, spec] of Object.entries(this.params)) {
      if (absent(name) && ValueSchema.hasDefaults(spec)) {
        values[name] = ValueSchema.defaultIn(spec, values) ?? read[name];
      }
    }
    return values;
  }

  /**
   * Refuse a name in `values` the schema doesn't declare, leading with
   * `subject`: the closest declared name is suggested when one is near,
   * else the declared names are listed. `others` explains a name declared
   * elsewhere (a feature's picked value, which a generated part leaves out):
   * it answers why that name is no value here, or null.
   */
  refuseUnknown(subject: string, values: Readonly<Record<string, unknown>>, others?: (name: string) => string | null): void {
    for (const name of Object.keys(values)) {
      if (this.has(name)) {
        continue;
      }
      const why = others?.(name) ?? null;
      if (why !== null) {
        throw new Error(`${subject}: '${name}' ${why}`);
      }
      const suggestion = ValueSchema.closest(name, this.names());
      const known = this.names();
      const listing = known.length === 0 ? 'it takes none' : `its values are ${known.join(', ')}`;
      throw new Error(`${subject}: '${name}' is not one of its values — ${suggestion ? `did you mean '${suggestion}'? ` : ''}${listing}`);
    }
  }

  /**
   * The schema's values as JSON for the editor, by name: each declaration
   * with its resolved default written in and its label filled from its
   * name when it declares none — what a feature's metadata snapshot lists.
   */
  snapshot(): Record<string, ParamSpecSnapshot> {
    const params: Record<string, ParamSpecSnapshot> = {};
    for (const [name, spec] of Object.entries(this.params)) {
      params[name] = ValueSchema.specSnapshot(name, spec);
    }
    return params;
  }

  /** One declaration as JSON for the editor: its resolved default written in, its label filled. */
  static specSnapshot(name: string, spec: ParamSpec): ParamSpecSnapshot {
    const copy = JSON.parse(JSON.stringify(ValueSchema.withDefault(spec))) as ParamSpecSnapshot;
    return { ...copy, label: ValueSchema.labelOf(name, spec) };
  }

  /** Whether a value left out of a call fails it: nothing fills it — no default, not optional. */
  static requires(spec: ParamSpec): boolean {
    if ('picker' in spec) {
      return !spec.optional && !(spec.picker === 'sketch' && spec.implicitDefault);
    }
    return !spec.optional && !ValueSchema.isChoices(spec) && ValueSchema.defaultOf(spec) === undefined;
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
    if (ValueSchema.isChoices(spec)) {
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

  /**
   * The value a call that leaves `spec`'s value out gives the feature when
   * its other values are `values`: the value of the first of its `defaults`
   * whose `when` holds, else its plain default ({@link defaultOf}).
   */
  static defaultIn(spec: ParamSpec, values: Readonly<Record<string, unknown>>): FeatureScalar | readonly (string | number)[] | undefined {
    const fallback = ValueSchema.defaultOf(spec);
    return 'type' in spec ? ValueConditions.defaultIn(spec as { defaults?: readonly ConditionalDefault<typeof fallback>[] }, values, fallback) : fallback;
  }

  /** Whether a value declares conditional defaults: its default then depends on the values they name. */
  static hasDefaults(spec: ParamSpec | undefined): boolean {
    return !!spec && 'type' in spec && ValueConditions.hasDefaults(spec);
  }

  /** `spec` with its resolved default ({@link defaultOf}) written in, when it resolves to one. */
  static withDefault(spec: ParamSpec): ParamSpec {
    const fallback = ValueSchema.defaultOf(spec);
    return fallback === undefined || ('default' in spec && spec.default === fallback)
      ? spec
      : { ...spec, default: fallback } as ParamSpec;
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
    if (spec.pattern !== undefined && !ValueSchema.wholePattern(spec.pattern).test(value)) {
      return `must match ${spec.pattern}, got ${JSON.stringify(value)}`;
    }
    return undefined;
  }

  /**
   * Whether an option's `when` or a `visibleWhen` holds for `values` by
   * name: every clause of one object, or of any one of a list. A value that
   * is not there holds no clause; no clauses always hold.
   */
  static holds(when: OptionWhen | VisibleWhen | undefined, values: Readonly<Record<string, unknown>>): boolean {
    return ValueConditions.holds(when, values);
  }

  /** The cases of an option's `when`: the one object, each of a list, or none. */
  static casesOf(when: OptionWhen | undefined): readonly OptionCase[] {
    return ValueConditions.casesOf(when) as readonly OptionCase[];
  }

  /**
   * Whether a picked value meets its condition, given what it holds: how
   * many picks, and the surface of each (`null` for a pick that is not a
   * face, or not yet told apart).
   */
  static pickHolds(condition: PickCondition, picks: readonly (PickedSurface | null)[]): boolean {
    return ValueConditions.pickHolds(condition, picks);
  }

  /** Whether a value is a select with `multiple: true`: the typed-in value that is a list of option values. */
  static isChoices(spec: ParamSpec | undefined): spec is MultiSelectParamSpec {
    return !!spec && 'type' in spec && spec.type === 'select' && spec.multiple === true;
  }

  /** Whether a value is a list: a picker with `multiple` or a `max`. */
  static isList(spec: ParamSpec | undefined): boolean {
    if (!spec || !('picker' in spec)) {
      return false;
    }
    const list = spec as ListPicker;
    return list.multiple === true || list.max !== undefined;
  }

  /** The kinds a picked value takes: its picker's one kind, or each of a union's. */
  static kindsOf(spec: PickerParamSpec): PickerKind[] {
    return Array.isArray(spec.picker) ? [...spec.picker as readonly PickerKind[]] : [spec.picker as PickerKind];
  }

  /** A value's label: the one it declares, or its name made readable. */
  static labelOf(name: string, spec: ParamSpec): string {
    return spec.label ?? ValueSchema.humanize(name);
  }

  /**
   * One typed-in value checked against its declaration, as {@link complete}
   * checks a read's, leading with `subject`; a picker declaration is refused.
   */
  static checkScalar(subject: string, name: string, spec: ParamSpec, value: unknown): FeatureValues[string] {
    if (!('type' in spec)) {
      throw new Error(`${subject}: '${name}' is a picked value, not a typed-in one`);
    }
    return ValueSchema.scalarValue(subject, name, spec, value);
  }

  /**
   * A multi-select's value, checked: a list (one value alone is not one) of
   * option values, none twice, as many as `min` and `max` allow — a copy, in
   * the order written.
   */
  private static choicesValue(subject: string, name: string, spec: MultiSelectParamSpec, value: unknown): (string | number)[] {
    const offered = spec.options.map(option => JSON.stringify(option.value)).join(', ');
    if (!Array.isArray(value)) {
      throw new Error(`${subject}: '${name}' must be a list of ${offered}, got ${SchemaValidator.describe(value)}`);
    }
    for (const [index, entry] of value.entries()) {
      if (!spec.options.some(option => option.value === entry)) {
        throw new Error(`${subject}: each of '${name}' must be one of ${offered}, got ${SchemaValidator.describe(entry)}`);
      }
      if (value.indexOf(entry) !== index) {
        throw new Error(`${subject}: '${name}' lists ${JSON.stringify(entry)} twice`);
      }
    }
    if (spec.min !== undefined && value.length < spec.min) {
      throw new Error(`${subject}: '${name}' takes at least ${spec.min}, got ${value.length}`);
    }
    if (spec.max !== undefined && value.length > spec.max) {
      throw new Error(`${subject}: '${name}' takes at most ${spec.max}, got ${value.length}`);
    }
    return [...value];
  }

  private static scalarValue(subject: string, name: string, spec: ScalarParamSpec, value: unknown): FeatureValues[string] {
    if (ValueSchema.isChoices(spec)) {
      return ValueSchema.choicesValue(subject, name, spec, value ?? []);
    }
    if (value === undefined || value === null) {
      if (!spec.optional) {
        throw new Error(`${subject}: '${name}' is required`);
      }
      return value as null | undefined;
    }
    const got = SchemaValidator.describe(value);
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`${subject}: '${name}' must be true or false, got ${got}`);
        }
        return value;
      case 'text':
        if (typeof value !== 'string') {
          throw new Error(`${subject}: '${name}' must be a string, got ${got}`);
        }
        {
          const fault = ValueSchema.textFault(spec, value);
          if (fault) {
            throw new Error(`${subject}: '${name}' ${fault}`);
          }
        }
        return value;
      case 'select':
      case 'radio':
        if (!spec.options.some(option => option.value === value)) {
          throw new Error(`${subject}: '${name}' must be one of ${spec.options.map(option => JSON.stringify(option.value)).join(', ')}, got ${got}`);
        }
        return value as string | number;
      default: {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`${subject}: '${name}' must be a number, got ${got}`);
        }
        if (spec.type === 'integer' && !Number.isInteger(value)) {
          throw new Error(`${subject}: '${name}' must be a whole number, got ${value}`);
        }
        if (spec.min !== undefined && value < spec.min) {
          throw new Error(`${subject}: '${name}' must be at least ${spec.min}, got ${value}`);
        }
        if (spec.max !== undefined && value > spec.max) {
          throw new Error(`${subject}: '${name}' must be at most ${spec.max}, got ${value}`);
        }
        return value;
      }
    }
  }

  private static pickedValue(subject: string, name: string, spec: PickerParamSpec, value: unknown): FeatureValues[string] {
    const kinds = ValueSchema.kindsOf(spec);
    const required = !spec.optional && !(spec.picker === 'sketch' && spec.implicitDefault);
    const picked = (entry: unknown, what: string): SceneObject => {
      const datum = ValueSchema.datum(kinds, entry);
      const refusal = ValueSchema.refusal(kinds, spec, datum);
      if (refusal) {
        throw new Error(`${subject}: ${what} must be ${refusal}, got ${ValueSchema.describeValue(entry)}`);
      }
      return datum as SceneObject;
    };
    if (ValueSchema.isList(spec)) {
      const list = (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])
        .map(entry => picked(entry, `each of '${name}'`));
      if (required && list.length === 0) {
        throw new Error(`${subject}: '${name}' is required — pick at least one ${SchemaValidator.listed(kinds)}`);
      }
      const max = (spec as ListPicker).max;
      if (max !== undefined && list.length > max) {
        throw new Error(`${subject}: '${name}' takes at most ${max}, got ${list.length}`);
      }
      return list;
    }
    if (value === undefined || value === null) {
      if (required) {
        throw new Error(`${subject}: '${name}' is required`);
      }
      return value as null | undefined;
    }
    return picked(value, `'${name}'`);
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
      return ValueSchema.takes(kinds, anchors);
    }
    const fits = kinds.some(kind => !ValueSchema.isLocation(kind) || Locations.accepts(kind as LocationKind, value, anchors));
    return fits ? null : ValueSchema.takes(kinds, anchors);
  }

  private static isLocation(kind: PickerKind): boolean {
    return kind === 'connector' || kind === 'point' || kind === 'anchor';
  }

  /** What a value of `kinds` takes, as a refusal names it — an anchor at the points `anchors` lists, when it lists some. */
  private static takes(kinds: PickerKind[], anchors?: readonly string[]): string {
    if (kinds.every(kind => ValueSchema.isLocation(kind))) {
      return SchemaValidator.listed(kinds.map(kind => kind === 'anchor' && anchors && anchors.length > 0
        ? `an anchor at ${SchemaValidator.listed(anchors.map(anchor => `${anchor}()`))} (e.endFaces().center())`
        : ValueSchema.LOCATION_NAMES[kind as LocationKind]));
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
      return `${SchemaValidator.article(kind)} ${kind}`;
    }
    return SchemaValidator.describe(value);
  }

  /**
   * An axis value may name a world axis (`'z'`) or a connector (`bolt`,
   * `bolt.instance(2)` — its Z axis through its origin) and a plane value
   * an origin plane (`'xy'`, `'front'`) — the way every built-in takes them,
   * and what the dialog writes for one picked in the viewport; a resolved
   * `Axis` or `Plane` works too. Each becomes the scene object `axis('z')`,
   * `revolve(bolt, …)` or `plane('xy')` would build, so the feature reads
   * every axis and every plane one way (`Feature.axisOf`, `Feature.planeOf`)
   * and the builder's `addTo()` puts it in the scene ahead of the feature.
   * It serves the feature's statement alone, so the timeline leaves it out,
   * as it does the plane `sketch('xy', …)` makes itself.
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

  /** The closest of `names` to `name` within two edits, or null. */
  private static closest(name: string, names: string[]): string | null {
    let best: string | null = null;
    let bestDistance = 3;
    for (const candidate of names) {
      const distance = ValueSchema.editDistance(name.toLowerCase(), candidate.toLowerCase());
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** The edits (insert, delete, replace) that turn `a` into `b`. */
  private static editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length];
  }

  /** `holeDiameter` → `Hole diameter`. */
  private static humanize(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
}
