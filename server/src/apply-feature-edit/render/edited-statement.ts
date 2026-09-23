// Re-rendering a parsed feature statement with the edits a dialog committed.

import { renderEditedBoolean } from '../features/boolean.ts';
import { renderChamferValueArgs, validChamferOptions } from '../features/chamfer.ts';
import {
  CONNECTOR_NAME,
  renderConnectorAnchorSuffix,
  renderConnectorChain,
  validConnectorAnchor,
  validConnectorRotate,
} from '../features/connector.ts';
import { renderEditedCopy } from '../features/copy.ts';
import { renderExtrudeStatement, renderFaceTargetExpr, type ExtrudeTargetKind } from '../features/extrude.ts';
import { renderHelixSourceExpr, renderHelixStatement } from '../features/helix.ts';
import { renderLoftConnections, renderLoftStatement, resolveLoftSources, validEditCondition } from '../features/loft.ts';
import { renderEditedMirror } from '../features/mirror.ts';
import { renderOffsetStatement } from '../features/offset.ts';
import { renderEditedPlane } from '../features/plane.ts';
import { renderEditedRepeat, type RepeatEditTargetSource } from '../features/repeat.ts';
import { renderRevolveAxisExpr, renderRevolveStatement } from '../features/revolve.ts';
import { renderRibStatement } from '../features/rib.ts';
import { renderEditedRotate } from '../features/rotate.ts';
import { renderShellJoinChain, SHELL_JOIN_KINDS } from '../features/shell.ts';
import { renderSweepStatement } from '../features/sweep.ts';
import { renderTextStatement, textOptionsNeedPath, validTextStatementOptions } from '../features/text.ts';
import { renderWrapStatement } from '../features/wrap.ts';
import type { ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isAxisProducer, isPlaneProducer, isScopeTargetProducer } from '../producers/predicates.ts';
import { editedSelectorArgs, editSourceVar } from './edit-sources.ts';
import { renderSelectorPartExpr } from './selectors.ts';
import { validEditOp, type ApplyFeatureEditSpec, type EditRenderSpec } from '../spec.ts';
import {
  formatValue,
  validEditExtend,
  validEditThin,
  validNonzeroOrNull,
  validValueExpr,
  validValueExprOrNull,
  type RegionKey,
} from '../value-expr.ts';

/**
 * Render the statement `spec`'s dialog options produce over the parsed
 * statement, keeping the expressions the dialog doesn't edit verbatim.
 * Re-sourced slots (a re-picked profile/path/selection) render from
 * `producers`/`parts` through `varFor` — the transform passes its bindings'
 * names, the route's preview passes its namer's, so both emit identical
 * text. Shared with the route's preview so the previewed text is exactly
 * what the transform writes.
 */
/**
 * Resolve an edited statement's replacement `.scope(…)` list into rendered
 * expressions: `verbatim` keeps re-read the statement's own argument texts
 * by position, re-picked solids render their bound producers' variables. An
 * absent list keeps the statement's own texts; an EMPTY list is legal — it
 * drops the chain (whole-scene fusion). Shared by every feature that writes
 * the chain (rib, extrude, sweep, loft, revolve).
 */
/**
 * The `.region(…)` list an edit writes: the dialog's full replacement when
 * it sent one (an empty list drops the chain), else the statement's own
 * picks, kept verbatim.
 */
function editedRegions(edited: RegionKey[] | undefined, parsed: RegionKey[]): RegionKey[] {
  return edited ?? parsed;
}

function resolveEditedScopeExprs(
  spec: EditRenderSpec,
  feature: string,
  scope: RepeatEditTargetSource[] | undefined,
  scopeTexts: string[],
  varFor: (producer: number) => string | null,
): { exprs: string[] } | { error: string } {
  if (scope === undefined) {
    return { exprs: scopeTexts };
  }
  if (!Array.isArray(scope)) {
    return { error: `malformed ${feature} edit spec` };
  }
  const usedVerbatim = new Set<number>();
  const exprs: string[] = [];
  for (const target of scope) {
    if (target?.kind === 'verbatim') {
      if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
        || target.sourceIndex >= scopeTexts.length || usedVerbatim.has(target.sourceIndex)) {
        return { error: `malformed ${feature} edit spec: a kept scope target no longer matches the statement` };
      }
      usedVerbatim.add(target.sourceIndex);
      exprs.push(scopeTexts[target.sourceIndex]);
    } else if (target?.kind === 'feature') {
      if (!isScopeTargetProducer(spec as ApplyFeatureEditSpec, target.producer)) {
        return { error: `malformed ${feature} edit spec: a scope target references a non-feature producer` };
      }
      exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
    } else {
      return { error: `malformed ${feature} edit spec: unknown scope target kind` };
    }
  }
  return { exprs };
}

export function renderEditedStatement(
  parsed: ParsedFeatureStatement,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null = () => null,
): { statement: string } | { error: string } {
  if (spec.feature !== parsed.feature) {
    return {
      error: `the statement is a ${parsed.feature}, not a ${spec.feature} — `
        + 'is the file in sync with the last render?',
    };
  }
  if (parsed.feature === 'extrude') {
    const opts = spec.edit?.extrude;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validNonzeroOrNull(opts.distance2) || !validNonzeroOrNull(opts.draft)
      || !validNonzeroOrNull(opts.endOffset)
      || typeof opts.symmetric !== 'boolean' || typeof opts.drill !== 'boolean') {
      return { error: 'malformed extrude edit spec' };
    }
    let faceExpr: string | null = null;
    let target: ExtrudeTargetKind | undefined;
    if (opts.toFace !== undefined) {
      if (opts.distance !== null || opts.distance2 !== null || opts.symmetric) {
        return { error: 'a to-face extrude takes no distance and cannot be symmetric' };
      }
      if (opts.toFace.kind === 'keep') {
        if (parsed.toFaceText === null) {
          return { error: 'the statement has no to-face target to keep — pick a face' };
        }
        faceExpr = parsed.toFaceText;
        target = parsed.toFaceKind ?? 'selector';
      } else if (opts.toFace.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed extrude edit spec: a re-picked target is exactly one part' };
        }
        const part = spec.parts[0];
        faceExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
        target = 'selector';
      } else if (opts.toFace.kind === 'first-face' || opts.toFace.kind === 'last-face') {
        if (spec.parts.length > 0) {
          return { error: 'malformed extrude edit spec: a first/last-face target takes no selector parts' };
        }
        faceExpr = renderFaceTargetExpr(opts.toFace.kind);
        target = opts.toFace.kind;
      } else {
        return { error: 'malformed extrude edit spec: unknown to-face target' };
      }
    } else {
      if (spec.parts.length > 0) {
        return { error: 'malformed extrude edit spec: selector parts without a to-face target' };
      }
      if (opts.distance === null) {
        if (opts.op !== 'remove') {
          return { error: 'distance may be null (through-all) only for a remove' };
        }
        if (opts.distance2 !== null) {
          return { error: 'a two-distance extrude cannot be through-all' };
        }
      } else if (!validValueExpr(opts.distance, { nonzero: true })) {
        return { error: 'malformed extrude edit spec' };
      }
      if (opts.distance2 !== null && opts.symmetric) {
        return { error: 'a two-distance extrude cannot be symmetric' };
      }
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor, true);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    const scope = resolveEditedScopeExprs(spec, 'extrude', opts.scope, parsed.scopeTexts, varFor);
    if ('error' in scope) {
      return scope;
    }
    const { toFace, scope: _scope, ...rest } = opts;
    return {
      statement: renderExtrudeStatement(
        {
          ...rest, profile: profileText ? 'bound' : 'implicit', toFace: target,
          regions: editedRegions(opts.regions, parsed.regions),
        },
        profileText,
        faceExpr,
        scope.exprs,
      ),
    };
  }
  if (parsed.feature === 'rib') {
    const opts = spec.edit?.rib;
    if (!opts || !validEditOp(opts.op)
      || !validValueExpr(opts.thickness, { nonzero: true })
      || !validNonzeroOrNull(opts.draft)
      || typeof opts.parallel !== 'boolean' || typeof opts.extend !== 'boolean') {
      return { error: 'malformed rib edit spec' };
    }
    if (spec.parts.length > 0) {
      return { error: 'malformed rib edit spec: a rib takes no selector parts' };
    }
    let spineText = parsed.spineText;
    if (opts.spine !== undefined && opts.spine.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.spine.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      spineText = varName;
    }
    const scope = resolveEditedScopeExprs(spec, 'rib', opts.scope, parsed.scopeTexts, varFor);
    if ('error' in scope) {
      return scope;
    }
    return {
      statement: renderRibStatement(opts, spineText, scope.exprs),
    };
  }
  if (parsed.feature === 'sweep') {
    const opts = spec.edit?.sweep;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validEditExtend(opts.extendStart) || !validEditExtend(opts.extendEnd)) {
      return { error: 'malformed sweep edit spec' };
    }
    let pathText = parsed.pathText;
    if (opts.path !== undefined && opts.path.kind !== 'keep') {
      if (opts.path.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed sweep edit spec: a selector path is exactly one part' };
        }
        const part = spec.parts[0];
        pathText = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
      } else {
        const varName = editSourceVar(spec, opts.path.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        pathText = varName;
      }
    } else if (spec.parts.length > 0) {
      return { error: 'malformed sweep edit spec: selector parts without a re-sourced path' };
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    const scope = resolveEditedScopeExprs(spec, 'sweep', opts.scope, parsed.scopeTexts, varFor);
    if ('error' in scope) {
      return scope;
    }
    return {
      statement: renderSweepStatement(
        {
          op: opts.op, thin: opts.thin, extendStart: opts.extendStart, extendEnd: opts.extendEnd,
          regions: editedRegions(opts.regions, parsed.regions),
        },
        pathText, profileText, scope.exprs,
      ),
    };
  }
  if (parsed.feature === 'wrap') {
    const opts = spec.edit?.wrap;
    if (!opts || !validEditOp(opts.op) || !validValueExpr(opts.thickness, { positive: true })) {
      return { error: 'malformed wrap edit spec' };
    }
    let faceText = parsed.faceText;
    if (opts.face !== undefined) {
      if (spec.parts.length !== 1) {
        return { error: 'malformed wrap edit spec: a re-picked face is exactly one part' };
      }
      const part = spec.parts[0];
      faceText = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
    } else if (spec.parts.length > 0) {
      return { error: 'malformed wrap edit spec: selector parts without a re-picked face' };
    }
    let sketchText = parsed.sketchText;
    if (opts.sketch !== undefined && opts.sketch.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.sketch.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      sketchText = varName;
    }
    return {
      statement: renderWrapStatement(
        { op: opts.op, thickness: opts.thickness, regions: editedRegions(opts.regions, parsed.regions) },
        sketchText, faceText,
      ),
    };
  }
  if (parsed.feature === 'revolve') {
    const opts = spec.edit?.revolve;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validValueExpr(opts.angle, { nonzero: true })
      || typeof opts.symmetric !== 'boolean') {
      return { error: 'malformed revolve edit spec' };
    }
    let axisExpr = parsed.axisText;
    if (opts.axis !== undefined) {
      if (opts.axis.kind === 'selector') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed revolve edit spec: a re-picked axis is exactly one part' };
        }
      } else if (opts.axis.kind === 'axis' && !isAxisProducer(spec as ApplyFeatureEditSpec, opts.axis.producer)) {
        return { error: 'malformed revolve edit spec: the axis references a non-axis producer' };
      } else if (opts.axis.kind === 'standard'
        && opts.axis.axis !== 'x' && opts.axis.axis !== 'y' && opts.axis.axis !== 'z') {
        return { error: 'malformed revolve edit spec: bad standard axis' };
      }
      axisExpr = renderRevolveAxisExpr(opts.axis, spec.parts, varFor);
    } else if (spec.parts.length > 0) {
      return { error: 'malformed revolve edit spec: selector parts without a re-sourced axis' };
    }
    let profileText = parsed.profileText;
    if (opts.profile !== undefined && opts.profile.kind !== 'keep') {
      const varName = editSourceVar(spec, opts.profile.producer, varFor);
      if (typeof varName !== 'string') {
        return varName;
      }
      profileText = varName;
    }
    const scope = resolveEditedScopeExprs(spec, 'revolve', opts.scope, parsed.scopeTexts, varFor);
    if ('error' in scope) {
      return scope;
    }
    return {
      statement: renderRevolveStatement(
        {
          op: opts.op, angle: opts.angle, symmetric: opts.symmetric, thin: opts.thin,
          regions: editedRegions(opts.regions, parsed.regions),
        },
        axisExpr, profileText, scope.exprs,
      ),
    };
  }
  if (parsed.feature === 'helix') {
    const opts = spec.edit?.helix;
    if (!opts
      || !validValueExprOrNull(opts.radius, { positive: true })
      || !validValueExprOrNull(opts.endRadius, { positive: true })
      || !validValueExprOrNull(opts.pitch, { nonzero: true })
      || !validValueExprOrNull(opts.turns, { positive: true })
      || !validValueExprOrNull(opts.height, { positive: true })
      || !validValueExprOrNull(opts.startOffset)
      || !validValueExprOrNull(opts.endOffset)) {
      return { error: 'malformed helix edit spec' };
    }
    let sourceExpr = parsed.sourceText;
    if (opts.source !== undefined) {
      if (opts.source.kind === 'edge' || opts.source.kind === 'face') {
        if (spec.parts.length !== 1) {
          return { error: 'malformed helix edit spec: a re-picked source is exactly one part' };
        }
      } else if (opts.source.kind === 'axis'
        && !isAxisProducer(spec as ApplyFeatureEditSpec, opts.source.producer)) {
        return { error: 'malformed helix edit spec: the source references a non-axis producer' };
      } else if (opts.source.kind === 'standard'
        && opts.source.axis !== 'x' && opts.source.axis !== 'y' && opts.source.axis !== 'z') {
        return { error: 'malformed helix edit spec: bad standard axis' };
      }
      sourceExpr = renderHelixSourceExpr(opts.source, spec.parts, varFor);
    } else if (spec.parts.length > 0) {
      return { error: 'malformed helix edit spec: selector parts without a re-sourced source' };
    }
    return { statement: renderHelixStatement(opts, sourceExpr) };
  }
  if (parsed.feature === 'loft') {
    const opts = spec.edit?.loft;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validEditCondition(opts.startCondition) || !validEditCondition(opts.endCondition)) {
      return { error: 'malformed loft edit spec' };
    }
    const sources = resolveLoftSources(parsed, spec, varFor);
    if ('error' in sources) {
      return sources;
    }
    const connections = renderLoftConnections(opts.connections, sources.profileExprs.length, varFor, parsed);
    if ('error' in connections) {
      return connections;
    }
    // The guides⊕thin exclusion holds for the statement being WRITTEN — the
    // edited guide list when one rides the spec, not the stale parsed one.
    if (sources.guideExprs.length > 0 && opts.thin) {
      return { error: 'loft guides cannot be combined with thin walls' };
    }
    const scope = resolveEditedScopeExprs(spec, 'loft', opts.scope, parsed.scopeTexts, varFor);
    if ('error' in scope) {
      return scope;
    }
    return {
      statement: renderLoftStatement(
        { op: opts.op, thin: opts.thin, startCondition: opts.startCondition, endCondition: opts.endCondition },
        sources.profileExprs,
        sources.guideExprs,
        scope.exprs,
        connections.args,
      ),
    };
  }
  if (parsed.feature === 'sketch') {
    const target = spec.edit?.sketch?.target;
    let targetExpr: string;
    if (target?.kind === 'standard') {
      if (target.plane !== 'xy' && target.plane !== 'xz' && target.plane !== 'yz') {
        return { error: 'malformed sketch edit spec: bad standard plane' };
      }
      if (spec.parts.length > 0) {
        return { error: 'malformed sketch edit spec: selector parts on a standard-plane target' };
      }
      targetExpr = `'${target.plane}'`;
    } else if (target?.kind === 'plane') {
      if (!isPlaneProducer(spec as ApplyFeatureEditSpec, target.producer)) {
        return { error: 'malformed sketch edit spec: the target references a non-plane producer' };
      }
      if (spec.parts.length > 0) {
        return { error: 'malformed sketch edit spec: selector parts on a plane-feature target' };
      }
      targetExpr = varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'p';
    } else if (target?.kind === 'selector') {
      // The target argument is ONE SceneObject — a multi-part selection has
      // no single-expression rendering.
      if (spec.parts.length !== 1) {
        return { error: 'malformed sketch edit spec: a re-picked target is exactly one part' };
      }
      const part = spec.parts[0];
      targetExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
    } else {
      return { error: 'malformed sketch edit spec' };
    }
    return {
      statement: `sketch(${targetExpr}, ${parsed.bodyText}${parsed.solvedText ? `, ${parsed.solvedText}` : ''})`,
    };
  }
  if (parsed.feature === 'repeat') {
    return renderEditedRepeat(parsed, spec, varFor);
  }
  if (parsed.feature === 'copy') {
    return renderEditedCopy(parsed, spec, varFor);
  }
  if (parsed.feature === 'mirror') {
    return renderEditedMirror(parsed, spec, varFor);
  }
  if (parsed.feature === 'rotate') {
    return renderEditedRotate(parsed, spec, varFor);
  }
  if (parsed.feature === 'boolean') {
    return renderEditedBoolean(parsed, spec, varFor);
  }
  if (parsed.feature === 'plane') {
    return renderEditedPlane(parsed, spec, varFor);
  }
  if (parsed.feature === 'text') {
    const opts = spec.edit?.text;
    if (!validTextStatementOptions(opts)) {
      return { error: 'malformed text edit spec' };
    }
    if (opts.text.trim() === '') {
      return { error: 'the text string is empty' };
    }
    // The path argument: the statement's own text stands unless the dialog
    // re-picked a geometry (the single folded part, a bare variable) or
    // dropped the path outright.
    const pathField = spec.edit!.text!.path;
    let pathExpr: string | null;
    if (pathField === undefined) {
      pathExpr = parsed.pathText;
    } else if (pathField.kind === 'none') {
      pathExpr = null;
    } else {
      if (spec.parts.length !== 1) {
        return { error: 'a re-picked text path is exactly one geometry' };
      }
      const part = spec.parts[0];
      pathExpr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
    }
    if (pathExpr === null && textOptionsNeedPath(opts)) {
      return { error: 'the distributed alignments, offset, start-at and flip only apply to text following a path' };
    }
    return { statement: renderTextStatement(opts, pathExpr) };
  }
  if (parsed.feature === 'project') {
    // No value slot: the args are the whole statement — the edited expression
    // row, the re-picked selector parts, or the statement's own list — under
    // the statement's own callee.
    return { statement: `${parsed.op}(${editedSelectorArgs(spec, parsed.argsText, varFor)})` };
  }
  if (parsed.feature === 'connector') {
    const opts = spec.edit?.connector;
    if (!opts || typeof opts.name !== 'string' || !CONNECTOR_NAME.test(opts.name)
      || !validConnectorRotate(opts.rotate ?? undefined)
      || !validConnectorAnchor(opts.anchor)
      || (opts.offset !== null
        && !(Array.isArray(opts.offset) && opts.offset.length === 3
          && opts.offset.every(v => Number.isFinite(v))))) {
      return { error: 'malformed connector edit spec' };
    }
    const args = editedSelectorArgs(spec, parsed.argsText, varFor);
    if (!args) {
      return { error: 'the connector needs its source — pick a face or edge' };
    }
    // Only re-picked parts need the anchor appended (they render the bare
    // accessor, exactly like the create path); the expression row and the
    // statement's own text already spell it out.
    const repicked = !spec.rawArgs?.trim() && spec.parts.length > 0;
    const anchor = repicked ? renderConnectorAnchorSuffix(opts.anchor) : '';
    const chain = renderConnectorChain({
      rotate: opts.rotate ?? undefined,
      offset: opts.offset ?? undefined,
    });
    return { statement: `connector('${opts.name}', ${args}${anchor})${chain}` };
  }
  if (!validValueExpr(spec.value, { nonzero: true })) {
    return { error: `the ${parsed.feature} value must be a nonzero number or expression` };
  }
  if (parsed.feature === 'offset') {
    // An edit spec without offset options keeps the statement's own toggle.
    const offset = spec.offset ?? { close: parsed.close };
    if (typeof offset.close !== 'boolean') {
      return { error: 'malformed offset edit spec' };
    }
    return {
      statement: renderOffsetStatement(spec.value, editedSelectorArgs(spec, parsed.argsText, varFor), offset),
    };
  }
  let joinChain = '';
  if (parsed.feature === 'shell') {
    // An edit spec without shell options keeps the statement's own join type.
    const joinType = spec.edit?.shell?.joinType ?? parsed.joinType;
    if (!SHELL_JOIN_KINDS.has(joinType)) {
      return { error: 'malformed shell edit spec' };
    }
    joinChain = renderShellJoinChain(joinType);
  }
  let valueArgs = formatValue(spec.value);
  if (parsed.feature === 'chamfer') {
    // An edit spec without chamfer options keeps the statement's own second
    // value; explicit options replace it (null returns to equal distance).
    const chamfer = spec.edit?.chamfer ?? { distance2: parsed.distance2, isAngle: parsed.isAngle };
    if (!validChamferOptions(chamfer)) {
      return { error: 'malformed chamfer edit spec' };
    }
    valueArgs = renderChamferValueArgs(spec.value, chamfer);
  }
  const args = editedSelectorArgs(spec, parsed.argsText, varFor);
  return {
    statement: args
      ? `${parsed.feature}(${valueArgs}, ${args})${joinChain}`
      : `${parsed.feature}(${valueArgs})${joinChain}`,
  };
}
