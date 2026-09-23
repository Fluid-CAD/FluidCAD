// Rendering a create spec into its feature statement.

import { renderBooleanStatement } from '../features/boolean.ts';
import { renderChamferValueArgs } from '../features/chamfer.ts';
import { renderConnectorAnchorSuffix, renderConnectorChain } from '../features/connector.ts';
import { renderCopyCenterExpr, renderCopyStatement } from '../features/copy.ts';
import { renderExtrudeStatement, renderFaceTargetExpr } from '../features/extrude.ts';
import { renderHelixSourceExpr, renderHelixStatement } from '../features/helix.ts';
import { renderLoftConnections, renderLoftStatement } from '../features/loft.ts';
import { renderMirrorAxisExpr, renderMirrorStatement } from '../features/mirror.ts';
import { renderOffsetStatement } from '../features/offset.ts';
import { renderPlaneBaseExprs, renderPlaneStatement } from '../features/plane.ts';
import { projectionCallee } from '../features/projection.ts';
import { renderRepeatAxisExpr, renderRepeatPlaneExpr, renderRepeatStatement } from '../features/repeat.ts';
import { renderRevolveAxisExpr, renderRevolveStatement } from '../features/revolve.ts';
import { renderRibStatement } from '../features/rib.ts';
import { renderRotateStatement } from '../features/rotate.ts';
import { renderShellJoinChain } from '../features/shell.ts';
import { renderSweepStatement } from '../features/sweep.ts';
import { renderTextStatement } from '../features/text.ts';
import { renderWrapStatement } from '../features/wrap.ts';
import type { ProducerBinding } from '../producers/bindings.ts';
import { renderSelectorArgs, renderSelectorPartExpr } from './selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { formatValue } from '../value-expr.ts';

/** The function the rendered statement calls — extrude's remove op is `cut()`. */
export function statementCallee(spec: ApplyFeatureEditSpec): string {
  if (spec.feature === 'extrude') {
    return spec.extrude!.op === 'remove' ? 'cut' : 'extrude';
  }
  if (spec.feature === 'boolean') {
    return spec.boolean!.kind;
  }
  if (spec.feature === 'project') {
    return projectionCallee(spec);
  }
  return spec.feature;
}

/**
 * Render the feature statement. Most features are
 * `<feature>(<value>, <selectors>)`; `sketch` instead wraps the selector with
 * an empty callback body — a blank line for the user's first sketch entity,
 * with the closing brace at the statement's own indent; `extrude` renders
 * from its options — `extrude(25)` / `cut()` (through-all) / a bound profile
 * variable as the trailing argument — plus `.thin(…)` and `.new()` chains.
 */
export function buildStatement(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  indent: string,
  foreignArgs: string[] = [],
): string {
  /** The bound variable names of a create spec's `.scope(…)` producers. */
  const scopeVarNames = (scope: number[] | undefined): string[] =>
    (scope ?? []).map(p => bindings[p].varName!);
  if (spec.feature === 'extrude') {
    const target = spec.extrude!.toFace;
    let faceExpr: string | null = null;
    if (target === 'selector') {
      const part = spec.parts[0];
      faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName, i => bindings[i].varName);
    } else if (target !== undefined) {
      faceExpr = renderFaceTargetExpr(target);
    }
    return renderExtrudeStatement(spec.extrude!, bindings[0].varName, faceExpr, scopeVarNames(spec.extrude!.scope));
  }
  if (spec.feature === 'rib') {
    const rb = spec.rib!;
    const spineVar = rb.spine === 'bound' ? bindings[0].varName : null;
    return renderRibStatement(rb, spineVar, scopeVarNames(rb.scope));
  }
  if (spec.feature === 'sweep') {
    const sw = spec.sweep!;
    const pathExpr = sw.path.kind === 'sketch'
      ? bindings[sw.path.producer].varName!
      : renderSelectorArgs(spec, bindings);
    const profileVar = sw.profile === 'implicit' ? null : bindings[sw.profile.producer].varName!;
    return renderSweepStatement(sw, pathExpr, profileVar, scopeVarNames(sw.scope));
  }
  if (spec.feature === 'wrap') {
    const wr = spec.wrap!;
    const part = spec.parts[0];
    const faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName, i => bindings[i].varName);
    return renderWrapStatement(wr, bindings[wr.sketch.producer].varName ?? 's', faceExpr);
  }
  if (spec.feature === 'revolve') {
    const rev = spec.revolve!;
    const axisExpr = renderRevolveAxisExpr(rev.axis, spec.parts, i => bindings[i].varName);
    return renderRevolveStatement(
      rev, axisExpr, rev.profile === 'bound' ? bindings[0].varName : null, scopeVarNames(rev.scope),
    );
  }
  if (spec.feature === 'helix') {
    const hx = spec.helix!;
    const sourceExpr = renderHelixSourceExpr(hx.source, spec.parts, i => bindings[i].varName);
    return renderHelixStatement(hx, sourceExpr);
  }
  if (spec.feature === 'repeat') {
    const rp = spec.repeat!;
    const varFor = (i: number): string | null => bindings[i].varName;
    const inputExprs = rp.kind === 'mirror'
      ? [renderRepeatPlaneExpr(rp.plane!, spec.parts, varFor)]
      : rp.kind === 'linear'
        ? rp.directions!.map(d => renderRepeatAxisExpr(d.axis, spec.parts, varFor))
        : [renderRepeatAxisExpr(rp.axis!, spec.parts, varFor)];
    return renderRepeatStatement(rp, inputExprs, rp.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'copy') {
    const cp = spec.copy!;
    const varFor = (i: number): string | null => bindings[i].varName;
    const inputExprs = cp.kind === 'linear'
      ? cp.directions!.map(d => renderRepeatAxisExpr(d.axis, spec.parts, varFor))
      : [cp.center ? renderCopyCenterExpr(cp.center) : renderRepeatAxisExpr(cp.axis!, spec.parts, varFor)];
    return renderCopyStatement(cp, inputExprs, cp.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'mirror') {
    const mo = spec.mirror!;
    const varFor = (i: number): string | null => bindings[i].varName;
    const inputExpr = mo.axis
      ? renderMirrorAxisExpr(mo.axis, spec.parts, varFor)
      : renderRepeatPlaneExpr(mo.plane!, spec.parts, varFor);
    return renderMirrorStatement(mo, inputExpr, mo.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'rotate') {
    const ro = spec.rotate!;
    const axisExpr = renderRepeatAxisExpr(ro.axis, spec.parts, i => bindings[i].varName);
    return renderRotateStatement(ro, axisExpr, ro.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'boolean') {
    const bo = spec.boolean!;
    return renderBooleanStatement(bo.kind, bo.targets.map(t => bindings[t.producer].varName!));
  }
  if (spec.feature === 'loft') {
    const lo = spec.loft!;
    const profileExprs = lo.profiles.map(profile => {
      if (profile.kind === 'sketch') {
        return bindings[profile.producer].varName!;
      }
      const part = spec.parts[profile.part];
      return renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName, i => bindings[i].varName);
    });
    const guideExprs = (lo.guides ?? []).map(guide => bindings[guide.producer].varName!);
    const connections = renderLoftConnections(lo.connections, profileExprs.length, i => bindings[i]?.varName ?? null);
    if ('error' in connections) {
      throw new Error(connections.error);
    }
    return renderLoftStatement(lo, profileExprs, guideExprs, scopeVarNames(lo.scope), connections.args);
  }
  if (spec.feature === 'plane') {
    const pl = spec.plane!;
    return renderPlaneStatement(
      pl, renderPlaneBaseExprs(pl, spec.parts, i => bindings[i].varName),
    );
  }
  if (spec.feature === 'sketch' && spec.sketchOnPlane) {
    return `sketch(${bindings[0].varName}, () => {\n\n${indent}})`;
  }
  const args = renderSelectorArgs(spec, bindings, foreignArgs);
  if (spec.feature === 'sketch') {
    return `sketch(${args}, () => {\n\n${indent}})`;
  }
  if (spec.feature === 'connector') {
    // The name is a validated identifier, so the quoting is safe. A raw
    // override already carries the anchor suffix (the UI edits the suffixed
    // expression); the rendered-parts path appends it here.
    const co = spec.connector!;
    const anchor = spec.rawArgs?.trim() ? '' : renderConnectorAnchorSuffix(co.anchor);
    return `connector('${co.name}', ${args}${anchor})${renderConnectorChain(co)}`;
  }
  if (spec.feature === 'expose') {
    // The name is a validated identifier, so the quoting is safe.
    return `expose('${spec.expose!.name}', ${args})`;
  }
  if (spec.feature === 'chamfer') {
    return `chamfer(${renderChamferValueArgs(spec.value, spec.chamfer)}, ${args})`;
  }
  // Project carries no numeric parameter — the args ARE the statement
  // (`project(e.face('top')`), and `intersect(…)` is the same statement
  // under its sibling callee.
  if (spec.feature === 'project') {
    return `${projectionCallee(spec)}(${args})`;
  }
  if (spec.feature === 'offset') {
    return renderOffsetStatement(spec.value, args, spec.offset);
  }
  if (spec.feature === 'text') {
    return renderTextStatement(spec.text!, args);
  }
  const joinChain = spec.feature === 'shell' ? renderShellJoinChain(spec.shell?.joinType) : '';
  return `${spec.feature}(${formatValue(spec.value)}, ${args})${joinChain}`;
}
