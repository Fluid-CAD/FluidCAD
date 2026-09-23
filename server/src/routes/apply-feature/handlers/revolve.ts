// POST /apply-feature, the revolve create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderRevolveStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type RevolveEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { scopeCrossFileError } from '../locations.ts';
import { allocateProducerVars, mergeScopeProducers } from '../synthesis.ts';
import { validateRevolve } from '../validate/revolve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Revolve composes a profile sketch around an axis — a standard world
// axis, an existing axis statement bound to a variable, or a picked edge
// synthesized into `axis(<selector>)`.
export async function handleRevolve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateRevolve(req.body);
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
    // revolve contract; the axis producer / selector producers follow it.
    const producers: ApplyFeatureEditSpec['producers'] = [{
      line: request.profile.line,
      column: request.profile.column,
      featureType: 'sketch',
      nameHint: 's',
      bind: request.profile.mode === 'bound',
    }];
    let parts: ApplyFeatureEditSpec['parts'] = [];
    let imports: string[] = [];
    let axis: RevolveEditOptions['axis'];
    let axisArgs: string | null = null;
    let alternatives: string[] | undefined;

    if (request.axis.kind === 'edge') {
      const options = code
        ? {
          namer: await makeProducerNamer(code),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [request.axis.pick], 'revolve', undefined, [], options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // The axis argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'the revolve axis must be a single edge selection' });
        return;
      }
      if (synthesis.spec.filePath !== request.profile.filePath) {
        res.status(422).json({ success: false, reason: 'the axis edge and the profile sketch come from different files' });
        return;
      }
      parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
        ...part,
        producer: part.producer === null ? null : part.producer + producers.length,
        refs: part.refs ? part.refs.map(i => i + producers.length) : part.refs,
      }));
      producers.push(...synthesis.spec.producers);
      imports = [...synthesis.spec.imports, 'axis'];
      axisArgs = synthesis.args;
      alternatives = synthesis.alternatives;
      axis = { kind: 'selector' };
    } else if (request.axis.kind === 'axis') {
      producers.push({
        line: request.axis.loc.line, column: request.axis.loc.column,
        featureType: 'axis', nameHint: 'a', bind: true,
      });
      axis = { kind: 'axis', producer: producers.length - 1 };
    } else {
      axis = { kind: 'standard', axis: request.axis.axis };
    }

    const scope = mergeScopeProducers(producers, request.scope);
    const options: RevolveEditOptions = {
      op: request.op,
      angle: request.angle,
      symmetric: request.symmetric,
      thin: request.thin,
      profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
      axis,
      scope,
      regions: request.regions,
    };

    // Truthful preview names: the same resolution the transform runs
    // (reused consts, collision-suffixed hints) in one pass, so
    // collision suffixes stay consistent across every input.
    const producerVars = await allocateProducerVars(producers, code);
    const axisExpr = axis.kind === 'selector'
      ? `axis(${axisArgs})`
      : axis.kind === 'axis' ? (producerVars[axis.producer] ?? 'a') : `'${axis.axis}'`;
    const statement = renderRevolveStatement(
      options,
      axisExpr,
      request.profile.mode === 'bound' ? producerVars[0] ?? 's' : null,
      scope.map(index => producerVars[index] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement, args: axisArgs ?? undefined, alternatives });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'revolve',
      revolve: options,
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
