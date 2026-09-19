import { Router } from 'express';
import { readFile } from 'fs/promises';
import type { FluidCadServer, SelectionSynthesisOptions } from '../fluidcad-server.ts';
import type { SynthesizedProducer, SynthesizedSelection } from '../../../lib/dist/index.js';
import { SelectionRequests } from './selection-requests.ts';
import { SketchExports, makeProducerNamer, makeProducerBindable, makeProducerBoundProbe, extractNumericParams, resolveParamValues } from '../apply-feature-edit.ts';
import { normalizePath } from '../normalize-path.ts';

/**
 * POST /resolve-selection — evaluate a filter expression, or explicit picks,
 * against the current scene with the candidate set a `select()` statement
 * sees at the given scope and statement boundary (see the lib's
 * SelectionResolver), and synthesize the selector the language would write
 * for the matches (SelectionSynthesizer) with the variable names the code
 * transform would bind. Zero matches is a 200; an unknown scope, an
 * ambiguous part name, a bad boundary, an unresolvable pick or an expression
 * that does not evaluate is a 4xx naming the problem.
 */
export function createResolveSelectionRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/resolve-selection', async (req, res) => {
    const { expression, picks, scope, before } = req.body ?? {};
    const problem = (expression === undefined) === (picks === undefined)
      ? 'pass exactly one of expression (filter syntax) or picks ({ shapeId, kind, index } refs)'
      : (expression !== undefined ? SelectionRequests.expressionError(expression) : SelectionRequests.picksError(picks))
        ?? SelectionRequests.scopeError(scope)
        ?? SelectionRequests.beforeError(before);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    try {
      const context = await SynthesisContext.forCurrentFile(fluidCadServer);
      const result = fluidCadServer.resolveSelection({
        ...(expression !== undefined ? { expression } : { picks: SelectionRequests.asPicks(picks) }),
        scope: SelectionRequests.asScope(scope),
        ...(before !== undefined ? { before } : {}),
      }, context?.options);
      if (result.ok === false) {
        const candidates = 'candidates' in result ? result.candidates : undefined;
        const pick = 'pick' in result ? result.pick : undefined;
        res.status(SelectionRequests.statusFor(result.code)).json({
          error: result.reason,
          code: result.code,
          ...(candidates ? { candidates } : {}),
          ...(pick ? { pick: { shapeId: pick.shapeId, kind: pick.sub.type, index: pick.sub.index } } : {}),
        });
        return;
      }
      if (result.synthesized?.ok && context) {
        await context.markBound(result.synthesized.producers);
        result.synthesized = await context.resolveExports(result.synthesized);
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}

type BoundProbe = Awaited<ReturnType<typeof makeProducerBoundProbe>>;

/**
 * The file-coupled synthesis options over the current buffer — producer
 * names as the transform would bind them, bindability, the file's numeric
 * constants — plus the bound-variable probe that annotates each producer
 * in the response. Built per request (the buffer may have changed); absent
 * when no file is open, in which case synthesis runs with hint names only.
 */
class SynthesisContext {

  private readonly probes = new Map<string, Promise<BoundProbe | undefined>>();

  private constructor(
    readonly options: SelectionSynthesisOptions,
    private readonly currentFile: string | null,
    private readonly currentProbe: BoundProbe,
    private readonly code: string,
  ) {}

  static async forCurrentFile(fluidCadServer: FluidCadServer): Promise<SynthesisContext | undefined> {
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      return undefined;
    }
    const options: SelectionSynthesisOptions = {
      namer: await makeProducerNamer(code),
      bindable: await makeProducerBindable(code),
      params: resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions()),
    };
    return new SynthesisContext(options, fluidCadServer.getCurrentFileName(), await makeProducerBoundProbe(code), code);
  }

  /** Dry-run the same producer transform the consuming edit will stage. */
  async resolveExports(synthesis: Extract<SynthesizedSelection, { ok: true }>): Promise<SynthesizedSelection> {
    const refs = synthesis.exports ?? [];
    if (refs.length === 0) {
      return synthesis;
    }
    if (this.currentFile && refs.some(ref => normalizePath(ref.sketch.filePath) !== normalizePath(this.currentFile!))) {
      return { ok: false, reason: 'sketch point exports must be authored in the sketch’s defining file' };
    }
    const staged = await SketchExports.applyCreates(this.code, refs);
    if ('error' in staged) {
      return { ok: false, reason: staged.error };
    }
    // The transform owns the real names (an existing binding or export key
    // wins over the provisional one) — re-render every form from its parts.
    const final = new Map(refs.map((ref, i) => [ref.part, staged.expressions[i]]));
    for (const [part, expression] of final) {
      synthesis.parts[part].source = expression;
    }
    synthesis.partSources = synthesis.parts.map(part => part.source!);
    synthesis.source = synthesis.partSources.join(', ');
    for (const alternative of synthesis.alternatives) {
      if (!alternative.partSources) {
        continue;
      }
      alternative.partSources = alternative.partSources.map((source, part) => final.get(part) ?? source);
      alternative.source = alternative.partSources.join(', ');
    }
    return synthesis;
  }

  /**
   * Whether each producer's statement already has a variable. Producers in
   * another file (a part factory imported into this one) are probed against
   * that file on disk — the buffer only holds the current one.
   */
  async markBound(producers: SynthesizedProducer[]): Promise<void> {
    for (const producer of producers) {
      const probe = producer.line === null ? undefined : await this.probeFor(producer.filePath);
      producer.bound = probe ? probe({ line: producer.line!, featureType: producer.featureType }) : false;
    }
  }

  private probeFor(filePath: string | null): Promise<BoundProbe | undefined> {
    const sameFile = !filePath || !this.currentFile || normalizePath(filePath) === normalizePath(this.currentFile);
    if (sameFile) {
      return Promise.resolve(this.currentProbe);
    }
    let probe = this.probes.get(filePath);
    if (!probe) {
      probe = readFile(filePath, 'utf8').then(code => makeProducerBoundProbe(code)).catch((): undefined => undefined);
      this.probes.set(filePath, probe);
    }
    return probe;
  }
}
