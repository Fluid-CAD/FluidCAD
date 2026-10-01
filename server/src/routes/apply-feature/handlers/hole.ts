// POST /apply-feature, the hole create branch, and the placement resolution the edit branch shares.

import type { Request, Response } from 'express';
import type { FluidCadServer, SelectionBoundary } from '../../../fluidcad-server/index.ts';
import {
  applyFeatureEdit,
  extractNumericParams,
  HolePlacements,
  makeProducerBindable,
  makeProducerNamer,
  renderConnectorAnchorSuffix,
  renderHolePlacementExprs,
  renderHoleStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type HoleEditOptions,
  type HolePlacementSpec,
} from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import { scopeCrossFileError } from '../locations.ts';
import { allocateProducerVars, makeProducerMerger, mergeScopeProducers } from '../synthesis.ts';
import { validateHole, type HolePlacementInput } from '../validate/hole.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

type Merger = ReturnType<typeof makeProducerMerger>['merge'];

/** What the placement resolver folds into: the spec's producer merger, parts and imports. */
export type HolePlacementSink = {
  merge: Merger;
  parts: ApplyFeatureEditSpec['parts'];
  imports: Set<string>;
};

type Resolved = { placements: HolePlacementSpec[]; filePath: string | null } | { error: string; status: number };

/**
 * Turn the dialog's placements into the spec's: a connector by its
 * statement (plus a copy's slot); a sketch vertex through the vertex
 * synthesis (an export request the pre-pass authors, or an edge endpoint on
 * a solid); a face/edge anchor through the `hole` synthesis kind — inside a
 * part it becomes a named connector the pre-pass creates, elsewhere the bare
 * anchor expression.
 */
export async function resolveHolePlacements(
  server: FluidCadServer,
  inputs: HolePlacementInput[],
  sink: HolePlacementSink,
  synthesisOptionsForFile: ApplyFeatureRequestContext['synthesisOptionsForFile'],
  before?: SelectionBoundary,
): Promise<Resolved> {
  const placements: HolePlacementSpec[] = [];
  let filePath: string | null = null;
  const sameFile = (path: string | null | undefined, what: string): string | null => {
    if (!path) {
      return `${what} has no source file`;
    }
    if (filePath !== null && normalizePath(path) !== normalizePath(filePath)) {
      return 'the hole placements come from features in different files';
    }
    filePath = path;
    return null;
  };

  // Vertex picks resolve in one pass, in pick order, like loft connections.
  const vertexPicks = inputs.flatMap(input => input.kind === 'vertex' ? [input.pick] : []);
  const vertexSpecs: HolePlacementSpec[] = [];
  if (vertexPicks.length > 0) {
    const code = server.getCurrentCode();
    if (!code) {
      return { error: 'no current source buffer is available for sketch vertex placements', status: 422 };
    }
    const resolved = server.resolveSelection({ picks: vertexPicks, ...(before ? { before: before.index } : {}) }, {
      namer: await makeProducerNamer(code), bindable: await makeProducerBindable(code),
      params: resolveParamValues(await extractNumericParams(code), server.getParamDefinitions()),
    });
    if (resolved.ok === false) {
      return { error: resolved.reason, status: 422 };
    }
    const synthesis = resolved.synthesized;
    if (!synthesis?.ok) {
      return { error: synthesis && synthesis.ok === false ? synthesis.reason : 'the workspace kernel cannot name the picked vertices', status: 422 };
    }
    const remap = new Map<string, number>();
    for (const producer of synthesis.producers) {
      const problem = sameFile(producer.filePath, 'a vertex placement');
      if (problem || producer.line === null) {
        return { error: problem ?? 'a vertex placement has no source line', status: 422 };
      }
      remap.set(producer.sceneObjectId, sink.merge({
        line: producer.line, column: producer.column ?? 0,
        featureType: producer.featureType, nameHint: producer.variable, bind: true,
      }));
    }
    for (const part of synthesis.parts) {
      if (part.point?.kind === 'sketch' && part.producer !== null && remap.has(part.producer)) {
        vertexSpecs.push({ kind: 'sketch', producer: remap.get(part.producer)!, target: part.point.target });
      } else if (part.point?.kind === 'edge') {
        sink.parts.push({
          producer: part.producer === null ? null : remap.get(part.producer)!,
          accessor: part.accessor, indices: part.point.indices, filterArgs: part.point.filterArgs,
          refs: part.point.refs.map(id => remap.get(id)!),
        });
        vertexSpecs.push({ kind: 'part', part: sink.parts.length - 1, suffix: `.${part.point.role}()` });
      } else {
        return { error: 'a picked vertex has no source expression', status: 422 };
      }
    }
    if (vertexSpecs.length !== vertexPicks.length) {
      return { error: 'each picked vertex must resolve to one point expression', status: 422 };
    }
    for (const symbol of synthesis.imports) {
      sink.imports.add(symbol);
    }
  }

  let vertexAt = 0;
  for (const input of inputs) {
    if (input.kind === 'verbatim') {
      placements.push({ kind: 'verbatim', sourceIndex: input.sourceIndex });
    } else if (input.kind === 'connector') {
      const problem = sameFile(input.filePath, 'a connector placement');
      if (problem) {
        return { error: problem, status: 422 };
      }
      // A copy shares its seed's statement: the producer merges, the slot tells them apart.
      placements.push({
        kind: 'connector',
        producer: sink.merge({ line: input.line, column: input.column, featureType: 'connector', nameHint: 'c', bind: true }),
        ...(input.slot !== undefined ? { slot: input.slot } : {}),
      });
    } else if (input.kind === 'vertex') {
      placements.push(vertexSpecs[vertexAt++]);
    } else {
      // Two-pass like the connector arm: the bare pass learns the target
      // file, the real pass names things the way that file's code does.
      const connectorOptions = { connector: { anchor: input.anchor } };
      const probe = server.synthesizeApplyFeature([input.pick], 'hole', undefined, [], connectorOptions, before);
      if (!probe) {
        return { error: 'No rendered scene', status: 404 };
      }
      if (!probe.ok) {
        return { error: probe.reason, status: 422 };
      }
      const fileOptions = await synthesisOptionsForFile(probe.spec.filePath);
      const synthesis = fileOptions
        ? server.synthesizeApplyFeature([input.pick], 'hole', undefined, [], { ...fileOptions, ...connectorOptions }, before)
        : probe;
      if (!synthesis || !synthesis.ok) {
        return { error: synthesis && !synthesis.ok ? synthesis.reason : 'No rendered scene', status: 422 };
      }
      const problem = sameFile(synthesis.spec.filePath, 'an anchor placement');
      if (problem) {
        return { error: problem, status: 422 };
      }
      const part = synthesis.spec.hole?.part;
      if (part) {
        // Inside a part the anchor becomes a named connector — the hole's
        // mating frame for the fastener that will seat in it.
        placements.push({
          kind: 'newConnector',
          name: input.name,
          create: {
            feature: 'connector',
            connector: { name: input.name, part, anchor: input.anchor },
            filePath: synthesis.spec.filePath,
            producers: synthesis.spec.producers,
            parts: synthesis.spec.parts,
            imports: synthesis.spec.imports,
          },
        });
      } else {
        const spec = synthesis.spec as ApplyFeatureEditSpec;
        const remap = spec.producers.map(producer => sink.merge(producer));
        for (const partSpec of spec.parts) {
          sink.parts.push({
            ...partSpec,
            producer: partSpec.producer === null ? null : remap[partSpec.producer],
            refs: partSpec.refs ? partSpec.refs.map((i: number) => remap[i]) : partSpec.refs,
          });
        }
        for (const symbol of synthesis.spec.imports) {
          sink.imports.add(symbol);
        }
        placements.push({ kind: 'part', part: sink.parts.length - 1, suffix: renderConnectorAnchorSuffix(input.anchor) });
      }
    }
  }
  return { placements, filePath };
}

export async function handleHole(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor, synthesisOptionsForFile } = ctx;
  const request = validateHole(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const { producers, merge } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const resolved = await resolveHolePlacements(fluidCadServer, request.placements, { merge, parts, imports }, synthesisOptionsForFile);
    if ('error' in resolved) {
      res.status(resolved.status).json({ success: false, reason: resolved.error });
      return;
    }
    const filePath = resolved.filePath ?? request.scope[0]?.filePath ?? fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(422).json({ success: false, reason: 'no file to write the hole into — open and render a file first' });
      return;
    }
    const crossFile = scopeCrossFileError(request.scope, filePath);
    if (crossFile) {
      res.status(422).json({ success: false, reason: crossFile });
      return;
    }
    const scope = mergeScopeProducers(producers, request.scope);
    const options: HoleEditOptions = {
      size: request.size, fastener: request.fastener, style: request.style,
      depth: request.depth, tipAngle: request.tipAngle,
      placements: resolved.placements, scope,
    };
    const activePart = activePartFor(filePath);
    const spec: ApplyFeatureEditSpec = {
      feature: 'hole', hole: options, filePath, producers, parts,
      imports: [...imports], newVariables,
      ...(activePart ? { activePart } : {}),
    };
    // Truthful preview: stage the exports and new connectors the way the
    // transform will, then name producers the way its binding walk does.
    const staged = code ? await HolePlacements.prepare(code, spec, applyFeatureEdit) : { code, spec };
    if ('error' in staged) {
      res.status(422).json({ success: false, reason: staged.error });
      return;
    }
    const vars = await allocateProducerVars(staged.spec.producers, staged.code);
    const exprs = renderHolePlacementExprs(staged.spec.hole!.placements, staged.spec.parts, i => vars[i] ?? null);
    if ('error' in exprs) {
      res.status(422).json({ success: false, reason: exprs.error });
      return;
    }
    const statement = renderHoleStatement(options, exprs.exprs, scope.map(index => vars[index] ?? 'f'));
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
