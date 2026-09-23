// POST /apply-feature, the sweep create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderSweepStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type SweepEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { scopeCrossFileError } from '../locations.ts';
import { allocateProducerVars, mergeScopeProducers } from '../synthesis.ts';
import { validateSweep } from '../validate/sweep.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Sweep composes a profile sketch with a path (a second sketch, or edge
// picks synthesized into a selector) — no shared pick validation applies.
export async function handleSweep(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateSweep(req.body);
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
    const producers: ApplyFeatureEditSpec['producers'] = [];
    let parts: ApplyFeatureEditSpec['parts'] = [];
    let imports: string[] = [];
    let pathArgs: string | null = null;
    let alternatives: string[] | undefined;

    if (request.path.kind === 'edges') {
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
        request.path.picks, 'sweep', undefined, request.path.chains, options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // The path argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({
          success: false,
          reason: 'the picked edges must form a single selection — use "Select with tangents" or pick edges of one feature',
        });
        return;
      }
      if (synthesis.spec.filePath !== request.profile.filePath) {
        res.status(422).json({ success: false, reason: 'the path edges and the profile sketch come from different files' });
        return;
      }
      producers.push(...synthesis.spec.producers);
      parts = synthesis.spec.parts;
      imports = synthesis.spec.imports;
      pathArgs = synthesis.args;
      alternatives = synthesis.alternatives;
    }

    let path: SweepEditOptions['path'];
    if (request.path.kind === 'sketch') {
      // The path is a wire source — a sketch() or a helix() statement.
      producers.push({
        line: request.path.line, column: request.path.column,
        featureType: 'wire', nameHint: 'p', bind: true,
      });
      path = { kind: 'sketch', producer: producers.length - 1 };
    } else {
      path = { kind: 'selector' };
    }
    // The profile rides the producer list in both modes: bound entries
    // get a variable, the implicit anchor verifies the sketch call and
    // (with a sketch path) locates the insertion scope.
    producers.push({
      line: request.profile.line, column: request.profile.column,
      featureType: 'sketch', nameHint: 's', bind: request.profile.mode === 'bound',
    });
    const profile: SweepEditOptions['profile'] = request.profile.mode === 'bound'
      ? { producer: producers.length - 1 }
      : 'implicit';

    const scope = mergeScopeProducers(producers, request.scope);
    // Truthful preview names: the same resolution the transform runs
    // (reused consts, collision-suffixed hints) in one pass, so
    // collision suffixes stay consistent across every input.
    const producerVars = await allocateProducerVars(producers, code);
    const options: SweepEditOptions = {
      op: request.op, thin: request.thin,
      extendStart: request.extendStart, extendEnd: request.extendEnd,
      profile, path, scope, regions: request.regions,
    };
    const pathExpr = path.kind === 'sketch' ? producerVars[path.producer] ?? 'p' : pathArgs!;
    const statement = renderSweepStatement(
      options,
      pathExpr,
      profile === 'implicit' ? null : producerVars[profile.producer] ?? 's',
      scope.map(index => producerVars[index] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement, args: pathArgs ?? undefined, alternatives });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'sweep',
      sweep: options,
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
