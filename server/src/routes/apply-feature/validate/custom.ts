// Custom feature requests: the dialog's typed-in values and picks, checked against the feature's metadata.

import {
  validValueExpr,
  type CustomValueSource,
} from '../../../apply-feature-edit/index.ts';
import type { FeatureMetaSnapshot, FeatureOperation, ParamSpecSnapshot } from '../../../../../lib/dist/index.js';
import {
  validateScopeEdits,
  validateScopeLocs,
  validateSketchLoc,
  type EditScopeTargetInput,
  type SketchLoc,
} from '../locations.ts';
import { validateChains, validatePicks, type Pick } from '../picks.ts';

/** One thing a dialog picked for a value: geometry, a statement, a world axis or plane, or an edit's keep. */
export type CustomPickInput =
  /** Faces or edges picked in the viewport (a face, edge, axis or plane picker), with any tangent chains. */
  | { kind: 'entities'; entities: Pick[]; chains: { seed: Pick; members: Pick[] }[] }
  /** A statement picked in the viewport or the timeline: a sketch, an axis or plane statement, a solid, a feature. */
  | { kind: 'statement'; loc: SketchLoc }
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
      const pick = validatePickInput(input, editing);
      if (!pick) {
        return { error: `custom.picks.${name}: each pick is {kind: "entities", entities, chains?}, {kind: "statement", filePath, line, column}, {kind: "standard", name}${editing ? ' or {kind: "verbatim", sourceIndex}' : ''}` };
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
    const entities = raw.entities === undefined || (Array.isArray(raw.entities) && raw.entities.length === 0)
      ? [] : validatePicks(raw.entities);
    const chains = validateChains(raw.chains);
    if (!entities || !chains || entities.length + chains.length === 0) {
      return null;
    }
    return { kind: 'entities', entities, chains };
  }
  if (raw?.kind === 'statement') {
    const loc = validateSketchLoc(raw);
    return loc ? { kind: 'statement', loc } : null;
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
      const refusal = CustomFeatureInputs.pickError(spec, request.picks[name], editing);
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
        return { error: `${spec.label} is required${'picker' in spec ? ` — pick ${CustomFeatureInputs.article(spec.picker)}` : ''}` };
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

  /** The producer a statement pick binds, by picker kind; null when the picker takes no statement. */
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

  private static scalar(spec: ParamSpecSnapshot, raw: unknown): CustomValueSource | string {
    const scalar = spec as ParamSpecSnapshot & { type: string; min?: number; max?: number; options?: { value: string | number }[] };
    switch (scalar.type) {
      case 'boolean':
        return typeof raw === 'boolean' ? { kind: 'literal', value: raw } : `${spec.label} must be true or false`;
      case 'text':
        return typeof raw === 'string' && raw.length <= 2000 ? { kind: 'literal', value: raw } : `${spec.label} must be a string`;
      case 'select': {
        const option = (scalar.options ?? []).find(o => o.value === raw);
        if (!option) {
          return `${spec.label} must be one of ${(scalar.options ?? []).map(o => JSON.stringify(o.value)).join(', ')}`;
        }
        return typeof option.value === 'number' ? { kind: 'value', value: option.value } : { kind: 'literal', value: option.value };
      }
      default: {
        if (!validValueExpr(raw)) {
          return `${spec.label} must be a number or an expression`;
        }
        if (typeof raw === 'number') {
          if (scalar.type === 'integer' && !Number.isInteger(raw)) {
            return `${spec.label} must be a whole number`;
          }
          if (scalar.min !== undefined && raw < scalar.min) {
            return `${spec.label} must be at least ${scalar.min}`;
          }
          if (scalar.max !== undefined && raw > scalar.max) {
            return `${spec.label} must be at most ${scalar.max}`;
          }
        }
        return { kind: 'value', value: raw as number | string };
      }
    }
  }

  /** Whether a create must send the value: nothing stands in for one left out. */
  private static required(spec: ParamSpecSnapshot): boolean {
    if (spec.optional) {
      return false;
    }
    if ('picker' in spec) {
      return !(spec.picker === 'sketch' && (spec as { implicitDefault?: boolean }).implicitDefault);
    }
    return (spec as { default?: unknown }).default === undefined;
  }

  private static pickError(spec: ParamSpecSnapshot & { picker: string }, inputs: CustomPickInput[], editing: boolean): string | null {
    const picker = spec.picker;
    if (picker === 'connector' || picker === 'point' || picker === 'anchor') {
      return `${spec.label}: the ${picker} picker is not supported yet`;
    }
    const list = (spec as { multiple?: boolean }).multiple === true || (spec as { max?: number }).max !== undefined;
    if (!list && inputs.filter(input => input.kind !== 'entities').length + (inputs.some(input => input.kind === 'entities') ? 1 : 0) > 1) {
      return `${spec.label} takes one ${picker}`;
    }
    if (inputs.filter(input => input.kind === 'entities').length > 1) {
      return `${spec.label}: send its picked geometry as one entities pick`;
    }
    if (inputs.length === 0 && !editing && CustomFeatureInputs.required(spec)) {
      return `${spec.label} is required — pick ${CustomFeatureInputs.article(picker)}`;
    }
    for (const input of inputs) {
      if (input.kind === 'entities' && !CustomFeatureInputs.isGeometryPicker(picker)) {
        return `${spec.label}: ${CustomFeatureInputs.article(picker)} is picked as its statement, not as geometry`;
      }
      if (input.kind === 'statement' && !STATEMENT_PICKERS[picker]) {
        return `${spec.label}: ${CustomFeatureInputs.article(picker)} is not a statement to pick`;
      }
      if (input.kind === 'standard' && !(picker === 'axis' ? STANDARD_AXES : picker === 'plane' ? STANDARD_PLANES : new Set()).has(input.name)) {
        return `${spec.label}: '${input.name}' is not ${picker === 'axis' ? 'a world axis' : picker === 'plane' ? 'an origin plane' : `${CustomFeatureInputs.article(picker)}`}`;
      }
    }
    return null;
  }

  private static article(word: string): string {
    return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
  }
}
