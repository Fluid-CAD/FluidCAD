// POST /apply-feature, custom features: a create, and the in-place edit of a statement — both through the feature's call shape.

import type { Request, Response } from 'express';
import {
  CustomFeatureImport,
  CustomFeaturePoints,
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
import type { FeatureMetaSnapshot, FeatureSlotPicks, FeatureSlotResult } from '../../../../../lib/dist/index.js';
import type { SelectionBoundary } from '../../../fluidcad-server/index.ts';
import { detectKind } from '../../../file-kind.ts';
import { normalizePath } from '../../../normalize-path.ts';
import type { FeatureCatalogEntry } from '../../../feature-catalog/catalog.ts';
import { PackageAdoption } from '../../../packages/package-adoption.ts';
import { validateBoundary } from '../picks.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { CustomFeatureInputs, validateCustomRequest, type CustomFeatureRequest, type CustomPickInput } from '../validate/custom.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

/** A refusal the handler answers with. */
type Refusal = { status: number; reason: string };

/**
 * One synthesized slot as the elements it writes: a face or edge value's
 * parts, all taken by its one entities pick; a point or anchor value's
 * elements, one per pick.
 */
type SynthesizedSlot = {
  all: CustomPickSource[];
  texts: string[];
  points: { item: CustomPickSource; text: string }[];
};

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
    // The import the file writes: the package's bare name for a package's
    // feature (K7), a relative path for a workspace module.
    const importFrom = CustomFeatureRoute.importFrom(ctx, entry, filePath);
    if ('reason' in importFrom) {
      res.status(importFrom.status).json({ success: false, reason: importFrom.reason });
      return;
    }
    const custom: CustomFeatureOptions = {
      id: meta.id,
      exportName: entry.exportName!,
      modulePath: entry.modulePath,
      ...(importFrom.specifier !== undefined ? { importFrom: importFrom.specifier } : {}),
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

    // Truthful preview: the sketch exports a picked sketch point needs staged
    // the way the transform stages them, the callee the import plan names
    // and the variables the transform's binding walk allocates.
    const code = CustomFeatureRoute.codeFor(ctx, filePath);
    const staged = code ? await CustomFeaturePoints.prepare(code, spec) : { code, spec };
    if ('error' in staged) {
      res.status(422).json({ success: false, reason: staged.error });
      return;
    }
    const callee = staged.code
      ? (await CustomFeatureImport.plan(staged.code, filePath, custom.exportName!, custom.modulePath!, custom.importFrom)).local
      : custom.exportName!;
    const vars = await allocateProducerVars(staged.spec.producers, staged.code, await ctx.currentCallees());
    const rendered = CustomFeatureStatement.render(callee, staged.spec.custom!, staged.spec, i => vars[i] ?? null);
    if ('error' in rendered) {
      res.status(422).json({ success: false, reason: rendered.error });
      return;
    }
    if (preview === true) {
      res.json({ success: true, preview: rendered.statement, args: picks.args });
      return;
    }
    // A library package's feature pins its package first (K7): once the
    // preflight has accepted the edit, before the editor writes it.
    const adopt = ctx.catalog?.adoptForUse;
    await dispatcher.dispatch(res, spec, { success: true, preview: rendered.statement }, adopt && entry.package?.availability === 'library'
      ? { beforeSend: PackageAdoption.step(() => adopt.call(ctx.catalog, entry)) }
      : {});
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
  const repicks = Object.values(request.picks)
    .some(inputs => inputs.some(input => input.kind === 'entities' || input.kind === 'point' || input.kind === 'anchor'));
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
    const staged = await CustomFeaturePoints.prepare(code, spec);
    if ('error' in staged) {
      res.status(422).json({ success: false, reason: staged.error });
      return;
    }
    const vars = await allocateProducerVars(staged.spec.producers, staged.code, callees);
    const rendered = renderEditedStatement(parsed.parsed, staged.spec, i => vars[i] ?? null);
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

  /**
   * The specifier `filePath` imports the entry's builder by, from the
   * catalog; undefined when the catalog doesn't say (the transform then
   * writes the module's relative path); a refusal when the file can't
   * reach it — a package module its entry doesn't export, or another
   * version than the project pins.
   */
  static importFrom(
    ctx: ApplyFeatureRequestContext,
    entry: FeatureCatalogEntry,
    filePath: string,
  ): { specifier: string | undefined } | Refusal {
    const catalog = ctx.catalog;
    if (!catalog?.importSpecifier) {
      return { specifier: undefined };
    }
    const specifier = catalog.importSpecifier(entry, filePath);
    if (specifier === null) {
      return { status: 422, reason: catalog.unreachableReason?.(entry) ?? `feature '${entry.id}' can't be imported here` };
    }
    return { specifier };
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
   * writes: geometry, points and anchors synthesized in one pass over every
   * slot (an edit's against the world before its statement), statements —
   * connectors among them — bound by call site, world axes and planes by
   * name, an edit's keeps by position. Folded with the typed-in `values` and
   * the scope into one spec. A value of several kinds asks the synthesis for
   * one slot per kind and gets its elements back in the order they were
   * picked.
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
      const spec = meta.params[name];
      for (const [key, slot] of Object.entries(CustomFeatureRoute.slotsOf(name, spec, inputs))) {
        slots[key] = slot;
      }
    }
    const synthesized: Record<string, SynthesizedSlot> = {};
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
      for (const [key, slot] of Object.entries(synthesis.slots)) {
        synthesized[key] = CustomFeatureRoute.slotItems(slot, offset, remap);
      }
    }

    for (const [name, inputs] of Object.entries(request.picks)) {
      const spec = meta.params[name] as FeatureMetaSnapshot['params'][string] & { picker: string | string[] };
      const items: CustomPickSource[] = [];
      const texts: string[] = [];
      // Points and anchors come back one per pick, in pick order: each input takes the next.
      const taken: Record<string, number> = {};
      for (const input of inputs) {
        const item = CustomFeatureRoute.pickItems(name, input, spec, synthesized, taken, merge, files, parsed?.picks[name]);
        if ('reason' in item) {
          return item;
        }
        items.push(...item.items);
        texts.push(...item.texts);
      }
      out[name] = { kind: 'picks', items };
      if (texts.length > 0) {
        args[name] = texts;
      }
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

  /**
   * The synthesis slots one value's picks ask for: its faces or edges as one
   * slot (split by sub-shape when the value takes both as different kinds),
   * its points as one, its anchors as one — keyed by the value's name alone
   * when it takes one kind, else by name and kind.
   */
  private static slotsOf(
    name: string,
    spec: FeatureMetaSnapshot['params'][string],
    inputs: CustomPickInput[],
  ): Record<string, FeatureSlotPicks> {
    const kinds = CustomFeatureInputs.kindsOf(spec);
    const keyOf = (kind: string) => kinds.length === 1 ? name : `${name}#${kind}`;
    const options = CustomFeatureRoute.slotOptions(spec, kinds.length > 1);
    const slots: Record<string, FeatureSlotPicks> = {};
    for (const input of inputs) {
      if (input.kind === 'entities') {
        const subs = [...new Set(input.entities.map(pick => pick.sub.type))];
        for (const sub of subs) {
          const kind = CustomFeatureInputs.geometryKind(spec, sub)!;
          const key = keyOf(kind);
          const ofSub = (pick: { sub: { type: string } }) => kinds.length === 1 || pick.sub.type === sub;
          slots[key] = {
            picker: kind as FeatureSlotPicks['picker'],
            entities: input.entities.filter(ofSub),
            options,
          };
        }
      } else if (input.kind === 'point') {
        const slot = slots[keyOf('point')] ??= { picker: 'point', entities: [], options };
        slot.entities.push(input.entity);
      } else if (input.kind === 'anchor') {
        const slot = slots[keyOf('anchor')] ??= { picker: 'anchor', entities: [], anchors: [], options };
        slot.entities.push(input.entity);
        slot.anchors!.push(input.anchor);
      }
    }
    return slots;
  }

  /** One synthesized slot as the elements it writes: its parts in order, or (points and anchors) one element per pick. */
  private static slotItems(slot: FeatureSlotResult, offset: number, remap: number[]): SynthesizedSlot {
    if (!slot.points) {
      return { all: slot.parts.map(part => ({ kind: slot.wrap ?? 'part', part: offset + part })), texts: slot.args, points: [] };
    }
    const points = slot.points.map((point, i): { item: CustomPickSource; text: string } => ({
      item: 'part' in point
        ? { kind: 'part', part: offset + point.part, suffix: point.suffix }
        : { kind: 'sketchPoint', producer: remap[point.sketch], target: point.target },
      text: slot.args[i],
    }));
    return { all: [], texts: [], points };
  }

  /** The elements one pick input writes, and how the preview names them. */
  private static pickItems(
    name: string,
    input: CustomPickInput,
    spec: FeatureMetaSnapshot['params'][string] & { picker: string | string[] },
    synthesized: Record<string, SynthesizedSlot>,
    taken: Record<string, number>,
    merge: ReturnType<typeof makeProducerMerger>['merge'],
    files: Set<string>,
    own: ParsedCustomFeature['picks'][string] | undefined,
  ): { items: CustomPickSource[]; texts: string[] } | Refusal {
    const kinds = CustomFeatureInputs.kindsOf(spec);
    const keyOf = (kind: string) => kinds.length === 1 ? name : `${name}#${kind}`;
    switch (input.kind) {
      case 'entities': {
        const subs = [...new Set(input.entities.map(pick => pick.sub.type))];
        const slotsOfSubs = [...new Set(subs.map(sub => keyOf(CustomFeatureInputs.geometryKind(spec, sub)!)))];
        return {
          items: slotsOfSubs.flatMap(key => synthesized[key]?.all ?? []),
          texts: slotsOfSubs.flatMap(key => synthesized[key]?.texts ?? []),
        };
      }
      case 'point':
      case 'anchor': {
        const key = keyOf(input.kind);
        const at = taken[key] ?? 0;
        taken[key] = at + 1;
        const point = synthesized[key]?.points[at];
        if (!point) {
          return { status: 422, reason: `${spec.label}: the ${input.kind} was not named — re-pick it` };
        }
        return { items: [point.item], texts: [point.text] };
      }
      case 'standard':
        return { items: [{ kind: 'standard', name: input.name }], texts: [`'${input.name}'`] };
      case 'verbatim':
        if (!own || input.sourceIndex >= own.length) {
          return { status: 422, reason: `${spec.label}: a kept pick no longer matches the statement — re-open the dialog` };
        }
        return { items: [{ kind: 'verbatim', sourceIndex: input.sourceIndex }], texts: [own[input.sourceIndex].text] };
      default: {
        const kind = CustomFeatureInputs.statementKind(spec, input)!;
        const producer = CustomFeatureInputs.statementProducer(kind, spec)!;
        files.add(normalizePath(input.loc.filePath));
        const item: CustomPickSource = {
          kind: 'producer',
          producer: merge({ line: input.loc.line, column: input.loc.column, featureType: producer.featureType, nameHint: producer.nameHint, bind: true }),
          ...(input.slot !== undefined ? { instance: input.slot } : {}),
        };
        return { items: [item], texts: [] };
      }
    }
  }

  /**
   * What a picker declares that the slot synthesis checks. A value of
   * several kinds counts its picks across them, here: each kind's slot is a
   * list as the value is, without its `max`.
   */
  private static slotOptions(spec: FeatureMetaSnapshot['params'][string], union: boolean): FeatureSlotPicks['options'] {
    const declared = spec as {
      label: string; multiple?: boolean; max?: number; ordered?: boolean; surface?: never; curve?: never; facesAsEdges?: boolean; anchors?: never;
    };
    const list = declared.multiple === true || declared.max !== undefined;
    return {
      label: declared.label,
      ...(union ? (list ? { multiple: true } : {}) : {
        ...(declared.multiple !== undefined ? { multiple: declared.multiple } : {}),
        ...(declared.max !== undefined ? { max: declared.max } : {}),
      }),
      ...(declared.ordered === true ? { ordered: true } : {}),
      ...(declared.surface !== undefined ? { surface: declared.surface } : {}),
      ...(declared.curve !== undefined ? { curve: declared.curve } : {}),
      ...(declared.facesAsEdges !== undefined ? { facesAsEdges: declared.facesAsEdges } : {}),
      ...(declared.anchors !== undefined ? { anchors: declared.anchors } : {}),
    };
  }
}
