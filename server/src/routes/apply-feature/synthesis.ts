// Selector synthesis helpers: pick synthesizers, producer merging and variable allocation.

import type { Response } from 'express';
import type { FluidCadServer } from '../../fluidcad-server/index.ts';
import {
  extractNumericParams,
  makeProducerBindable,
  makeProducerNamer,
  resolveParamValues,
  type ApplyFeatureEditSpec,
} from '../../apply-feature-edit/index.ts';
import { readFile } from 'fs/promises';
import { normalizePath } from '../../normalize-path.ts';
import type { SketchLoc } from './locations.ts';
import type { Pick } from './picks.ts';

/**
 * Producers merged by call site across per-pick synthesis calls (and the
 * request's own sketch/plane inputs); a bind:true entry wins over an anchor.
 * Shared by the loft and plane branches.
 */
export function makeProducerMerger(): {
  producers: ApplyFeatureEditSpec['producers'];
  merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
} {
  const producers: ApplyFeatureEditSpec['producers'] = [];
  const index = new Map<string, number>();
  const merge = (producer: ApplyFeatureEditSpec['producers'][number]): number => {
    const key = `${producer.line}:${producer.column}`;
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, producers.length);
      producers.push(producer);
      return producers.length - 1;
    }
    if (producer.bind && !producers[existing].bind) {
      producers[existing] = producer;
    }
    return existing;
  };
  return { producers, merge };
}

/**
 * Fold a create request's `.scope(…)` locs into an arm's producer list,
 * returning the producer indices in pick order. A loc already in the list —
 * a selector part's own producer doubling as the scope target — is reused
 * with its featureType intact (the transform's scope check accepts any
 * bound solid-bearing producer); the rest append as bound `feature`
 * producers. Matching is by LINE, the statement key everywhere else — a
 * duplicate producer for one statement would bind `const` twice. Shared by
 * the extrude, sweep, revolve and loft arms (rib's merger-based arm folds
 * its own).
 */
export function mergeScopeProducers(
  producers: ApplyFeatureEditSpec['producers'],
  scope: SketchLoc[],
): number[] {
  return scope.map(loc => {
    const existing = producers.findIndex(p => p.line === loc.line);
    if (existing >= 0) {
      return existing;
    }
    producers.push({
      line: loc.line, column: loc.column,
      featureType: 'feature', nameHint: 'f', bind: true,
    });
    return producers.length - 1;
  });
}

/**
 * One picked create-arm input (axis edge / mirror face) synthesized into its
 * own selector part, reusing the single-selection synthesis kinds ('revolve'
 * names one edge, 'plane' one face) — shared by the repeat, copy, mirror and
 * rotate arms, which used to carry a copy each. The returned closure memoizes
 * its namer/params lazily, so a pick-less request never runs synthesis; it
 * returns the part index, or null after refusing with a response.
 */
export function makePickSynthesizer(deps: {
  res: Response;
  fluidCadServer: FluidCadServer;
  code: string | null;
  filePath: string;
  mergeProducer: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
  parts: ApplyFeatureEditSpec['parts'];
  imports: Set<string>;
}): (
  pick: Pick,
  kind: 'revolve' | 'plane',
  errors: { multi: string; crossFile: string },
) => Promise<number | null> {
  // Built lazily on the first picked input — a pick-less request never runs
  // synthesis.
  let synthOptions: {
    namer?: Awaited<ReturnType<typeof makeProducerNamer>>;
    params?: { name: string; value: number }[];
  } | undefined;
  let synthOptionsReady = false;
  return async (pick, kind, errors) => {
    if (!synthOptionsReady) {
      synthOptionsReady = true;
      if (deps.code) {
        synthOptions = {
          namer: await makeProducerNamer(deps.code),
          params: resolveParamValues(
            await extractNumericParams(deps.code),
            deps.fluidCadServer.getParamDefinitions(),
          ),
        };
      }
    }
    const synthesis = deps.fluidCadServer.synthesizeApplyFeature(
      [pick], kind, undefined, [], synthOptions,
    );
    if (!synthesis) {
      deps.res.status(404).json({ success: false, reason: 'No rendered scene' });
      return null;
    }
    if (!synthesis.ok) {
      deps.res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
      return null;
    }
    // The axis/plane argument is ONE SceneObject — a multi-part selection
    // has no single-expression rendering.
    if (synthesis.spec.parts.length !== 1) {
      deps.res.status(422).json({ success: false, reason: errors.multi });
      return null;
    }
    if (synthesis.spec.filePath !== deps.filePath) {
      deps.res.status(422).json({ success: false, reason: errors.crossFile });
      return null;
    }
    const remap = synthesis.spec.producers.map(deps.mergeProducer);
    const part = synthesis.spec.parts[0];
    deps.parts.push({
      ...part,
      producer: part.producer === null ? null : remap[part.producer],
      refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
    });
    for (const symbol of synthesis.spec.imports) {
      deps.imports.add(symbol);
    }
    deps.imports.add(kind === 'plane' ? 'plane' : 'axis');
    return deps.parts.length - 1;
  };
}

/** The picked-edge refusals the axis-consuming create arms share. */
export const AXIS_PICK_ERRORS = {
  crossFile: 'an axis edge and the targets come from different files',
};

/**
 * Truthful preview names: one namer pass over the bound producers in spec
 * order — the same allocation walk the transform runs. Unnamed producers fall
 * back to collision-suffixed hints; unbound (anchor) entries stay null.
 */
export async function allocateProducerVars(
  producers: ApplyFeatureEditSpec['producers'],
  code: string | null,
): Promise<(string | null)[]> {
  const names: (string | null)[] = producers.map((): null => null);
  if (code) {
    const namer = await makeProducerNamer(code);
    const bound = producers
      .map((producer, index) => ({ producer, index }))
      .filter(entry => entry.producer.bind);
    const resolved = namer(bound.map(({ producer }) => ({
      line: producer.line, nameHint: producer.nameHint, featureType: producer.featureType,
    })));
    bound.forEach((entry, i) => {
      names[entry.index] = resolved[i];
    });
  }
  const used = new Set(names.filter((n): n is string => n !== null));
  return producers.map((producer, i) => {
    if (!producer.bind) {
      return null;
    }
    if (names[i]) {
      return names[i];
    }
    const hint = producer.nameHint || 'f';
    let name = hint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${hint}${suffix}`;
    }
    used.add(name);
    return name;
  });
}

/**
 * The file-coupled synthesis options (producer namer + linkable params)
 * built over the file the emitted statement will land in. Synthesis
 * derives that file from the picked producers' own sourceLocations —
 * under an assembly render it is the PART file, so building these over
 * `getCurrentCode()` (the assembly buffer) would preview wrong binding
 * names and link assembly-file constants into part-file selectors. The
 * current buffer serves the open file; other files read from disk (an
 * unsaved part buffer can be stale here — the editor round-trip is what
 * verifies the final transform). Shared with the assembly-mate route's
 * tangent find-or-create.
 */
export function makeSynthesisOptionsForFile(fluidCadServer: FluidCadServer) {
  return async (
    filePath: string | null | undefined,
  ): Promise<{
    namer: Awaited<ReturnType<typeof makeProducerNamer>>;
    bindable: Awaited<ReturnType<typeof makeProducerBindable>>;
    params: ReturnType<typeof resolveParamValues>;
  } | undefined> => {
    const currentFile = fluidCadServer.getCurrentFileName();
    let code: string | null = null;
    if (!filePath || (currentFile && normalizePath(filePath) === normalizePath(currentFile))) {
      code = fluidCadServer.getCurrentCode();
    } else {
      try {
        code = await readFile(filePath, 'utf8');
      } catch {
        code = null;
      }
    }
    if (!code) {
      return undefined;
    }
    return {
      namer: await makeProducerNamer(code),
      bindable: await makeProducerBindable(code),
      params: resolveParamValues(
        await extractNumericParams(code),
        fluidCadServer.getParamDefinitions(),
      ),
    };
  };
}
