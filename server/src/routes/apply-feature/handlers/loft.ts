// POST /apply-feature, the loft create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  LoftConnections,
  renderLoftConnections,
  renderLoftStatement,
  renderSelectorPartExpr,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type LoftEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { scopeCrossFileError } from '../locations.ts';
import { allocateProducerVars, makeProducerMerger, mergeScopeProducers } from '../synthesis.ts';
import { loftProfileOwners, synthesizeLoftConnections, validateLoft } from '../validate/loft.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Loft takes an ordered list of profiles — sketches and picked faces
// mixed freely. Face picks run synthesis ONE AT A TIME: the kernel groups
// picks by (producer, bucket), so a batched call would merge same-bucket
// faces into one part and destroy profile order and arity.
export async function handleLoft(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateLoft(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    // Built on the first face profile — an all-sketch loft never runs
    // synthesis. Only `params` is passed: a namer would only shape
    // synthesis's own preview strings, which this branch discards
    // (profiles are re-rendered from the parts below).
    let synthOptions: { params: { name: string; value: number }[] } | undefined;
    let synthOptionsReady = false;

    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const profiles: LoftEditOptions['profiles'] = [];
    let filePath: string | null = null;

    for (const profile of request.profiles) {
      if (profile.kind === 'sketch') {
        // validateLoft holds sketches to one file; this catches a sketch
        // following a face pick synthesized from a different file.
        if (filePath !== null && profile.filePath !== filePath) {
          res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
          return;
        }
        filePath = profile.filePath;
        profiles.push({
          kind: 'sketch',
          producer: mergeProducer({
            line: profile.line, column: profile.column,
            featureType: 'sketch', nameHint: 's', bind: true,
          }),
        });
        continue;
      }
      if (!synthOptionsReady) {
        synthOptionsReady = true;
        if (code) {
          synthOptions = {
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          };
        }
      }
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [profile.pick], 'loft', undefined, [], synthOptions,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'a loft profile must be a single face selection' });
        return;
      }
      if (filePath !== null && synthesis.spec.filePath !== filePath) {
        res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
        return;
      }
      filePath = synthesis.spec.filePath;
      const remap = synthesis.spec.producers.map(mergeProducer);
      const part = synthesis.spec.parts[0];
      parts.push({
        ...part,
        producer: part.producer === null ? null : remap[part.producer],
        refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
      });
      for (const symbol of synthesis.spec.imports) {
        imports.add(symbol);
      }
      profiles.push({ kind: 'selector', part: parts.length - 1 });
    }

    // Guides are bound wire producers (a sketch() or a helix() statement),
    // merged like the sketch profiles (a sketch can't double as profile
    // and guide — validateLoft rejected that — but the merge keeps the
    // invariant local).
    const guides: NonNullable<LoftEditOptions['guides']> = [];
    for (const guide of request.guides) {
      if (filePath !== null && guide.filePath !== filePath) {
        res.status(422).json({ success: false, reason: 'the loft guides come from features in different files' });
        return;
      }
      filePath = guide.filePath;
      guides.push({
        kind: 'sketch',
        producer: mergeProducer({
          line: guide.line, column: guide.column,
          featureType: 'wire', nameHint: 'g', bind: true,
        }),
      });
    }

    // Connection producers go through the merger, so they are folded
    // BEFORE the scope solids: the scope pass appends to the list directly
    // and would be invisible to a later merge (one statement, two producers).
    const connectionResult = await synthesizeLoftConnections(fluidCadServer, request.connections,
      filePath!, mergeProducer, { filePath: filePath!, line: producers[0].line, column: producers[0].column },
      loftProfileOwners(request.profiles));
    if ('error' in connectionResult) {
      res.status(422).json({ success: false, reason: connectionResult.error });
      return;
    }
    for (const symbol of connectionResult.imports) {
      imports.add(symbol);
    }

    // Scope solids fold in last — a profile's own producer can double as
    // the scope target, matched by line like every statement key (no
    // later mergeProducer call runs, so the direct pushes stay aligned).
    if (filePath !== null) {
      const crossFile = scopeCrossFileError(request.scope, filePath);
      if (crossFile) {
        res.status(422).json({ success: false, reason: crossFile });
        return;
      }
    }
    const scope = mergeScopeProducers(producers, request.scope);
    const options: LoftEditOptions = {
      op: request.op, thin: request.thin, profiles,
      guides: guides.length > 0 ? guides : undefined,
      startCondition: request.startCondition ?? undefined,
      endCondition: request.endCondition ?? undefined,
      connections: connectionResult.connections,
      scope,
    };
    const spec: ApplyFeatureEditSpec = {
      feature: 'loft', loft: options, filePath: filePath!, producers, parts,
      imports: [...imports], newVariables,
    };
    const staged = code ? await LoftConnections.prepare(code, spec) : { code, spec };
    if ('error' in staged) {
      res.status(422).json({ success: false, reason: staged.error });
      return;
    }
    const producerVars = await allocateProducerVars(staged.spec.producers, staged.code);
    const profileExprs = profiles.map(profile => {
      if (profile.kind === 'sketch') {
        return producerVars[profile.producer] ?? 's';
      }
      const part = parts[profile.part];
      return renderSelectorPartExpr(part,
        part.producer === null ? null : producerVars[part.producer], i => producerVars[i] ?? null);
    });
    const connections = renderLoftConnections(staged.spec.loft?.connections, profiles.length, i => producerVars[i] ?? null);
    if ('error' in connections) {
      res.status(422).json({ success: false, reason: connections.error });
      return;
    }
    const statement = renderLoftStatement(options, profileExprs,
      guides.map(guide => producerVars[guide.producer] ?? 'g'), scope.map(index => producerVars[index] ?? 'f'), connections.args);
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
