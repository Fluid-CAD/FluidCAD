import type { MeasureRef } from './fluidcad-server.ts';
import type { ResolveSelectionResult, ResolvedSelectionMatch, SelectionScopeInput } from '../../lib/dist/index.js';

/** A measure entity named by a filter expression instead of an index. */
export type MeasureFilterEntity = {
  expression: string;
  scope?: SelectionScopeInput;
  /** As on an index entity: the live world pose of the matched instance. */
  pose?: MeasureRef['pose'];
};

export type MeasureEntity = MeasureRef | MeasureFilterEntity;

/** What a filter entity resolved to, merged onto the measured entity for the caller. */
export type MeasureEntityProvenance = {
  expression: string;
  sceneObjectId: string;
  sceneObjectName: string;
  part: string | null;
};

export type MeasureEntitiesFailure = {
  ok: false;
  code: 'no-scene' | 'unsupported' | 'unknown-scope' | 'ambiguous-scope' | 'evaluation-error' | 'not-a-selection' | 'no-match' | 'ambiguous-match';
  error: string;
  candidates?: unknown[];
};

export type MeasureEntitiesResolution =
  | { ok: true; refs: MeasureRef[]; provenance: (MeasureEntityProvenance | null)[] }
  | MeasureEntitiesFailure;

type Resolver = (request: { expression: string; scope?: SelectionScopeInput }) => ResolveSelectionResult | { ok: false; code: 'no-scene' | 'unsupported'; reason: string };

/**
 * Turns the entity list a `/measure` caller sends — index refs and filter
 * expressions mixed — into the index refs the kernel measures. A filter used
 * where one entity is required must match exactly one: several matches are
 * refused with the candidates listed (never the first one taken), none is a
 * refusal naming the expression and scope.
 */
export class MeasureEntityResolver {

  static isFilterEntity(entity: unknown): entity is MeasureFilterEntity {
    return typeof entity === 'object' && entity !== null && 'expression' in entity;
  }

  static resolve(entities: MeasureEntity[], resolveSelection: Resolver): MeasureEntitiesResolution {
    const refs: MeasureRef[] = [];
    const provenance: (MeasureEntityProvenance | null)[] = [];
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!MeasureEntityResolver.isFilterEntity(entity)) {
        refs.push(entity);
        provenance.push(null);
        continue;
      }
      const resolved = MeasureEntityResolver.resolveOne(i, entity, resolveSelection);
      if (resolved.ok === false) {
        return resolved;
      }
      refs.push(resolved.ref);
      provenance.push(resolved.provenance);
    }
    return { ok: true, refs, provenance };
  }

  /**
   * The every-match form: each filter entity contributes every face/edge it
   * selects (a highlight wants them all), so only an expression that matches
   * nothing — or fails to resolve — is refused. Index entities pass through.
   */
  static resolveMany(entities: MeasureEntity[], resolveSelection: Resolver, label = 'entities'): { ok: true; refs: MeasureRef[] } | MeasureEntitiesFailure {
    const refs: MeasureRef[] = [];
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!MeasureEntityResolver.isFilterEntity(entity)) {
        refs.push(entity);
        continue;
      }
      const matches = MeasureEntityResolver.matchesFor(`${label}[${i}]`, entity, resolveSelection);
      if (matches.ok === false) {
        return matches;
      }
      for (const match of matches.matches) {
        refs.push(MeasureEntityResolver.refFor(match, entity));
      }
    }
    return { ok: true, refs };
  }

  private static resolveOne(
    index: number,
    entity: MeasureFilterEntity,
    resolveSelection: Resolver,
  ): { ok: true; ref: MeasureRef; provenance: MeasureEntityProvenance } | MeasureEntitiesFailure {
    const label = `entities[${index}]`;
    const matches = MeasureEntityResolver.matchesFor(label, entity, resolveSelection);
    if (matches.ok === false) {
      return matches;
    }
    if (matches.matches.length > 1) {
      return {
        ok: false,
        code: 'ambiguous-match',
        error: `${label}: ${entity.expression} matches ${matches.matches.length} entities ${matches.where}; narrow the filter to one (candidates listed)`,
        candidates: matches.matches,
      };
    }
    const match = matches.matches[0];
    return {
      ok: true,
      ref: MeasureEntityResolver.refFor(match, entity),
      provenance: {
        expression: entity.expression,
        sceneObjectId: match.sceneObjectId,
        sceneObjectName: match.sceneObjectName,
        part: match.part,
      },
    };
  }

  /** Every match of one filter entity; a resolver failure or an empty result is a refusal naming `label`. */
  private static matchesFor(
    label: string,
    entity: MeasureFilterEntity,
    resolveSelection: Resolver,
  ): { ok: true; matches: ResolvedSelectionMatch[]; where: string } | MeasureEntitiesFailure {
    const result = resolveSelection({ expression: entity.expression, scope: entity.scope });
    if (result.ok === false) {
      const candidates = 'candidates' in result ? result.candidates : undefined;
      return { ok: false, code: result.code, error: `${label}: ${result.reason}`, ...(candidates ? { candidates } : {}) };
    }
    const where = MeasureEntityResolver.describeScope(result.scope);
    if (result.count === 0) {
      return { ok: false, code: 'no-match', error: `${label}: ${entity.expression} matches nothing ${where}` };
    }
    return { ok: true, matches: result.matches, where };
  }

  private static refFor(match: ResolvedSelectionMatch, entity: MeasureFilterEntity): MeasureRef {
    const ref: MeasureRef = { shapeId: match.shapeId, kind: match.kind, index: match.index };
    if (match.instanceId !== undefined) {
      ref.instanceId = match.instanceId;
    }
    if (entity.pose !== undefined) {
      ref.pose = entity.pose;
    }
    return ref;
  }

  private static describeScope(scope: Extract<ResolveSelectionResult, { ok: true }>['scope']): string {
    switch (scope.kind) {
      case 'root':
        return 'at root scope';
      case 'part':
        return `in part "${scope.part}"`;
      case 'sceneObject':
        return scope.part ? `in part "${scope.part}" (scene object ${scope.sceneObjectId})` : `at root scope (scene object ${scope.sceneObjectId})`;
      case 'instance':
        return `in instance ${scope.instanceId} of part "${scope.part}"`;
      default:
        return '';
    }
  }
}
