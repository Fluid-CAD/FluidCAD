// The generic create path: validate, bind producers, render and land the statement.

import {
  declareParamStatements,
  declareParamStatementsFor,
  ensureSymbolImport,
  findEditableCallAt,
  findEnclosingPart,
  getJavaScriptParser,
  indentOf,
  spliceCode,
  splitLines,
} from '../../code-editor/index.ts';
import { SelectHoist } from '../../select-hoist.ts';
import { enclosingStatement, rowOfIndex } from '../ast/nodes.ts';
import { validChamferOptions } from '../features/chamfer.ts';
import { CONNECTOR_NAME, validConnectorAnchor, validConnectorRotate } from '../features/connector.ts';
import { renderHelixSourceExpr, renderHelixStatement } from '../features/helix.ts';
import { renderLoftConnections } from '../features/loft.ts';
import type { MirrorAxisSpec } from '../features/mirror.ts';
import { renderPlaneBaseExprs, renderPlaneStatement, validPlaneRotationAxes } from '../features/plane.ts';
import { PROJECTION_OPS } from '../features/projection.ts';
import type { RepeatAxisSpec, RepeatPlaneSpec } from '../features/repeat.ts';
import { validTextStatementOptions } from '../features/text.ts';
import { appendTopLevelStatement, declarationsBefore, resolveInsertion } from '../insertion.ts';
import { allocateNames, resolveProducerBindings } from '../producers/bindings.ts';
import {
  isAxisProducer,
  isCopyTargetProducer,
  isFeatureProducer,
  isPlaneProducer,
  isScopeTargetProducer,
  isSketchProducer,
  isWireProducer,
} from '../producers/predicates.ts';
import { importsForRawArgs, MODULE_FOR_IMPORT } from '../render/selectors.ts';
import { buildStatement, statementCallee } from '../render/statement.ts';
import { renderNewVariableDecls } from '../render/variable-decls.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec } from '../spec.ts';
import { validCountValue, validEditExtend, validValueExpr } from '../value-expr.ts';

/**
 * The generic create path: validate the spec's shape for its feature, bind
 * the producers, render the statement and land it at its insertion point.
 * `extras.foreignArgs` are pre-rendered argument expressions appended after
 * the selector parts (the cross-part projection's `<ident>.features.<name>`
 * references, resolved by {@link applyProjectForeign} before it gets here).
 */
export async function applyCreateEdit(
  code: string,
  spec: ApplyFeatureEditSpec,
  extras: { foreignArgs?: string[] } = {},
): Promise<ApplyFeatureEditResult> {
  if (spec.feature === 'extrude') {
    // The profile sketch (implicit consumption or a bound variable) is always
    // producers[0]. A picked-face target carries exactly one selector part —
    // the face, whose own producers follow the profile in the list; a distance
    // or first/last-face extrude carries none beyond its scope targets, which
    // are bound feature producers trailing the list.
    const scope = spec.extrude?.scope ?? [];
    const valid = spec.extrude !== undefined && spec.producers.length >= 1
      && scope.every(p => isScopeTargetProducer(spec, p))
      && (spec.extrude.toFace === 'selector'
        ? spec.parts.length === 1
        : spec.producers.length === 1 + scope.length && spec.parts.length === 0);
    if (!valid) {
      return { newCode: code, error: 'malformed extrude edit spec' };
    }
  } else if (spec.feature === 'rib') {
    // The spine sketch (implicit consumption or a bound variable) is always
    // producers[0]; the scope targets are bound feature producers following
    // it. A rib carries no selector parts.
    const rb = spec.rib;
    const valid = rb !== undefined && spec.producers.length >= 1
      && spec.producers[0].featureType === 'sketch'
      && validValueExpr(rb.thickness, { nonzero: true })
      && (rb.draft === null || validValueExpr(rb.draft, { nonzero: true }))
      && spec.parts.length === 0
      && rb.scope.every(p => isScopeTargetProducer(spec, p));
    if (!valid) {
      return { newCode: code, error: 'malformed rib edit spec' };
    }
  } else if (spec.feature === 'sweep') {
    const sw = spec.sweep;
    const valid = sw !== undefined
      && spec.producers.length > 0
      && validEditExtend(sw.extendStart) && validEditExtend(sw.extendEnd)
      // The path is any wire source (a sketch or a helix); the profile must
      // be a planar sketch; the scope targets are bound feature producers.
      && (sw.path.kind === 'selector'
        ? spec.parts.length >= 1
        : spec.parts.length === 0 && isWireProducer(spec, sw.path.producer))
      && (sw.profile === 'implicit' || isSketchProducer(spec, sw.profile.producer))
      && (sw.scope ?? []).every(p => isScopeTargetProducer(spec, p));
    if (!valid) {
      return { newCode: code, error: 'malformed sweep edit spec' };
    }
  } else if (spec.feature === 'wrap') {
    // The sketch is always a bound producer (wrap never consumes the active
    // sketch implicitly); the single selector part is the target face, whose
    // own producers ride the list alongside the sketch.
    const wr = spec.wrap;
    const valid = wr !== undefined
      && validValueExpr(wr.thickness, { positive: true })
      && spec.parts.length === 1
      && isSketchProducer(spec, wr.sketch?.producer);
    if (!valid) {
      return { newCode: code, error: 'malformed wrap edit spec' };
    }
  } else if (spec.feature === 'revolve') {
    // The profile sketch (implicit consumption or a bound variable) is always
    // producers[0]. A standard axis involves no other producer; an axis
    // statement binds one; a picked edge carries exactly one selector part,
    // whose own producers follow the profile in the list. Scope targets are
    // bound feature producers trailing the list.
    const rev = spec.revolve;
    const scope = rev?.scope ?? [];
    const valid = rev !== undefined && spec.producers.length >= 1
      && spec.producers[0].featureType === 'sketch'
      && validValueExpr(rev.angle, { nonzero: true })
      && scope.every(p => isScopeTargetProducer(spec, p))
      && (rev.axis.kind === 'selector'
        ? spec.parts.length === 1
        : spec.parts.length === 0
          && (rev.axis.kind === 'standard'
            ? spec.producers.length === 1 + scope.length
            : isAxisProducer(spec, rev.axis.producer)));
    if (!valid) {
      return { newCode: code, error: 'malformed revolve edit spec' };
    }
  } else if (spec.feature === 'helix') {
    // A helix consumes no sketch: the source is a standard axis (no producer),
    // an axis statement (one bound producer), or a picked edge/face (exactly
    // one selector part, whose own producers ride the list).
    const hx = spec.helix;
    const valid = hx !== undefined
      && (hx.source.kind === 'edge' || hx.source.kind === 'face'
        ? spec.parts.length === 1
        : spec.parts.length === 0
          && (hx.source.kind === 'standard'
            ? spec.producers.length === 0
            : isAxisProducer(spec, hx.source.producer)));
    if (!valid) {
      return { newCode: code, error: 'malformed helix edit spec' };
    }
    // A standard axis references no existing statement — the helix appends at
    // top level like the pick-less sketch/plane.
    if (spec.producers.length === 0 && spec.parts.length === 0) {
      return appendTopLevelStatement(
        code,
        () => renderHelixStatement(hx, renderHelixSourceExpr(hx.source, spec.parts, () => null)),
        'helix',
        spec.newVariables,
        spec.activePart,
      );
    }
  } else if (spec.feature === 'chamfer') {
    if (!validChamferOptions(spec.chamfer)) {
      return { newCode: code, error: 'malformed chamfer edit spec' };
    }
  } else if (spec.feature === 'loft') {
    const lo = spec.loft;
    const selectorParts = lo?.profiles
      ?.filter((p): p is { kind: 'selector'; part: number } => p?.kind === 'selector')
      .map(p => p.part) ?? [];
    const guides = lo?.guides ?? [];
    const valid = lo !== undefined
      && spec.producers.length > 0
      && Array.isArray(lo.profiles) && lo.profiles.length >= 2
      && lo.profiles.every(p => p?.kind === 'sketch'
        ? isSketchProducer(spec, p.producer)
        : p?.kind === 'selector' && Number.isInteger(p.part) && p.part >= 0 && p.part < spec.parts.length)
      // Every selector part belongs to exactly one profile.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && Array.isArray(guides) && guides.length <= 2
      // A guide is any wire source (a sketch or a helix).
      && guides.every(g => g?.kind === 'sketch' && isWireProducer(spec, g.producer))
      && (lo.scope ?? []).every(p => isScopeTargetProducer(spec, p))
      && [lo.startCondition, lo.endCondition].every(c => c === undefined
        || ((c.type === 'normal' || c.type === 'tangent')
          && validValueExpr(c.magnitude, { nonzero: true })));
    if (!valid) {
      return { newCode: code, error: 'malformed loft edit spec' };
    }
    const connections = renderLoftConnections(lo.connections, lo.profiles.length, i => spec.producers[i]?.bind ? 'producer' : null);
    if ('error' in connections) {
      return { newCode: code, error: connections.error };
    }
    if (guides.length > 0 && lo.thin) {
      return { newCode: code, error: 'loft guides cannot be combined with thin walls' };
    }
  } else if (spec.feature === 'plane') {
    const pl = spec.plane;
    const selectorParts = pl?.bases
      ?.filter((b): b is { kind: 'selector'; part: number } => b?.kind === 'selector')
      .map(b => b.part) ?? [];
    const valid = pl !== undefined
      && Array.isArray(pl.bases)
      && (pl.type === 'mid' ? pl.bases.length === 2
        : (pl.type === 'offset' || pl.type === 'edge') && pl.bases.length === 1)
      && pl.bases.every(b =>
        b?.kind === 'standard' ? (b.plane === 'xy' || b.plane === 'xz' || b.plane === 'yz')
          : b?.kind === 'plane' ? isPlaneProducer(spec, b.producer)
            // A wire base (a helix's edge) belongs to the edge form only.
            : b?.kind === 'wire' ? (pl.type === 'edge' && isWireProducer(spec, b.producer))
              : b?.kind === 'selector' && Number.isInteger(b.part) && b.part >= 0 && b.part < spec.parts.length)
      // Every selector part belongs to exactly one base.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ]
        .every(v => v === null || validValueExpr(v))
      && validPlaneRotationAxes(pl.rotationAxes)
      // The edge form is an edge source (a picked edge or a helix) plus a
      // normalized position — the second argument slot is taken, so no
      // offset/rotation can ride.
      && (pl.type !== 'edge' || (
        (pl.bases[0]?.kind === 'selector' || pl.bases[0]?.kind === 'wire')
        && pl.position !== null && pl.position !== undefined
        && validValueExpr(pl.position)
        && (typeof pl.position !== 'number' || (pl.position >= 0 && pl.position <= 1))
        && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ].every(v => v === null)
        && pl.rotationAxes !== 'world'));
    if (!valid) {
      return { newCode: code, error: 'malformed plane edit spec' };
    }
    // Standard-only bases involve no existing statement — the plane appends
    // at top level like the pick-less sketch.
    if (spec.producers.length === 0 && spec.parts.length === 0) {
      return appendTopLevelStatement(
        code,
        () => renderPlaneStatement(pl, renderPlaneBaseExprs(pl, spec.parts, () => null)),
        'plane',
        spec.newVariables,
        spec.activePart,
      );
    }
  } else if (spec.feature === 'repeat') {
    // Every target is a bound feature producer; each picked axis edge or
    // mirror face references its own selector part, and every part must
    // belong to exactly one such input — the parts' producers ride the list
    // alongside the targets.
    const rp = spec.repeat;
    const targets = rp?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validAxis = (axis: RepeatAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'standard'
          ? axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z'
          : axis.kind === 'axis' && isAxisProducer(spec, axis.producer));
    const validPlane = (plane: RepeatPlaneSpec | undefined): boolean =>
      plane !== undefined && (plane.kind === 'selector'
        ? validPart(plane.part)
        : plane.kind === 'standard'
          ? plane.plane === 'xy' || plane.plane === 'xz' || plane.plane === 'yz'
          : isPlaneProducer(spec, plane.producer));
    const validSweep = rp?.sweep !== undefined
      && (rp.sweep.mode === 'angle' || rp.sweep.mode === 'offset')
      && validValueExpr(rp.sweep.value, { nonzero: true });
    const validDirections = Array.isArray(rp?.directions) && rp!.directions!.length >= 1
      && rp!.directions!.every(d => validAxis(d?.axis)
        && validCountValue(d.count)
        && validValueExpr(d.value, { nonzero: true }));
    const valid = rp !== undefined
      && targets.length >= 1
      && targets.every(t => isFeatureProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && (rp.kind === 'linear'
        ? validDirections && (rp.spacingMode === 'offset' || rp.spacingMode === 'length')
          && rp.axis === undefined && rp.plane === undefined
          && rp.count === undefined && rp.sweep === undefined && rp.angle === undefined
        : rp.kind === 'circular'
          ? validAxis(rp.axis) && rp.plane === undefined && rp.directions === undefined
            && validCountValue(rp.count) && validSweep
            && rp.spacingMode === undefined && rp.angle === undefined
          : rp.kind === 'mirror'
            ? validPlane(rp.plane) && rp.axis === undefined && rp.directions === undefined
              && rp.count === undefined && rp.spacingMode === undefined
              && rp.sweep === undefined && rp.angle === undefined
            : rp.kind === 'rotate'
              && validAxis(rp.axis) && rp.plane === undefined && rp.directions === undefined
              && validValueExpr(rp.angle, { nonzero: true })
              && rp.count === undefined && rp.spacingMode === undefined && rp.sweep === undefined)
      // Every selector part belongs to exactly one axis/plane input.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed repeat edit spec' };
    }
  } else if (spec.feature === 'copy') {
    // Every target is a bound feature producer; each picked axis edge
    // references its own selector part, and every part must belong to
    // exactly one axis — the parts' producers ride the list alongside the
    // targets.
    const cp = spec.copy;
    const targets = cp?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validAxis = (axis: RepeatAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'standard'
          ? axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z'
          : axis.kind === 'local'
            ? axis.axis === 'x' || axis.axis === 'y'
          : axis.kind === 'axis' && isAxisProducer(spec, axis.producer));
    const validSweep = cp?.sweep !== undefined
      && (cp.sweep.mode === 'angle' || cp.sweep.mode === 'offset')
      && validValueExpr(cp.sweep.value, { nonzero: true });
    const validDirections = Array.isArray(cp?.directions) && cp!.directions!.length >= 1
      && cp!.directions!.every(d => validAxis(d?.axis)
        && validCountValue(d.count)
        && validValueExpr(d.value, { nonzero: true }));
    const valid = cp !== undefined
      && targets.length >= 1
      && targets.every(t => isCopyTargetProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && (cp.kind === 'linear'
        ? validDirections && (cp.spacingMode === 'offset' || cp.spacingMode === 'length')
          && cp.axis === undefined && cp.center === undefined
          && cp.count === undefined && cp.sweep === undefined
        : cp.kind === 'circular'
          // The 2D in-sketch form carries a center pair instead of an axis.
          && (cp.center !== undefined
            ? cp.axis === undefined && Array.isArray(cp.center) && cp.center.length === 2
              && cp.center.every(v => validValueExpr(v))
            : validAxis(cp.axis))
          && cp.directions === undefined
          && validCountValue(cp.count) && validSweep
          && cp.spacingMode === undefined && cp.centered === undefined)
      // Every selector part belongs to exactly one axis input.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed copy edit spec' };
    }
  } else if (spec.feature === 'mirror') {
    // Every target is a bound feature producer (solids, like a copy's — or
    // sketch geometry for the 2D form); a picked mirror face or line
    // references its own selector part, and every part must belong to
    // exactly one input — for a mirror that input can only be the plane
    // (3D) or the axis (2D), never both.
    const mo = spec.mirror;
    const targets = mo?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validPlane = (plane: RepeatPlaneSpec | undefined): boolean =>
      plane !== undefined && (plane.kind === 'selector'
        ? validPart(plane.part)
        : plane.kind === 'standard'
          ? plane.plane === 'xy' || plane.plane === 'xz' || plane.plane === 'yz'
          : isPlaneProducer(spec, plane.producer));
    const validAxis = (axis: MirrorAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'local' && (axis.axis === 'x' || axis.axis === 'y'));
    const valid = mo !== undefined
      && targets.length >= 1
      && targets.every(t => isCopyTargetProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && (mo.axis !== undefined
        ? mo.plane === undefined && validAxis(mo.axis) && mo.op === 'add'
        : validPlane(mo.plane) && (mo.op === 'add' || mo.op === 'remove' || mo.op === 'new'))
      // Every selector part belongs to exactly one input (the plane or axis).
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed mirror edit spec' };
    }
  } else if (spec.feature === 'rotate') {
    // Every target is a bound feature producer (solids, like a copy's); a
    // picked axis edge references its own selector part, and every part must
    // belong to exactly one input — for a rotate that input can only be the
    // axis.
    const ro = spec.rotate;
    const targets = ro?.targets ?? [];
    const selectorParts: number[] = [];
    const validPart = (part: number): boolean => {
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return false;
      }
      selectorParts.push(part);
      return true;
    };
    const validAxis = (axis: RepeatAxisSpec | undefined): boolean =>
      axis !== undefined && (axis.kind === 'selector'
        ? validPart(axis.part)
        : axis.kind === 'standard'
          ? axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z'
          : axis.kind === 'axis' && isAxisProducer(spec, axis.producer));
    const valid = ro !== undefined
      && targets.length >= 1
      && targets.every(t => isCopyTargetProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && validAxis(ro.axis)
      && validValueExpr(ro.angle, { nonzero: true })
      && typeof ro.copy === 'boolean'
      // Every selector part belongs to exactly one input (the axis).
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length;
    if (!valid) {
      return { newCode: code, error: 'malformed rotate edit spec' };
    }
  } else if (spec.feature === 'boolean') {
    // Every target is a bound feature producer; booleans render no selector
    // parts at all. A subtract takes exactly a base and a tool; fuse and
    // common take two or more.
    const bo = spec.boolean;
    const targets = bo?.targets ?? [];
    const valid = bo !== undefined
      && (bo.kind === 'fuse' || bo.kind === 'subtract' || bo.kind === 'common')
      && (bo.kind === 'subtract' ? targets.length === 2 : targets.length >= 2)
      && targets.every(t => isFeatureProducer(spec, t.producer))
      && new Set(targets.map(t => t.producer)).size === targets.length
      && spec.parts.length === 0;
    if (!valid) {
      return { newCode: code, error: 'malformed boolean edit spec' };
    }
  } else if (spec.feature === 'sketch' && spec.sketchOnPlane) {
    // The single producer is the plane statement the sketch targets; there is
    // no selector to render.
    const valid = spec.producers.length === 1 && isPlaneProducer(spec, 0) && spec.parts.length === 0;
    if (!valid) {
      return { newCode: code, error: 'malformed sketch-on-plane edit spec' };
    }
  } else if (spec.feature === 'project') {
    // The selector parts are ordinary 3D picks; what the payload adds is the
    // sketch call site whose body receives the statement. A foreign-only
    // projection carries no picks of its own — its arguments are the
    // resolved cross-part references alone.
    const pj = spec.project;
    const foreignOnly = (pj?.foreign?.length ?? 0) > 0
      && spec.producers.length === 0 && spec.parts.length === 0;
    const valid = pj !== undefined
      && Number.isInteger(pj.sketch?.line) && Number.isInteger(pj.sketch?.column)
      && (pj.op === undefined || PROJECTION_OPS.includes(pj.op))
      && ((spec.producers.length > 0 && spec.parts.length > 0) || foreignOnly);
    if (!valid) {
      return { newCode: code, error: 'malformed project edit spec' };
    }
  } else if (spec.feature === 'text') {
    // Text-on-path takes ONE whole path geometry: exactly one bound producer
    // rendered as a bare variable, plus the dialog's full option payload.
    if (spec.producers.length !== 1 || spec.parts.length !== 1
      || !validTextStatementOptions(spec.text)) {
      return { newCode: code, error: 'malformed text edit spec' };
    }
    if (spec.text!.text.trim() === '') {
      return { newCode: code, error: 'the text string is empty' };
    }
  } else if (spec.feature === 'connector') {
    // A named connector: exactly one selector part (the frame derives from a
    // single face/edge), a valid identifier name, and the part() call site
    // whose callback body receives the statement.
    const co = spec.connector;
    const valid = co !== undefined
      && typeof co.name === 'string' && CONNECTOR_NAME.test(co.name)
      && Number.isInteger(co.part?.line) && Number.isInteger(co.part?.column)
      && spec.producers.length >= 1 && spec.parts.length === 1
      && validConnectorAnchor(co.anchor)
      && validConnectorRotate(co.rotate)
      && (co.offset === undefined
        || (Array.isArray(co.offset) && co.offset.length === 3 && co.offset.every(v => Number.isFinite(v))));
    if (!valid) {
      return { newCode: code, error: 'malformed connector edit spec' };
    }
  } else if (spec.feature === 'expose') {
    // A named exposure: exactly one selector part (the source is a single
    // face/edge), a valid identifier name, and the part() call site whose
    // callback body receives the statement.
    const ex = spec.expose;
    const valid = ex !== undefined
      && typeof ex.name === 'string' && CONNECTOR_NAME.test(ex.name)
      && Number.isInteger(ex.part?.line) && Number.isInteger(ex.part?.column)
      && spec.producers.length >= 1 && spec.parts.length === 1;
    if (!valid) {
      return { newCode: code, error: 'malformed expose edit spec' };
    }
  } else if (!spec.producers.length || !spec.parts.length) {
    return { newCode: code, error: 'empty edit spec' };
  }
  if (spec.feature === 'sketch' && spec.parts.length > 1 && !spec.rawArgs?.trim()) {
    return { newCode: code, error: 'sketch takes a single face selection' };
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const resolved = resolveProducerBindings(tree, lines, spec);
  if ('error' in resolved) {
    return { newCode: code, error: resolved.error };
  }
  const bindings = resolved.bindings;
  // A foreign-only projection binds nothing; its insertion is the sketch
  // body, which never reads the scope.
  const scope = bindings.length > 0 ? bindings[0].scope : tree.rootNode;

  allocateNames(tree.rootNode, bindings, spec);

  const insertion = resolveInsertion(spec, bindings, scope, lines, tree);
  if ('error' in insertion) {
    return { newCode: code, error: insertion.error };
  }
  let statementText = buildStatement(spec, bindings, insertion.indent, extras.foreignArgs ?? []);
  let useSemicolon = bindings.some(b => b.statement.text.trimEnd().endsWith(';'));

  type Edit = { index: number; text: string };
  const hoistEdits: Edit[] = [];
  // Selections that would run after the feature they feed (a loft
  // connection's, inside `.connect(…)`) become declarations directly before
  // the statement.
  const selectDecls: string[] = [];
  const usedNames = SelectHoist.usedNames(
    tree, [...bindings.map(b => b.varName), ...(spec.newVariables ?? []).map(v => v?.name)],
  );
  // A projection's global `select(…)` arguments must run OUTSIDE the sketch
  // body — select captures whatever container it executes in, so from inside
  // the sketch callback it resolves against the sketch's own scope and the
  // projection silently drops. Lift each to a declaration before the sketch.
  if (spec.feature === 'project') {
    const sketchCall = findEditableCallAt(tree, lines, spec.project!.sketch.line);
    if (!sketchCall) {
      return {
        newCode: code,
        error: `no sketch() call found at line ${spec.project!.sketch.line} — is the file in sync with the last render?`,
      };
    }
    const sketchStatement = enclosingStatement(sketchCall) ?? sketchCall;
    if (bindings.length === 0) {
      // Nothing bound to read the style off — follow the sketch statement.
      useSemicolon = sketchStatement.text.trimEnd().endsWith(';');
    }
    const hoisted = await SelectHoist.extract(statementText, 'all', usedNames, useSemicolon);
    statementText = hoisted.statement;
    hoistEdits.push(...declarationsBefore(sketchStatement, hoisted.decls, lines));
  } else {
    const hoisted = await SelectHoist.extract(statementText, 'late', usedNames, useSemicolon);
    statementText = hoisted.statement;
    selectDecls.push(...hoisted.decls);
  }

  // Declarations a dialog expression field committed land directly before
  // the statement, at its indent; its `param()` ones at the top of the part
  // body the statement goes into. That part is read off the insertion point
  // now — every edit below lands inside its body, so its own line holds.
  const declsResult = renderNewVariableDecls(code, spec.newVariables, useSemicolon);
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  const block = [...declsResult.decls, ...selectDecls, statementText + (useSemicolon ? ';' : '')]
    .join(`\n${insertion.indent}`);
  const enclosingPart = findEnclosingPart(tree, rowOfIndex(code, insertion.index));
  const partLine = enclosingPart ? enclosingPart.call.startPosition.row + 1 : null;

  const edits: Edit[] = [
    { index: insertion.index, text: insertion.wrap(block) },
    ...hoistEdits,
  ];
  for (const binding of bindings) {
    if (binding.needsBinding) {
      edits.push({ index: binding.call.startIndex, text: `const ${binding.varName} = ` });
    }
  }
  edits.sort((a, b) => b.index - a.index);

  let result = code;
  for (const edit of edits) {
    result = spliceCode(result, edit.index, edit.index, edit.text);
  }

  const landed = await declareParamStatements(result, partLine, declsResult.paramDecls);
  if ('error' in landed) {
    return { newCode: code, error: landed.error };
  }
  result = landed.newCode;
  result = await ensureSymbolImport(result, statementCallee(spec));
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  if (declsResult.paramDecls.length > 0) {
    imports.add('param');
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
  return { newCode: result };
}

/**
 * Land `newVariables` declarations around an already-edited statement:
 * plain `const`s directly before line `sourceLine` at its indent, `param()`
 * declarations at the top of the part body enclosing the statement — after
 * the imports when no part does (import ensured). Splices AFTER the main
 * edit so the spec's source line stays valid throughout; errors return the
 * ORIGINAL code, keeping the transform all-or-nothing.
 */
export async function landNewVariableDecls(
  code: string,
  edited: string,
  sourceLine: number,
  newVariables: ApplyFeatureEditSpec['newVariables'],
): Promise<ApplyFeatureEditResult> {
  if (!newVariables || newVariables.length === 0) {
    return { newCode: edited };
  }
  let working = edited;
  const parser = await getJavaScriptParser();
  const useSemicolon = parser.parse(working).rootNode.namedChildren
    .some(c => c.text.trimEnd().endsWith(';'));
  const declsResult = renderNewVariableDecls(working, newVariables, useSemicolon);
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  if (declsResult.decls.length > 0) {
    const lines = splitLines(working);
    const row = sourceLine - 1;
    if (row < 0 || row >= lines.length) {
      return { newCode: code, error: `no line ${sourceLine} to declare variables before` };
    }
    const indent = indentOf(lines, row);
    let lineStart = 0;
    for (let i = 0; i < row; i++) {
      lineStart += lines[i].length + 1;
    }
    const block = declsResult.decls.map(d => `${indent}${d}\n`).join('');
    working = spliceCode(working, lineStart, lineStart, block);
  }
  if (declsResult.paramDecls.length > 0) {
    // The statement's line still points into its part after the local
    // declarations went in above it; the import comes last so it cannot
    // shift that line first.
    working = await declareParamStatementsFor(working, sourceLine, declsResult.paramDecls);
    working = await ensureSymbolImport(working, 'param');
  }
  return { newCode: working };
}

/**
 * The pick-less sketch statement: no face selector — `sketch('<plane>', ()
 * => {})` on an origin plane (bare `sketch(() => {})` when no plane rides
 * the spec), appended at top level.
 */
export async function applyPlaneSketch(
  code: string,
  plane: 'xy' | 'xz' | 'yz' | undefined,
  activePart?: { line: number; column: number },
): Promise<ApplyFeatureEditResult> {
  const args = plane ? `'${plane}', ` : '';
  return appendTopLevelStatement(
    code, indent => `sketch(${args}() => {\n\n${indent}})`, 'sketch', undefined, activePart,
  );
}
