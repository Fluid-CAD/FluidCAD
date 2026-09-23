// Emission targets: sanitizing the entity references a request names and rendering the accessor each one resolves to.

import type { TSNode } from '../code-editor/index.ts';
import { COPY_CALLEES, MIRROR_CALLEES, SOLVED_ENTITY_CALLEES } from '../sketch-symbols.ts';
import type { SolvedEmissionRole, SolvedEmissionTarget } from '../../../lib/dist/selection/sketch-target.js';
import { calleeName, chainBase } from './ast.ts';
import { EmissionRefusal, type SolvedGeometryEmission } from './emission-spec.ts';

/** Reference-producer callees (P6) — hoistable like entity statements. */
const REFERENCE_CALLEES = new Set(['project', 'intersect']);

/** The 2D offset — its edges are addressed by index (`o.edge(i)`) for sketch exports. */
const OFFSET_CALLEES = new Set(['offset']);

const WIRE_ROLES = new Set(['start', 'end', 'center', 'mid']);

const WIRE_DATUMS = new Set(['origin', 'x-axis', 'y-axis']);

// 'copy' and 'mirror' ride the entity domain so a stray pick with no
// instanceIndex/source reaches the transform's honest refusal instead of a
// 400. The anchor-point statements (P8) ride it too — the transform derives
// their accessor (`.anchor()`/`.point(i)`) from the type.
const WIRE_TYPES = new Set(['line', 'arc', 'circle', 'point', 'copy', 'mirror', 'ellipse', 'text', 'bezier']);

const WIRE_REFERENCE_TYPES = new Set(['project', 'intersect']);

const WIRE_COPY_TYPES = new Set(['copy']);

/**
 * Shape-check one wire target of the add-constraint / insert-solved routes
 * and return its cleaned copy, or null when the body is invalid (a 400).
 * Datum targets are the accessor alone; line-addressed targets compose
 * occurrence/role/featureType with ONE of the reference (`refIndex`),
 * copy-instance (`instanceIndex`), anchor (`pointIndex`) or mirror-instance
 * (`source`, sanitized recursively) addressings; `newIndex` targets only
 * where the route allows them (insert-solved). Semantic checks (a copy
 * target without its instance, a mirror without a source) are the
 * transform's — it refuses with a reason the UI can show.
 */
export function sanitizeEmissionTarget(
  t: unknown,
  opts: { allowNew: boolean },
  nested = false,
): SolvedEmissionTarget | null {
  if (typeof t !== 'object' || t === null) {
    return null;
  }
  const w = t as Record<string, unknown>;
  if (w.datum !== undefined) {
    if (nested || typeof w.datum !== 'string' || !WIRE_DATUMS.has(w.datum)
      || w.line !== undefined || w.newIndex !== undefined || w.role !== undefined
      || w.featureType !== undefined || w.occurrence !== undefined
      || w.refIndex !== undefined || w.instanceIndex !== undefined
      || w.pointIndex !== undefined || w.source !== undefined) {
      return null;
    }
    return { datum: w.datum as SolvedEmissionTarget['datum'] };
  }
  const byLine = typeof w.line === 'number';
  const byNew = opts.allowNew && typeof w.newIndex === 'number';
  if (byLine === byNew || (nested && !byLine)) {
    return null;
  }
  const isReference = w.refIndex !== undefined;
  const isCopyInstance = w.instanceIndex !== undefined;
  const isMirrorInstance = w.featureType === 'mirror' || w.source !== undefined;
  if ((w.occurrence !== undefined
      && (!byLine || !Number.isInteger(w.occurrence) || (w.occurrence as number) < 0))
    || (w.role !== undefined && (nested || typeof w.role !== 'string' || !WIRE_ROLES.has(w.role)))
    || ((isReference || isCopyInstance || isMirrorInstance) && !byLine)
    || (isReference && w.refIndex !== null && !Number.isInteger(w.refIndex))
    || (isCopyInstance
      && (!Number.isInteger(w.instanceIndex) || (w.instanceIndex as number) < 0 || isReference))
    || (isMirrorInstance
      && (w.featureType !== 'mirror' || isReference || isCopyInstance || w.pointIndex !== undefined))
    || (w.featureType !== undefined
      && (typeof w.featureType !== 'string'
        || !(isReference ? WIRE_REFERENCE_TYPES
          : isCopyInstance ? WIRE_COPY_TYPES
          : WIRE_TYPES).has(w.featureType)))
    || (w.pointIndex !== undefined
      && (!Number.isInteger(w.pointIndex) || (w.pointIndex as number) < 0))) {
    return null;
  }
  let source: SolvedEmissionTarget | undefined;
  if (w.source !== undefined) {
    const cleaned = sanitizeEmissionTarget(w.source, { allowNew: false }, true);
    if (cleaned === null) {
      return null;
    }
    source = cleaned;
  }
  return {
    ...(byLine ? { line: w.line as number } : { newIndex: w.newIndex as number }),
    ...(byLine && w.occurrence !== undefined ? { occurrence: w.occurrence as number } : {}),
    ...(w.role !== undefined ? { role: w.role as SolvedEmissionRole } : {}),
    ...(w.featureType !== undefined
      ? { featureType: w.featureType as SolvedEmissionTarget['featureType'] } : {}),
    ...(isReference ? { refIndex: w.refIndex as number | null } : {}),
    ...(isCopyInstance ? { instanceIndex: w.instanceIndex as number } : {}),
    ...(w.pointIndex !== undefined ? { pointIndex: w.pointIndex as number } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/** Anchor-point statement callees (P8) and the accessor each renders. */
const ANCHOR_ACCESSORS: Record<string, string> = {
  text: 'anchor', bezier: 'point',
};

/** Datum name → the fluidcad/core accessor command it renders as. */
export const DATUM_COMMANDS: Record<string, string> = {
  origin: 'origin',
  'x-axis': 'xAxis',
  'y-axis': 'yAxis',
};

const VALID_ROLES = new Set<string>(['start', 'end', 'center', 'mid']);

/**
 * Shape validation of one constraint target — the refusal message, or null.
 * Recursive for a mirror instance's `source` (`nested`: the mirrored
 * statement, which must be line-addressed and carries no role).
 */
export function targetError(t: SolvedEmissionTarget, geometry: SolvedGeometryEmission[], nested: boolean): string | null {
    const byLine = typeof t.line === 'number';
    const byNew = typeof t.newIndex === 'number';
    const byDatum = t.datum !== undefined;
    if (Number(byLine) + Number(byNew) + Number(byDatum) !== 1) {
      return ('a constraint target names exactly one of line/newIndex/datum');
    }
    if (byDatum && DATUM_COMMANDS[t.datum!] === undefined) {
      return (`unknown datum '${t.datum}'`);
    }
    if (byDatum && t.role !== undefined) {
      return ('a datum target takes no point role');
    }
    if (byNew && (t.newIndex! < 0 || t.newIndex! >= geometry.length)) {
      return (`constraint target newIndex ${t.newIndex} is out of range`);
    }
    // A same-emission statement is addressed by what it IS: a featureType
    // on a newIndex target must match the geometry entry's kind, and a
    // bezier entry — no solver entity — is only reachable through its
    // control points (`featureType: 'bezier'` + pointIndex).
    if (byNew) {
      const emittedKind = geometry[t.newIndex!].kind;
      if (t.featureType !== undefined && t.featureType !== emittedKind) {
        return (`constraint target newIndex ${t.newIndex} is a ${emittedKind} statement, not ${t.featureType}`);
      }
      if (emittedKind === 'bezier' && t.featureType === undefined) {
        return (`constraint target newIndex ${t.newIndex} is a bezier — address one of its control points (featureType 'bezier' + pointIndex)`);
      }
    }
    if (t.role !== undefined && !VALID_ROLES.has(t.role)) {
      return (`invalid target role '${t.role}'`);
    }
    if (t.occurrence !== undefined) {
      if (!byLine) {
        return ('a target occurrence composes only with a line target');
      }
      if (!Number.isInteger(t.occurrence) || t.occurrence < 0) {
        return (`invalid target occurrence '${t.occurrence}'`);
      }
    }
    // Copy-instance targets: instanceIndex composes with line/role/
    // occurrence only — never datum/newIndex, and v1 never a refIndex
    // (constraining a projected edge OF a duplicate is deferred). A bare
    // featureType 'copy' without an instance is unactionable: the copy()
    // statement itself is no solver entity, only its duplicates are.
    if (t.instanceIndex !== undefined) {
      if (!byLine) {
        return ('a target instanceIndex composes only with a line target');
      }
      if (!Number.isInteger(t.instanceIndex) || t.instanceIndex < 0) {
        return (`invalid target instanceIndex '${t.instanceIndex}'`);
      }
      if (t.refIndex !== undefined) {
        return ('a copy-instance target takes no refIndex');
      }
      if (t.featureType !== undefined && t.featureType !== 'copy') {
        return (`a target instanceIndex requires featureType 'copy'`);
      }
    } else if (t.featureType === 'copy') {
      return (`a copy target needs an instanceIndex — pick a specific instance`);
    }
    // Anchor-point targets (P8): the accessor is derived from the
    // featureType, so a role never composes; bezier targets need the
    // control-point index, text refuses one. A bezier emitted by the same
    // request is addressed by newIndex (its kind was matched above).
    if (t.featureType !== undefined && ANCHOR_ACCESSORS[t.featureType] !== undefined) {
      if (!byLine && !byNew) {
        return (`a ${t.featureType} anchor target names an existing statement line`);
      }
      if (t.role !== undefined) {
        return (`a ${t.featureType} anchor target takes no point role`);
      }
      if (t.refIndex !== undefined || t.instanceIndex !== undefined) {
        return (`a ${t.featureType} anchor target takes no refIndex/instanceIndex`);
      }
      if (t.featureType === 'bezier') {
        if (!Number.isInteger(t.pointIndex) || t.pointIndex! < 0) {
          return ('a bezier anchor target needs a non-negative pointIndex');
        }
      } else if (t.pointIndex !== undefined) {
        return (`a ${t.featureType} anchor target takes no pointIndex`);
      }
    } else if (t.pointIndex !== undefined) {
      return (`a target pointIndex requires featureType 'bezier'`);
    }
  // Mirror-image targets: `featureType: 'mirror'` + a nested `source`
  // (the mirrored statement), composing with line/role/occurrence only.
  if (t.featureType === 'mirror') {
    if (!byLine) {
      return "a mirror instance target names the mirror() statement's line";
    }
    if (t.source === undefined) {
      return 'a mirror instance target needs a source — the mirrored statement';
    }
    if (t.refIndex !== undefined || t.instanceIndex !== undefined || t.pointIndex !== undefined) {
      return 'a mirror instance target takes no refIndex/instanceIndex/pointIndex';
    }
    const sourceError = targetError(t.source, geometry, true);
    if (sourceError !== null) {
      return `mirror instance source: ${sourceError}`;
    }
  } else if (t.source !== undefined) {
    return "a target source requires featureType 'mirror'";
  }
  // Offset edge targets (D9): the edge index composes with line/role/
  // occurrence only. Offset edges are no solver entities — these targets
  // reach the transform through sketch exports, never from a constraint pick.
  if (t.featureType === 'offset') {
    if (!byLine) {
      return "an offset edge target names the offset() statement's line";
    }
    if (!Number.isInteger(t.edgeIndex) || t.edgeIndex! < 0) {
      return 'an offset edge target needs a non-negative edgeIndex';
    }
    if (t.refIndex !== undefined || t.instanceIndex !== undefined || t.pointIndex !== undefined) {
      return 'an offset edge target takes no refIndex/instanceIndex/pointIndex';
    }
    if (t.role === 'mid') {
      return 'an offset edge point is start, end or center';
    }
  } else if (t.edgeIndex !== undefined) {
    return "a target edgeIndex requires featureType 'offset'";
  }
  if (nested) {
    if (!byLine) {
      return 'a mirror source names an existing statement line';
    }
    if (t.role !== undefined) {
      return 'a mirror source is the mirrored statement, not one of its points';
    }
  }
  return null;
}

/** Verify an existing statement against the target captured by the pick. */
export function solvedTargetCallee(entityCall: TSNode, target: SolvedEmissionTarget): string {
  const callee = calleeName(chainBase(entityCall));
  const isReference = target.refIndex !== undefined;
  const isCopyInstance = target.instanceIndex !== undefined;
  const isMirrorInstance = target.featureType === 'mirror';
  const isOffsetEdge = target.featureType === 'offset';
  const isAnchor = target.featureType !== undefined
    && ANCHOR_ACCESSORS[target.featureType] !== undefined;
  const legalCallee = isReference
    ? !!callee && REFERENCE_CALLEES.has(callee)
    : isCopyInstance
      ? !!callee && COPY_CALLEES.has(callee)
      : isMirrorInstance
        ? !!callee && MIRROR_CALLEES.has(callee)
        : isOffsetEdge
          ? !!callee && OFFSET_CALLEES.has(callee)
          : isAnchor
            ? callee === target.featureType
            : !!callee && SOLVED_ENTITY_CALLEES.has(callee);
  if (!legalCallee) {
    throw new EmissionRefusal(isReference
      ? `line ${target.line} is not a project()/intersect() statement`
      : isCopyInstance
        ? `line ${target.line} is not a 2D copy() statement`
        : isMirrorInstance
          ? `line ${target.line} is not a 2D mirror() statement`
          : isOffsetEdge
            ? `line ${target.line} is not a 2D offset() statement`
            : isAnchor
              ? `line ${target.line} is not a ${target.featureType}() statement`
              : `line ${target.line} is not a sketch entity statement`);
  }
  if (target.featureType && callee !== target.featureType) {
    throw new EmissionRefusal(`line ${target.line} is a ${callee}() statement now — the source changed since the picks were made`);
  }
  return callee!;
}
