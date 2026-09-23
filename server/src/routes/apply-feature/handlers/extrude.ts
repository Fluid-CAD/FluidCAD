// POST /apply-feature, the extrude create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderExtrudeStatement,
  renderFaceTargetExpr,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type ExtrudeEditOptions,
  type ExtrudeTargetKind,
} from '../../../apply-feature-edit/index.ts';
import { scopeCrossFileError } from '../locations.ts';
import { allocateProducerVars, mergeScopeProducers } from '../synthesis.ts';
import { validateExtrude } from '../validate/extrude.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Extrude's profile is a sketch statement, never a pick selection — the
// transform re-verifies that the line holds a sketch() call. The optional
// up-to-face target replaces the distance(s) as the call's first
// argument: a picked face synthesizes a face selector, while
// 'first-face'/'last-face' render as that literal — no pick involved,
// the kernel resolves the face at build time.
export async function handleExtrude(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateExtrude(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  const crossFile = scopeCrossFileError(request.scope, request.profile.filePath);
  if (crossFile) {
    res.status(422).json({ success: false, reason: crossFile });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    // The profile stays producers[0] in both modes — the transform's
    // extrude contract; the face selector's producers follow it. An
    // offset profile binds under its own callee guard and hint.
    const profileType = request.profile.feature;
    const profileHint = profileType === 'offset' ? 'o' : 's';
    const producers: ApplyFeatureEditSpec['producers'] = [{
      line: request.profile.line,
      column: request.profile.column,
      featureType: profileType,
      nameHint: profileHint,
      bind: request.profile.mode === 'bound',
    }];
    let parts: ApplyFeatureEditSpec['parts'] = [];
    let imports: string[] = [];
    let faceArgs: string | null = null;
    let toFace: ExtrudeTargetKind | undefined;

    if (request.toFace === 'first-face' || request.toFace === 'last-face') {
      toFace = request.toFace;
      faceArgs = renderFaceTargetExpr(request.toFace);
    } else if (request.toFace) {
      const synthOptions = code
        ? {
          namer: await makeProducerNamer(code),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [request.toFace], 'extrude', undefined, [], synthOptions,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // The target argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'the extrude target must be a single face selection' });
        return;
      }
      if (synthesis.spec.filePath !== request.profile.filePath) {
        res.status(422).json({ success: false, reason: 'the target face and the profile sketch come from different files' });
        return;
      }
      parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
        ...part,
        producer: part.producer === null ? null : part.producer + producers.length,
        refs: part.refs ? part.refs.map(i => i + producers.length) : part.refs,
      }));
      producers.push(...synthesis.spec.producers);
      imports = synthesis.spec.imports;
      faceArgs = synthesis.args;
      toFace = 'selector';
    }

    const scope = mergeScopeProducers(producers, request.scope);
    const options: ExtrudeEditOptions = {
      op: request.op,
      distance: request.distance,
      distance2: request.distance2,
      symmetric: request.symmetric,
      draft: request.draft,
      endOffset: request.endOffset,
      drill: request.drill,
      thin: request.thin,
      profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
      toFace,
      scope,
      regions: request.regions,
    };
    // Truthful preview names: the same resolution the transform runs
    // (reused consts, collision-suffixed hints).
    const producerVars = await allocateProducerVars(producers, code);
    const profileVar = request.profile.mode === 'bound' ? producerVars[0] ?? profileHint : null;
    const statement = renderExtrudeStatement(
      options, profileVar, faceArgs, scope.map(index => producerVars[index] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'extrude',
      extrude: options,
      filePath: request.profile.filePath,
      producers,
      parts,
      imports,
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
