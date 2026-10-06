// Custom feature requests: the dialog's typed-in values and picks, checked against the feature's metadata.

import {
  validConnectorAnchor,
  validHolePlacementSlot,
  TypedInKinds,
  type ConnectorAnchorSpec,
  type CustomValueSource,
  type TypedInSpec,
} from '../../../apply-feature-edit/index.ts';
import type { FeatureMetaSnapshot, FeatureOperation, ParamSpecSnapshot } from '../../../../../lib/dist/index.js';
import {
  validateScopeEdits,
  validateScopeLocs,
  validateSketchLoc,
  type EditScopeTargetInput,
  type SketchLoc,
} from '../locations.ts';
import { validatePick, validatePicks, type Pick, type VertexPick } from '../picks.ts';

/**
 * One thing a dialog picked for a value: geometry, a statement, a location,
 * a world axis or plane, or an edit's keep.
 */
export type CustomPickInput =
  /** Faces or edges picked in the viewport (a face, edge, axis or plane picker). */
  | { kind: 'entities'; entities: Pick[] }
  /**
   * A statement picked in the viewport or the timeline: a sketch, an axis or
   * plane statement, a solid, a feature, a connector — `picker` the kind it
   * was picked as, when the value takes several; `slot` a connector copy's
   * (`bolt.instance(2)`), addressed by its seed's statement.
   */
  | { kind: 'statement'; loc: SketchLoc; picker?: string; slot?: number }
  /** A vertex picked in the viewport: a point value's. */
  | { kind: 'point'; entity: VertexPick }
  /** A face or an edge picked in the viewport, and the well-known point taken on it: an anchor value's. */
  | { kind: 'anchor'; entity: Pick; anchor: ConnectorAnchorSpec }
  /** A world axis or an origin plane. */
  | { kind: 'standard'; name: 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' }
  /** An edit's keep: one element of the statement's own value, by position. */
  | { kind: 'verbatim'; sourceIndex: number };

/** A custom feature request's own fields, shaped but not yet checked against the feature. */
export type CustomFeatureRequest = {
  id: string;
  /** The typed-in values, as sent. */
  values: Record<string, unknown>;
  picks: Record<string, CustomPickInput[]>;
  operation?: FeatureOperation;
  /** A create's `.scope(…)` solids. */
  scope: SketchLoc[];
  /** An edit's replacement `.scope(…)` list; undefined keeps the statement's. */
  scopeEdits?: EditScopeTargetInput[];
};

/** How many elements one picked value takes from a request. */
const MAX_PICK_INPUTS = 64;

const STANDARD_AXES = new Set(['x', 'y', 'z']);
const STANDARD_PLANES = new Set(['xy', 'xz', 'yz']);

/** The pickers whose picks are geometry the slot synthesis names. */
const GEOMETRY_PICKERS = new Set(['face', 'edge', 'axis', 'plane']);

/** The pickers a statement fills: what the producer it binds is, and the variable it is bound to when unnamed. */
const STATEMENT_PICKERS: Record<string, { featureType: string; nameHint: string }> = {
  sketch: { featureType: 'sketch', nameHint: 's' },
  axis: { featureType: 'axis', nameHint: 'a' },
  plane: { featureType: 'plane', nameHint: 'p' },
  solid: { featureType: 'feature', nameHint: 'f' },
  feature: { featureType: 'feature', nameHint: 'f' },
  connector: { featureType: 'connector', nameHint: 'c' },
};

/**
 * Shape a custom feature request — `{ id, values, picks, operation, scope }`
 * under the body's `custom` — before the feature's metadata is known.
 * `editing` admits the edit-only forms: kept picks, and the scope list of
 * keeps and re-picks.
 */
export function validateCustomRequest(body: any, editing: boolean): CustomFeatureRequest | { error: string } {
  const raw = body?.custom;
  if (!raw || typeof raw !== 'object') {
    return { error: 'custom must be { id, values, picks, operation?, scope? }' };
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200) {
    return { error: "custom.id must be the feature's id" };
  }
  const values = raw.values ?? {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'custom.values must be an object of values by name' };
  }
  const rawPicks = raw.picks ?? {};
  if (typeof rawPicks !== 'object' || Array.isArray(rawPicks)) {
    return { error: 'custom.picks must be an object of picks by value name' };
  }
  const picks: Record<string, CustomPickInput[]> = {};
  for (const [name, list] of Object.entries(rawPicks as Record<string, unknown>)) {
    const inputs = Array.isArray(list) ? list : [list];
    if (inputs.length > MAX_PICK_INPUTS) {
      return { error: `custom.picks.${name} takes at most ${MAX_PICK_INPUTS} picks` };
    }
    const parsed: CustomPickInput[] = [];
    for (const input of inputs) {
      if (input?.kind === 'entities' && input.chains !== undefined) {
        return { error: `custom.picks.${name}: a custom feature takes no tangent chains — they are for fillet and chamfer only` };
      }
      const pick = validatePickInput(input, editing);
      if (!pick) {
        return { error: `custom.picks.${name}: each pick is {kind: "entities", entities}, {kind: "statement", filePath, line, column, picker?, slot?}, {kind: "point", entity}, {kind: "anchor", entity, anchor}, {kind: "standard", name}${editing ? ' or {kind: "verbatim", sourceIndex}' : ''}` };
      }
      parsed.push(pick);
    }
    picks[name] = parsed;
  }
  if (raw.operation !== undefined && raw.operation !== 'add' && raw.operation !== 'new' && raw.operation !== 'remove') {
    return { error: 'custom.operation must be "add", "new" or "remove"' };
  }
  const request: CustomFeatureRequest = { id: raw.id, values, picks, operation: raw.operation, scope: [] };
  if (editing) {
    const scope = validateScopeEdits(raw);
    if ('error' in scope) {
      return { error: scope.error };
    }
    request.scopeEdits = scope.scope;
    if (raw.operation === 'new' && (scope.scope?.length ?? 0) > 0) {
      return { error: 'a separate body (operation "new") takes no scope — the scope narrows the boolean operation' };
    }
  } else {
    const scope = validateScopeLocs(raw, raw.operation ?? null);
    if ('error' in scope) {
      return { error: scope.error };
    }
    request.scope = scope.scope;
  }
  return request;
}

function validatePickInput(raw: any, editing: boolean): CustomPickInput | null {
  if (raw?.kind === 'entities') {
    const entities = validatePicks(raw.entities);
    return entities ? { kind: 'entities', entities } : null;
  }
  if (raw?.kind === 'statement') {
    const loc = validateSketchLoc(raw);
    if (!loc || (raw.picker !== undefined && (typeof raw.picker !== 'string' || raw.picker.length > 32))) {
      return null;
    }
    if (raw.slot !== undefined && (raw.slot === null || !validHolePlacementSlot(raw.slot))) {
      return null;
    }
    return {
      kind: 'statement', loc,
      ...(raw.picker !== undefined ? { picker: raw.picker } : {}),
      ...(raw.slot !== undefined ? { slot: raw.slot } : {}),
    };
  }
  if (raw?.kind === 'point') {
    const entity = validatePick(raw.entity, 'vertex');
    return entity ? { kind: 'point', entity } : null;
  }
  if (raw?.kind === 'anchor') {
    const entity = validatePick(raw.entity);
    if (!entity || raw.anchor === undefined || !validConnectorAnchor(raw.anchor)) {
      return null;
    }
    return { kind: 'anchor', entity, anchor: raw.anchor as ConnectorAnchorSpec };
  }
  if (raw?.kind === 'standard') {
    return STANDARD_AXES.has(raw.name) || STANDARD_PLANES.has(raw.name) ? { kind: 'standard', name: raw.name } : null;
  }
  if (raw?.kind === 'verbatim' && editing) {
    return Number.isInteger(raw.sourceIndex) && raw.sourceIndex >= 0 ? { kind: 'verbatim', sourceIndex: raw.sourceIndex } : null;
  }
  return null;
}

/**
 * The request checked against the feature it names: each typed-in value
 * fits its declaration, each pick fits its picker, every required value is
 * there. A create leaves a value it doesn't send out of the call (the
 * builder's default applies); an edit keeps the statement's own.
 */
export class CustomFeatureInputs {

  /** Every value's source the transform writes — typed-in ones resolved here, picked ones left to the caller (`picks`). */
  static values(
    meta: FeatureMetaSnapshot,
    request: CustomFeatureRequest,
    editing: boolean,
  ): { values: Record<string, CustomValueSource> } | { error: string } {
    const values: Record<string, CustomValueSource> = {};
    for (const [name, raw] of Object.entries(request.values)) {
      const spec = meta.params[name];
      if (!spec) {
        return { error: `'${name}' is not one of ${meta.label}'s values` };
      }
      if ('picker' in spec) {
        return { error: `${spec.label} is picked — send it under picks, not values` };
      }
      if (raw === null || raw === undefined) {
        continue;
      }
      const source = CustomFeatureInputs.scalar(spec, raw);
      if (typeof source === 'string') {
        return { error: source };
      }
      values[name] = source;
    }
    for (const name of Object.keys(request.picks)) {
      const spec = meta.params[name];
      if (!spec) {
        return { error: `'${name}' is not one of ${meta.label}'s values` };
      }
      if (!('picker' in spec)) {
        return { error: `${spec.label} is typed in — send it under values, not picks` };
      }
      const refusal = CustomFeatureInputs.pickError(spec as ParamSpecSnapshot & { picker: string | string[] }, request.picks[name], editing);
      if (refusal) {
        return { error: refusal };
      }
    }
    for (const [name, spec] of Object.entries(meta.params)) {
      if (name in request.values || name in request.picks) {
        continue;
      }
      if (editing) {
        values[name] = { kind: 'keep' };
      } else if (CustomFeatureInputs.required(spec)) {
        return {
          error: `${spec.label} is required${'picker' in spec
            ? ` — pick ${CustomFeatureInputs.listed(CustomFeatureInputs.kindsOf(spec).map(kind => CustomFeatureInputs.article(kind)))}`
            : ''}`,
        };
      }
    }
    if (request.operation !== undefined && !meta.operations.includes(request.operation)) {
      return {
        error: meta.operations.length === 0
          ? `${meta.label} takes no operation`
          : `${meta.label} offers ${meta.operations.join(', ')} — not ${request.operation}`,
      };
    }
    const scoped = request.scope.length > 0 || (request.scopeEdits?.length ?? 0) > 0;
    if (scoped && meta.operations.length === 0) {
      return { error: `${meta.label} takes no scope` };
    }
    return { values };
  }

  /** The producer a statement pick binds, by the kind it was picked as; null when that kind takes no statement. */
  static statementProducer(picker: string, spec: ParamSpecSnapshot): { featureType: string; nameHint: string } | null {
    const producer = STATEMENT_PICKERS[picker] ?? null;
    if (producer && picker === 'sketch' && (spec as { wire?: boolean }).wire) {
      return { featureType: 'wire', nameHint: 's' };
    }
    return producer;
  }

  /** Whether the picker's picks are geometry the slot synthesis names. */
  static isGeometryPicker(picker: string): boolean {
    return GEOMETRY_PICKERS.has(picker);
  }

  /** The kinds a picked value takes: its picker's one kind, or each of a union's. */
  static kindsOf(spec: ParamSpecSnapshot): string[] {
    const picker = (spec as { picker?: unknown }).picker;
    return Array.isArray(picker) ? picker.map(String) : [String(picker)];
  }

  /**
   * The kind a statement pick is read as: the one the dialog named, else
   * the value's one declared kind that takes statements — null when it
   * names none it takes, or the value takes statements as more than one
   * kind. An axis value takes a connector statement too (its Z axis), which
   * the dialog names as one: a statement it leaves unnamed is the axis.
   */
  static statementKind(spec: ParamSpecSnapshot, input: { picker?: string }): string | null {
    const kinds = CustomFeatureInputs.kindsOf(spec).filter(kind => STATEMENT_PICKERS[kind]);
    if (input.picker !== undefined) {
      const taken = kinds.includes('axis') ? [...kinds, 'connector'] : kinds;
      return taken.includes(input.picker) ? input.picker : null;
    }
    return kinds.length === 1 ? kinds[0] : null;
  }

  /** The kind faces or edges are read as: the value's kind that takes that sub-shape. */
  static geometryKind(spec: ParamSpecSnapshot, sub: 'face' | 'edge'): string | null {
    const kinds = CustomFeatureInputs.kindsOf(spec).filter(kind => GEOMETRY_PICKERS.has(kind));
    if (kinds.length <= 1) {
      return kinds[0] ?? null;
    }
    const takes = (kind: string) => kind === sub || (sub === 'face' ? kind === 'plane' : kind === 'axis')
      || (kind === 'edge' && sub === 'face' && (spec as { facesAsEdges?: boolean }).facesAsEdges === true);
    return kinds.find(takes) ?? null;
  }

  /** A typed-in value's source by its type's entry in the table, or why it doesn't fit; a type without one is refused by name. */
  private static scalar(spec: ParamSpecSnapshot, raw: unknown): CustomValueSource | string {
    const scalar = spec as TypedInSpec;
    const kind = TypedInKinds.of(scalar.type);
    return kind ? kind.source(scalar, raw) : `${spec.label} ${TypedInKinds.unknown(scalar.type)}`;
  }

  /** Whether a create must send the value: nothing stands in for one left out. */
  private static required(spec: ParamSpecSnapshot): boolean {
    if (spec.optional) {
      return false;
    }
    if ('picker' in spec) {
      return !((spec as { picker: unknown }).picker === 'sketch' && (spec as { implicitDefault?: boolean }).implicitDefault);
    }
    return (spec as { default?: unknown }).default === undefined;
  }

  private static pickError(spec: ParamSpecSnapshot & { picker: string | string[] }, inputs: CustomPickInput[], editing: boolean): string | null {
    const kinds = CustomFeatureInputs.kindsOf(spec);
    const what = CustomFeatureInputs.listed(kinds.map(kind => CustomFeatureInputs.article(kind)));
    const list = (spec as { multiple?: boolean }).multiple === true || (spec as { max?: number }).max !== undefined;
    const entities = inputs.filter(input => input.kind === 'entities');
    const elements = inputs.length - entities.length
      + entities.reduce((count, input) => count + input.entities.length, 0);
    if (!list && inputs.length - entities.length + (entities.length > 0 ? 1 : 0) > 1) {
      return `${spec.label} takes one ${kinds.length === 1 ? kinds[0] : 'pick'}`;
    }
    // A value of geometry alone has its picks counted where they are named (the slot synthesis).
    const max = (spec as { max?: number }).max;
    const counted = kinds.length > 1 || !CustomFeatureInputs.isGeometryPicker(kinds[0]);
    if (list && max !== undefined && counted && elements > max) {
      return `${spec.label} takes at most ${max}, got ${elements}`;
    }
    if (entities.length > 1) {
      return `${spec.label}: send its picked geometry as one entities pick`;
    }
    if (inputs.length === 0 && !editing && CustomFeatureInputs.required(spec)) {
      return `${spec.label} is required — pick ${what}`;
    }
    const anchors = (spec as { anchors?: string[] }).anchors;
    for (const input of inputs) {
      switch (input.kind) {
        case 'entities': {
          if (!kinds.some(kind => CustomFeatureInputs.isGeometryPicker(kind))) {
            return kinds.every(kind => STATEMENT_PICKERS[kind])
              ? `${spec.label}: ${what} is picked as its statement, not as geometry`
              : `${spec.label}: ${what} is not picked as faces or edges`;
          }
          const subs = new Set(input.entities.map(pick => pick.sub.type));
          for (const sub of subs) {
            if (CustomFeatureInputs.geometryKind(spec, sub) === null) {
              return `${spec.label}: takes no ${sub}s`;
            }
          }
          break;
        }
        case 'statement':
          if (CustomFeatureInputs.statementKind(spec, input) === null) {
            return input.picker !== undefined
              ? `${spec.label}: takes no ${input.picker} statement — it takes ${what}`
              : `${spec.label}: ${kinds.some(kind => STATEMENT_PICKERS[kind]) ? 'say which kind the statement is picked as (picker)' : `${what} is not a statement to pick`}`;
          }
          if (input.slot !== undefined && CustomFeatureInputs.statementKind(spec, input) !== 'connector') {
            return `${spec.label}: only a connector is picked with a copy's slot`;
          }
          break;
        case 'point':
          if (!kinds.includes('point')) {
            return `${spec.label}: takes no points — it takes ${what}`;
          }
          break;
        case 'anchor':
          if (!kinds.includes('anchor')) {
            return `${spec.label}: takes no anchors — it takes ${what}`;
          }
          if (anchors && anchors.length > 0 && !anchors.includes(input.anchor.kind)) {
            return `${spec.label}: takes anchors at ${anchors.map(anchor => `${anchor}()`).join(', ')} — not ${input.anchor.kind}()`;
          }
          break;
        case 'standard': {
          const axis = kinds.includes('axis') && STANDARD_AXES.has(input.name);
          const plane = kinds.includes('plane') && STANDARD_PLANES.has(input.name);
          if (!axis && !plane) {
            return `${spec.label}: '${input.name}' is not ${kinds.includes('axis') ? 'a world axis' : kinds.includes('plane') ? 'an origin plane' : what}`;
          }
          break;
        }
        default:
          break;
      }
    }
    return null;
  }

  private static article(word: string): string {
    return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
  }

  /** `a, b or c`. */
  private static listed(words: string[]): string {
    return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  }
}
