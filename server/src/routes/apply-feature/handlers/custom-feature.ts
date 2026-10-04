// POST /apply-feature, custom features: a create, and the in-place edit of a statement — both through the feature's call shape.

import type { Request, Response } from 'express';
import {
  CustomFeatureImport,
  CustomFeatureStatement,
  parseFeatureStatement,
  renderEditedStatement,
  resolveEditedStatementLine,
  type ApplyFeatureEditSpec,
  type CustomFeatureOptions,
  type CustomPickSource,
  type CustomValueSource,
  type ParsedCustomFeature,
} from '../../../apply-feature-edit/index.ts';
import type { FeatureMetaSnapshot, FeatureSlotPicks } from '../../../../../lib/dist/index.js';
import type { SelectionBoundary } from '../../../fluidcad-server/index.ts';
import { detectKind } from '../../../file-kind.ts';
import { normalizePath } from '../../../normalize-path.ts';
import type { FeatureCatalogEntry } from '../../../feature-catalog/catalog.ts';
import { validateBoundary } from '../picks.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { CustomFeatureInputs, validateCustomRequest, type CustomFeatureRequest, type CustomPickInput } from '../validate/custom.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

/** A refusal the handler answers with. */
type Refusal = { status: number; reason: string };

/** The picks of one request folded into a spec's producers and parts, with each value's elements. */
type ResolvedPicks = {
  producers: ApplyFeatureEditSpec['producers'];
  parts: ApplyFeatureEditSpec['parts'];
  imports: string[];
  values: Record<string, CustomValueSource>;
  scope: NonNullable<CustomFeatureOptions['scope']> | undefined;
  /** The file the picked statements and geometry live in, or null when nothing was picked. */
  filePath: string | null;
  /** Each geometry value's synthesized elements, as the preview names them. */
  args: Record<string, string[]>;
};

/**
 * A custom feature's create: the request's values checked against the
 * feature's metadata, its picks synthesized (geometry) or bound (statements),
 * and the statement written through the feature's call shape — at the end
 * of the scope its picks pin, or in the active part when nothing pins it.
 */
export async function handleCustomFeature(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateCustomRequest(req.body, false);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const entry = await CustomFeatureRoute.entry(ctx, request.id);
    if ('reason' in entry) {
      res.status(entry.status).json({ success: false, reason: entry.reason });
      return;
    }
    const meta = entry.meta!;
    const checked = CustomFeatureInputs.values(meta, request, false);
    if ('error' in checked) {
      res.status(422).json({ success: false, reason: checked.error });
      return;
    }
    const picks = await CustomFeatureRoute.resolvePicks(ctx, meta, request, checked.values, undefined, null);
    if ('reason' in picks) {
      res.status(picks.status).json({ success: false, reason: picks.reason });
      return;
    }
    const filePath = picks.filePath ?? fluidCadServer.getCurrentFileName();
    const refusal = CustomFeatureRoute.fileRefusal(filePath);
    if (refusal) {
      res.status(422).json({ success: false, reason: refusal });
      return;
    }
    const custom: CustomFeatureOptions = {
      id: meta.id,
      exportName: entry.exportName!,
      modulePath: entry.modulePath,
      shape: CustomFeatureStatement.shapeOf(meta),
      values: picks.values,
      ...(request.operation ? { operation: request.operation } : {}),
      ...(picks.scope && picks.scope.length > 0 ? { scope: picks.scope } : {}),
    };
    const spec: ApplyFeatureEditSpec = {
      feature: 'custom',
      filePath,
      producers: picks.producers,
      parts: picks.parts,
      imports: picks.imports,
      custom,
      newVariables,
      // The scope the picks pin wins; a statement they don't pin (typed-in
      // values, top-level sketches and datums) lands in the active part.
      ...(ctx.activePartFor(filePath) ? { activePart: ctx.activePartFor(filePath) } : {}),
    };

    // Truthful preview: the callee the import plan names and the variables
    // the transform's binding walk allocates.
    const code = CustomFeatureRoute.codeFor(ctx, filePath);
    const callee = code
      ? (await CustomFeatureImport.plan(code, filePath, custom.exportName!, custom.modulePath!)).local
      : custom.exportName!;
    const vars = await allocateProducerVars(spec.producers, code, await ctx.currentCallees());
    const rendered = CustomFeatureStatement.render(callee, custom, spec, i => vars[i] ?? null);
    if ('error' in rendered) {
      res.status(422).json({ success: false, reason: rendered.error });
      return;
    }
    if (preview === true) {
      res.json({ success: true, preview: rendered.statement, args: picks.args });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: rendered.statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}

/**
 * The in-place edit of a custom feature statement (a timeline double-click
 * on its row): the statement read back by its call shape, the dialog's
 * values written over it — a value or pick the request leaves out keeps the
 * statement's own text, picked elements may be kept by position — and its
 * re-picks synthesized against the world before it.
 */
export async function handleCustomFeatureEdit(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateCustomRequest(req.body, true);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  const target = validateSketchLoc(req.body?.edit);
  if (!target) {
    res.status(400).json({ error: 'edit must be the {filePath, line, column} of the feature statement' });
    return;
  }
  const expected = req.body?.expectedStatement;
  if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || expected.length > 4000)) {
    res.status(400).json({ error: 'expectedStatement must be the statement text from /api/feature/parse' });
    return;
  }
  const before = validateBoundary(req.body?.before);
  if (before === null) {
    res.status(400).json({ error: 'before must be {index, type, line, column}' });
    return;
  }
  const repicks = Object.values(request.picks).some(inputs => inputs.some(input => input.kind === 'entities'));
  if (repicks && !before) {
    res.status(400).json({ error: 'before is required when an edit re-picks geometry' });
    return;
  }
  try {
    const currentFile = fluidCadServer.getCurrentFileName();
    if (currentFile && normalizePath(target.filePath) !== normalizePath(currentFile)) {
      res.status(422).json({ success: false, reason: 'that feature lives in a different file than the one being edited' });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      res.status(404).json({ success: false, reason: 'No live code buffer' });
      return;
    }
    const callees = await ctx.currentCallees();
    const line = await resolveEditedStatementLine(code, target.line, expected, callees);
    const parsed = await parseFeatureStatement(code, line, callees);
    if (parsed.ok === false) {
      res.status(422).json({ success: false, reason: parsed.reason });
      return;
    }
    if (parsed.parsed.feature !== 'custom' || parsed.parsed.id !== request.id) {
      res.status(422).json({
        success: false,
        reason: `the statement at line ${line} is not a ${request.id} — is the file in sync with the last render?`,
      });
      return;
    }
    if (expected !== undefined && parsed.statement !== expected) {
      res.status(422).json({ success: false, reason: 'the statement changed since the dialog opened — re-open it to edit the current code' });
      return;
    }
    const entry = await CustomFeatureRoute.entry(ctx, request.id);
    if ('reason' in entry) {
      res.status(entry.status).json({ success: false, reason: entry.reason });
      return;
    }
    const meta = entry.meta!;
    const checked = CustomFeatureInputs.values(meta, request, true);
    if ('error' in checked) {
      res.status(422).json({ success: false, reason: checked.error });
      return;
    }
    const picks = await CustomFeatureRoute.resolvePicks(ctx, meta, request, checked.values, before, parsed.parsed);
    if ('reason' in picks) {
      res.status(picks.status).json({ success: false, reason: picks.reason });
      return;
    }
    if (picks.filePath && normalizePath(picks.filePath) !== normalizePath(target.filePath)) {
      res.status(422).json({ success: false, reason: 'a re-sourced input lives in a different file than the edited statement' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'custom',
      filePath: target.filePath,
      producers: picks.producers,
      parts: picks.parts,
      imports: picks.imports,
      edit: {
        line,
        column: target.column,
        ...(expected !== undefined ? { expectedStatement: expected } : {}),
        custom: {
          id: request.id,
          values: picks.values,
          ...(request.operation ? { operation: request.operation } : {}),
          ...(picks.scope !== undefined ? { scope: picks.scope } : {}),
        },
      },
      newVariables,
      // Applying clears the breakpoint the double-click placed, in the
      // same transform, and the model rebuilds to its tip.
      clearBreakpoints: true,
    };
    const vars = await allocateProducerVars(spec.producers, code, callees);
    const rendered = renderEditedStatement(parsed.parsed, spec, i => vars[i] ?? null);
    if ('error' in rendered) {
      res.status(422).json({ success: false, reason: rendered.error });
      return;
    }
    if (preview === true) {
      res.json({ success: true, preview: rendered.statement, args: picks.args });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: rendered.statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}

/** What the create and the edit share: the catalog entry, the picks, the file rules. */
class CustomFeatureRoute {

  /** The catalog entry the request names: one feature, offered — not an error entry, not an id two builders share. */
  static async entry(ctx: ApplyFeatureRequestContext, id: string): Promise<FeatureCatalogEntry | Refusal> {
    if (!ctx.catalog) {
      return { status: 422, reason: 'this server has no feature catalog to look custom features up in' };
    }
    const entries = await ctx.catalog.list();
    if (entries === null) {
      return { status: 503, reason: 'Engine not initialized yet' };
    }
    const matching = entries.filter(entry => entry.id === id);
    if (matching.length === 0) {
      return { status: 422, reason: `no feature '${id}' in this workspace — is its module still there?` };
    }
    const entry = matching[0];
    if (entry.error !== undefined || !entry.meta || !entry.exportName) {
      return { status: 422, reason: entry.error ?? `feature '${id}' can't be offered` };
    }
    return entry;
  }

  /** Why the statement can't go in `filePath`, or null. */
  static fileRefusal(filePath: string): string | null {
    if (detectKind(filePath) === 'assembly') {
      return 'custom features are written in part files — open the part\'s own file to add one';
    }
    return null;
  }

  /** The source of `filePath` the preview names variables over: the live buffer for the open file. */
  static codeFor(ctx: ApplyFeatureRequestContext, filePath: string): string | null {
    const currentFile = ctx.fluidCadServer.getCurrentFileName();
    if (currentFile && normalizePath(currentFile) !== normalizePath(filePath)) {
      return null;
    }
    return ctx.fluidCadServer.getCurrentCode();
  }

  /**
   * Every picked value of the request as the elements the transform
   * writes: geometry synthesized in one pass over every slot (an edit's
   * against the world before its statement), statements bound by call site,
   * world axes and planes by name, an edit's keeps by position. Folded with
   * the typed-in `values` and the scope into one spec.
   */
  static async resolvePicks(
    ctx: ApplyFeatureRequestContext,
    meta: FeatureMetaSnapshot,
    request: CustomFeatureRequest,
    values: Record<string, CustomValueSource>,
    before: SelectionBoundary | undefined,
    parsed: ParsedCustomFeature | null,
  ): Promise<ResolvedPicks | Refusal> {
    const { producers, merge } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const files = new Set<string>();
    const out: Record<string, CustomValueSource> = { ...values };
    const args: Record<string, string[]> = {};

    // Geometry first, every slot in one synthesis: a statement two slots
    // read is bound once, and the index is built once.
    const slots: Record<string, FeatureSlotPicks> = {};
    for (const [name, inputs] of Object.entries(request.picks)) {
      const spec = meta.params[name] as FeatureMetaSnapshot['params'][string] & { picker: string };
      for (const input of inputs) {
        if (input.kind === 'entities') {
          slots[name] = {
            picker: spec.picker as FeatureSlotPicks['picker'],
            entities: input.entities,
            chains: input.chains,
            options: CustomFeatureRoute.slotOptions(spec),
          };
        }
      }
    }
    const slotParts: Record<string, CustomPickSource[]> = {};
    if (Object.keys(slots).length > 0) {
      const options = await ctx.synthesisOptionsForFile(ctx.fluidCadServer.getCurrentFileName() || null);
      const synthesis = ctx.fluidCadServer.synthesizeFeatureSlots({ slots }, options, before);
      if (!synthesis) {
        return { status: 404, reason: 'No rendered scene' };
      }
      if (synthesis.ok === false) {
        return { status: 422, reason: synthesis.reason };
      }
      if (synthesis.filePath) {
        files.add(normalizePath(synthesis.filePath));
      }
      const remap = synthesis.producers.map(merge);
      const offset = parts.length;
      for (const part of synthesis.parts) {
        parts.push({
          ...part,
          producer: part.producer === null ? null : remap[part.producer],
          refs: part.refs ? part.refs.map(i => remap[i]) : part.refs,
        });
      }
      for (const symbol of synthesis.imports) {
        imports.add(symbol);
      }
      for (const [name, slot] of Object.entries(synthesis.slots)) {
        slotParts[name] = slot.parts.map(part => ({ kind: slot.wrap ?? 'part', part: offset + part }));
        args[name] = slot.args;
      }
    }

    for (const [name, inputs] of Object.entries(request.picks)) {
      const spec = meta.params[name] as FeatureMetaSnapshot['params'][string] & { picker: string };
      const items: CustomPickSource[] = [];
      for (const input of inputs) {
        const item = CustomFeatureRoute.pickItems(input, spec, slotParts[name] ?? [], merge, files, parsed?.picks[name]);
        if ('reason' in item) {
          return item;
        }
        items.push(...item.items);
      }
      out[name] = { kind: 'picks', items };
    }

    let scope: CustomFeatureOptions['scope'];
    const scopeTarget = (loc: SketchLoc) => {
      files.add(normalizePath(loc.filePath));
      return { kind: 'feature' as const, producer: merge({ line: loc.line, column: loc.column, featureType: 'feature', nameHint: 'f', bind: true }) };
    };
    if (request.scopeEdits !== undefined) {
      scope = request.scopeEdits.map(target => target.kind === 'verbatim'
        ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
        : scopeTarget(target.loc));
    } else if (request.scope.length > 0) {
      scope = request.scope.map(scopeTarget);
    }

    if (files.size > 1) {
      return { status: 422, reason: 'the picks come from features in different files' };
    }
    return {
      producers, parts, imports: [...imports], values: out, scope, args,
      filePath: files.size === 1 ? files.values().next().value! : null,
    };
  }

  /** The elements one pick input writes. */
  private static pickItems(
    input: CustomPickInput,
    spec: FeatureMetaSnapshot['params'][string] & { picker: string },
    synthesized: CustomPickSource[],
    merge: ReturnType<typeof makeProducerMerger>['merge'],
    files: Set<string>,
    own: ParsedCustomFeature['picks'][string] | undefined,
  ): { items: CustomPickSource[] } | Refusal {
    if (input.kind === 'entities') {
      return { items: synthesized };
    }
    if (input.kind === 'standard') {
      return { items: [{ kind: 'standard', name: input.name }] };
    }
    if (input.kind === 'verbatim') {
      if (!own || input.sourceIndex >= own.length) {
        return { status: 422, reason: `${spec.label}: a kept pick no longer matches the statement — re-open the dialog` };
      }
      return { items: [{ kind: 'verbatim', sourceIndex: input.sourceIndex }] };
    }
    const producer = CustomFeatureInputs.statementProducer(spec.picker, spec)!;
    files.add(normalizePath(input.loc.filePath));
    return {
      items: [{
        kind: 'producer',
        producer: merge({ line: input.loc.line, column: input.loc.column, featureType: producer.featureType, nameHint: producer.nameHint, bind: true }),
      }],
    };
  }

  /** What a geometry picker declares that the slot synthesis checks. */
  private static slotOptions(spec: FeatureMetaSnapshot['params'][string]): FeatureSlotPicks['options'] {
    const declared = spec as { label: string; multiple?: boolean; max?: number; surface?: never; curve?: never; facesAsEdges?: boolean };
    return {
      label: declared.label,
      ...(declared.multiple !== undefined ? { multiple: declared.multiple } : {}),
      ...(declared.max !== undefined ? { max: declared.max } : {}),
      ...(declared.surface !== undefined ? { surface: declared.surface } : {}),
      ...(declared.curve !== undefined ? { curve: declared.curve } : {}),
      ...(declared.facesAsEdges !== undefined ? { facesAsEdges: declared.facesAsEdges } : {}),
    };
  }
}
