// A custom feature's ghost: the dialog's values and picks, checked against the feature's metadata.

import type { Response } from 'express';
import type { FeatureMetaSnapshot, ParamSpecSnapshot } from '../../../../lib/dist/index.js';
import { TypedInKinds, type TypedInSpec } from '../../apply-feature-edit/index.ts';
import type { FeatureCatalogEntry } from '../../feature-catalog/catalog.ts';
import type { CustomGhostRequest, FluidCadServer, GhostCustomRef } from '../../fluidcad-server/index.ts';
import { parseEntityRefs } from './refs.ts';
import { ValueScope } from './value-scope.ts';
import type { ValueExpr } from './values.ts';
import { STANDARD_AXES, STANDARD_PLANES } from './vocabulary.ts';

/** The feature catalog as the ghost reads it: every feature the workspace offers. */
export type GhostFeatureCatalog = {
  /** Every feature, error entries included; null while the engine is not up. */
  list(): Promise<FeatureCatalogEntry[] | null>;
};

/** A custom ghost body's own fields, as sent. */
type CustomGhostBody = {
  id?: unknown;
  values?: unknown;
  refs?: unknown;
  operation?: unknown;
  exclude?: { filePath?: unknown; line?: unknown } | null;
  valueScope?: unknown;
};

/** Why the route refuses: the status and the reason it answers with. */
type Refusal = { status: number; reason: string };

/**
 * `POST /feature-ghost` with `feature: 'custom'`: the live preview of a
 * custom feature's dialog. The body names the feature by its catalog id,
 * its typed-in values (numbers or expression text, resolved where the
 * statement sits, like every ghost's) and its picks (one ref per element of
 * a picked value: a statement by call site, viewport faces or edges, a world
 * axis or an origin plane, a connector, a picked vertex, an anchor, or —
 * editing — the statement's own element by position). Each is checked against the feature's metadata
 * before the server loads the feature's builder and the kernel draws it.
 */
export class CustomGhostRoute {
  /** How many refs one picked value may carry. */
  static readonly MAX_REFS = 64;

  /** The pickers a statement fills. */
  private static readonly STATEMENT_PICKERS = new Set(['sketch', 'axis', 'plane', 'solid', 'feature']);

  /** The pickers viewport faces and edges fill. */
  private static readonly GEOMETRY_PICKERS = new Set(['face', 'edge', 'axis', 'plane']);

  /** The anchors a face or an edge offers. */
  private static readonly ANCHORS = new Set(['center', 'start', 'end']);

  static async handle(
    body: CustomGhostBody,
    res: Response,
    fluidCadServer: FluidCadServer,
    catalog: GhostFeatureCatalog | undefined,
  ): Promise<void> {
    const entry = await CustomGhostRoute.entry(body.id, catalog);
    if ('status' in entry) {
      res.status(entry.status).json({ success: false, reason: entry.reason });
      return;
    }
    const meta = entry.meta!;
    if (!meta.ghost) {
      res.status(422).json({ success: false, reason: `${meta.label} draws no preview.` });
      return;
    }
    const valueScope = ValueScope.parse(body.valueScope);
    if (valueScope === 'invalid') {
      res.status(400).json({ success: false, reason: 'Invalid value scope' });
      return;
    }
    const shaped = CustomGhostRoute.shape(body, meta);
    if ('reason' in shaped) {
      res.status(400).json({ success: false, reason: shaped.reason });
      return;
    }

    // A value names variables the way its statement will read them — see ValueScope.
    const scope = await ValueScope.open({
      code: fluidCadServer.getCurrentCode(),
      filePath: fluidCadServer.getCurrentFileName(),
      definitions: fluidCadServer.getParamDefinitions(),
      instances: fluidCadServer.getRenderedInstances(),
      parts: fluidCadServer.getRenderedParts(),
    }, valueScope);
    const values: Record<string, number | string | boolean | (string | number)[]> = { ...shaped.literals };
    for (const [name, expr] of Object.entries(shaped.numbers)) {
      const resolved = scope.resolve(expr);
      if (resolved === null) {
        // An expression this server can't evaluate — the client clears the ghost.
        res.json({ success: false, reason: 'That value is not a number the preview can resolve.' });
        return;
      }
      values[name] = resolved;
    }

    const request: CustomGhostRequest = {
      feature: 'custom',
      modulePath: entry.modulePath,
      exportName: entry.exportName!,
      values,
      refs: shaped.refs,
      operation: shaped.operation,
      ...(shaped.exclude ? { exclude: shaped.exclude } : {}),
    };
    const result = await fluidCadServer.featureGhost(request);
    if (result.solids) {
      res.json({ success: true, solids: result.solids });
      return;
    }
    if (result.paused) {
      // The build ran, slower than a preview may: the dialog's preview times out.
      res.json({ success: false, paused: true, reason: result.reason });
      return;
    }
    res.status(result.status).json({ success: false, reason: result.reason, surface: result.surface });
  }

  /** The catalog entry the body names: one feature, offered — not an error entry, not an id two builders share. */
  private static async entry(id: unknown, catalog: GhostFeatureCatalog | undefined): Promise<FeatureCatalogEntry | Refusal> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      return { status: 400, reason: "id must be the feature's id" };
    }
    if (!catalog) {
      return { status: 422, reason: 'this server has no feature catalog to look custom features up in' };
    }
    const entries = await catalog.list();
    if (entries === null) {
      return { status: 503, reason: 'Engine not initialized yet' };
    }
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry) {
      return { status: 422, reason: `no feature '${id}' in this workspace — is its module still there?` };
    }
    if (entry.error !== undefined || !entry.meta || !entry.exportName) {
      return { status: 422, reason: entry.error ?? `feature '${id}' can't be offered` };
    }
    return entry;
  }

  /**
   * The body checked against the feature: typed-in values by kind (numbers
   * to resolve, literals as they are), picks by picker, the operation, the
   * and the edited statement.
   */
  private static shape(body: CustomGhostBody, meta: FeatureMetaSnapshot): {
    numbers: Record<string, ValueExpr>;
    literals: Record<string, string | boolean | number | (string | number)[]>;
    refs: Record<string, GhostCustomRef[]>;
    operation: CustomGhostRequest['operation'];
    exclude: { filePath: string; line: number } | null;
  } | { reason: string } {
    const rawValues = body.values ?? {};
    if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
      return { reason: 'values must be an object of values by name' };
    }
    const numbers: Record<string, ValueExpr> = {};
    const literals: Record<string, string | boolean | number | (string | number)[]> = {};
    for (const [name, value] of Object.entries(rawValues)) {
      const spec = meta.params[name];
      if (!spec) {
        return { reason: `${meta.label} has no value '${name}'` };
      }
      if (!('type' in spec)) {
        return { reason: `${spec.label} is picked — send it under refs` };
      }
      if (value === null || value === undefined) {
        continue;
      }
      const kind = TypedInKinds.of(spec.type, (spec as TypedInSpec).multiple);
      if (!kind) {
        return { reason: `${spec.label} ${TypedInKinds.unknown(spec.type)}` };
      }
      const refusal = kind.preview(spec as TypedInSpec, value);
      if (refusal) {
        return { reason: refusal };
      }
      if (kind.expression) {
        numbers[name] = value as ValueExpr;
      } else {
        literals[name] = value as string | boolean | number | (string | number)[];
      }
    }

    const rawRefs = body.refs ?? {};
    if (typeof rawRefs !== 'object' || rawRefs === null || Array.isArray(rawRefs)) {
      return { reason: 'refs must be an object of picks by value name' };
    }
    const refs: Record<string, GhostCustomRef[]> = {};
    for (const [name, value] of Object.entries(rawRefs)) {
      const spec = meta.params[name];
      if (!spec) {
        return { reason: `${meta.label} has no value '${name}'` };
      }
      if (!('picker' in spec)) {
        return { reason: `${spec.label} is typed in — send it under values` };
      }
      const parsed = CustomGhostRoute.picks(spec, value);
      if (typeof parsed === 'string') {
        return { reason: parsed };
      }
      refs[name] = parsed;
    }

    const operation = body.operation ?? null;
    if (operation !== null && (typeof operation !== 'string' || !meta.operations.includes(operation as never))) {
      return { reason: `${meta.label} offers no operation ${JSON.stringify(operation)}` };
    }

    let exclude: { filePath: string; line: number } | null = null;
    if (body.exclude !== undefined && body.exclude !== null) {
      if (typeof body.exclude.filePath !== 'string' || typeof body.exclude.line !== 'number') {
        return { reason: 'Invalid exclude reference' };
      }
      exclude = { filePath: body.exclude.filePath, line: body.exclude.line };
    }

    return {
      numbers,
      literals,
      refs,
      operation: operation as CustomGhostRequest['operation'],
      exclude,
    };
  }

  private static article(word: string): string {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
  }

  /** One picked value's refs, checked against its picker's kinds, or why they don't fit. */
  private static picks(spec: ParamSpecSnapshot & { picker: string | readonly string[] }, value: unknown): GhostCustomRef[] | string {
    const kinds = Array.isArray(spec.picker) ? [...spec.picker as readonly string[]] : [spec.picker as string];
    const takes = (kind: string) => kinds.includes(kind);
    const what = kinds.map(kind => `${CustomGhostRoute.article(kind)} ${kind}`).join(' or ');
    if (!Array.isArray(value) || value.length > CustomGhostRoute.MAX_REFS) {
      return `${spec.label}: refs must be a list of picks`;
    }
    const list = (spec as { multiple?: boolean; max?: number }).multiple === true
      || (spec as { max?: number }).max !== undefined;
    if (!list && value.length > 1) {
      return `${spec.label} takes one pick`;
    }
    const refs: GhostCustomRef[] = [];
    for (const raw of value as Record<string, unknown>[]) {
      const ref = CustomGhostRoute.ref(raw, kinds, takes);
      if (!ref) {
        return `${spec.label}: not something ${what} takes`;
      }
      refs.push(ref);
    }
    return refs;
  }

  /** One ref, as one of the value's kinds takes it, or null. */
  private static ref(raw: Record<string, unknown>, kinds: string[], takes: (kind: string) => boolean): GhostCustomRef | null {
    switch (raw?.kind) {
      case 'statement':
        return kinds.some(kind => CustomGhostRoute.STATEMENT_PICKERS.has(kind)) && typeof raw.filePath === 'string' && typeof raw.line === 'number'
          ? { kind: 'statement', filePath: raw.filePath, line: raw.line }
          : null;
      case 'entities': {
        const entities = kinds.some(kind => CustomGhostRoute.GEOMETRY_PICKERS.has(kind)) ? parseEntityRefs(raw.entities) : null;
        return entities && entities.length > 0 && entities.length <= CustomGhostRoute.MAX_REFS ? { kind: 'entities', entities } : null;
      }
      case 'standard':
        return typeof raw.name === 'string'
          && ((takes('axis') && STANDARD_AXES.includes(raw.name)) || (takes('plane') && STANDARD_PLANES.includes(raw.name)))
          ? { kind: 'standard', name: raw.name as 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' }
          : null;
      case 'connector':
        // An axis takes a connector too: its Z axis through its origin.
        if (!(takes('connector') || takes('axis')) || typeof raw.filePath !== 'string' || typeof raw.line !== 'number') {
          return null;
        }
        if (raw.slot !== undefined && !(Number.isSafeInteger(raw.slot) && (raw.slot as number) >= 0)) {
          return null;
        }
        return { kind: 'connector', filePath: raw.filePath, line: raw.line, ...(raw.slot !== undefined ? { slot: raw.slot as number } : {}) };
      case 'point':
        return takes('point') && typeof raw.shapeId === 'string' && Number.isInteger(raw.index) && (raw.index as number) >= 0
          ? { kind: 'point', shapeId: raw.shapeId, index: raw.index as number }
          : null;
      case 'anchor': {
        const [entity] = takes('anchor') ? parseEntityRefs([raw.entity]) ?? [] : [];
        const anchor = raw.anchor as { kind?: unknown; mode?: unknown; value?: unknown } | undefined;
        if (!entity || !anchor) {
          return null;
        }
        if (typeof anchor.kind === 'string' && CustomGhostRoute.ANCHORS.has(anchor.kind)) {
          return { kind: 'anchor', entity, anchor: { kind: anchor.kind as 'center' | 'start' | 'end' } };
        }
        if (anchor.kind === 'offset' && (anchor.mode === 'relative' || anchor.mode === 'absolute') && Number.isFinite(anchor.value)) {
          return { kind: 'anchor', entity, anchor: { kind: 'offset', mode: anchor.mode, value: anchor.value as number } };
        }
        return null;
      }
      case 'kept':
        return Number.isInteger(raw.index) && (raw.index as number) >= 0 ? { kind: 'kept', index: raw.index as number } : null;
      default:
        return null;
    }
  }
}
