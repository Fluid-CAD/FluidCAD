import { Router, type Response } from 'express';
import { isAbsolute, join } from 'path';
import { coerceParamOverride } from '../../../lib/dist/index.js';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import type { DeclarationRefactor } from '../declaration-refactor.ts';
import { DeclarationRewrite } from '../declaration-rewrite.ts';
import { isParamsFile, newFileContent } from '../file-kind.ts';
import type { GlobalParam, GlobalParamCatalog, GlobalParamValue } from '../global-params/catalog.ts';
import { normalizePath } from '../normalize-path.ts';
import { ParamEditor, type ParamEditSpec, type ParamSpec } from '../param-edit.ts';
import type { LiveRenderOptions, RenderOutcome } from './render.ts';

/**
 * The global-parameters routes (`docs/global-parameters-plan.md` §2.5, §2.6).
 *
 * `GET /global-params` answers the catalog's snapshot — every `*.params.js`
 * file's rows and the project unit.
 *
 * `POST /global-params/set { file, label, value }` changes a declaration's
 * default literal in source: a global has no session override (the literal
 * IS the value, in every file that imports it), so the write is a
 * `ParamEditor.update` that keeps the label, type and options and swaps
 * only the default. With an editor host attached the edit rides the shared
 * apply-feature-edit round trip, so the host applies it to its live buffer
 * (Monaco undo works) and its own live-update re-renders the open model as
 * a dependency update. Without one — `fluidcad serve` driven by an agent,
 * the CLI alone — the route writes the file to disk itself and folds it
 * into the open model with `keepCurrent`, never switching the viewport to
 * the params file.
 */
export type GlobalParamsRouterDeps = {
  catalog: GlobalParamCatalog;
  dispatcher: FeatureEditDispatcher;
  workspacePath: string;
  /** Whether an editor host announced itself — the edit is dispatched to it; otherwise the route writes the disk. */
  hasEditorHost: () => boolean;
  /** A file's current text as the server sees it: the live buffer, else the disk. Null when unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
  /** Put `code` on disk for the no-host path — recorded so the watchers' echo of it is ignored. */
  writeFile: (absPath: string, code: string) => Promise<void>;
  /** Re-render the open model against the new text (`keepCurrent`); the no-host path. */
  runLiveRender: (fileName: string, code: string, options: Partial<LiveRenderOptions>) => Promise<RenderOutcome>;
  /** The file's declarations changed — refresh the catalog and broadcast. */
  onChanged?: (absPath: string) => void | Promise<void>;
};

export function createGlobalParamsRouter(deps: GlobalParamsRouterDeps): Router {
  const router = Router();

  router.get('/global-params', async (_req, res) => {
    try {
      res.json(await deps.catalog.snapshot());
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/global-params/set', async (req, res) => {
    const { file, label, value } = req.body ?? {};
    if (typeof file !== 'string' || file === '' || typeof label !== 'string' || label === '') {
      res.status(400).json({ success: false, reason: '`file` and `label` are required' });
      return;
    }
    if (value === undefined) {
      res.status(400).json({ success: false, reason: '`value` is required' });
      return;
    }
    const absPath = normalizePath(file);
    const workspace = normalizePath(deps.workspacePath);
    if (!isParamsFile(absPath)) {
      res.status(422).json({ success: false, reason: `${absPath} is not a *.params.js file` });
      return;
    }
    if (workspace && absPath !== workspace && !absPath.startsWith(workspace.endsWith('/') ? workspace : `${workspace}/`)) {
      res.status(403).json({ success: false, reason: 'the file is outside the workspace' });
      return;
    }

    let row: GlobalParam | null;
    try {
      const listed = await deps.catalog.fileOf(absPath);
      if (!listed) {
        res.status(404).json({ success: false, reason: `${absPath} is not a params file of this workspace` });
        return;
      }
      row = listed.params.find((p) => p.label === label) ?? null;
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      return;
    }
    if (!row) {
      res.status(404).json({ success: false, reason: `no global parameter labelled "${label}" in ${absPath}` });
      return;
    }
    if (row.derived) {
      res.status(422).json({ success: false, reason: `"${label}" is derived (${row.expression ?? 'an expression'}) — edit it in the code` });
      return;
    }
    if (row.problems?.some((p) => p.includes('not a literal'))) {
      res.status(422).json({ success: false, reason: `the default of "${label}" is not a literal — edit it in the code` });
      return;
    }

    const coerced = coerceParamOverride(row.defaultValue, value) as GlobalParamValue;
    const spec = specOf(row, coerced);
    const paramEdit: ParamEditSpec = { kind: 'update', expectedLabel: label, line: row.line, param: spec };

    // The dispatcher only preflights the rendered file, and a params file is
    // never that — so the refusals (a chained call, a value no option
    // matches) are checked here against the server's copy first.
    const code = await deps.readFile(absPath);
    if (code === null) {
      res.status(404).json({ success: false, reason: `could not read ${absPath}` });
      return;
    }
    const preview = await ParamEditor.apply(code, paramEdit, absPath);
    if (preview.error) {
      res.status(422).json({ success: false, reason: preview.error });
      return;
    }

    if (deps.hasEditorHost()) {
      const edit: ApplyFeatureEditSpec = {
        feature: 'sketch',
        filePath: absPath,
        producers: [],
        parts: [],
        imports: [],
        paramEdit,
      };
      await deps.dispatcher.dispatch(res, edit, { success: true, value: coerced });
      if (res.statusCode < 400) {
        await deps.onChanged?.(absPath);
      }
      return;
    }

    try {
      await deps.writeFile(absPath, preview.newCode);
      const render = await deps.runLiveRender(absPath, preview.newCode, { keepCurrent: true });
      await deps.onChanged?.(absPath);
      res.json({ success: true, value: coerced, render });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  });

  return router;
}

/** An `ApplyFeatureEditSpec` that carries only a `paramEdit` to `filePath`. */
function paramEditSpec(filePath: string, paramEdit: ParamEditSpec): ApplyFeatureEditSpec {
  return { feature: 'sketch', filePath, producers: [], parts: [], imports: [], paramEdit };
}

/**
 * The parameters panel's declaration edits on a `*.params.js` file — the
 * `/params/add|update|remove` routes' global half (`docs/global-parameters-plan.md`
 * §2.4, §3.2). A global is read by every file that imports it, so an edit
 * is a plan over the declaring file plus the consumer files the
 * {@link DeclarationRefactor} finds, committed consumers first and the
 * declaring file last:
 *
 * - with an editor host attached, each file's spec rides the shared
 *   apply-feature-edit round trip, exactly as a part parameter's cross-file
 *   rename does — the host rewrites its live buffers, its saves re-render
 *   the open model as dependency updates (`keepCurrent`);
 * - without one, each file is read (buffer, else disk), transformed here,
 *   written to disk and folded into the open model with `keepCurrent` —
 *   the same path `/global-params/set` takes.
 *
 * Either way the declaring file is dry-run first, so a refusal (a bad
 * identifier, a label the file already carries, a value that cannot stand
 * in for a read) answers before any file changes; and the catalog is told
 * once the declaring file landed.
 */
export class GlobalParamEdits {
  constructor(
    private readonly deps: GlobalParamsRouterDeps,
    private readonly refactor: DeclarationRefactor,
  ) {}

  /**
   * The params file a request names — absolute, or relative to the
   * workspace root — normalized; or the status and reason to refuse it.
   */
  resolveFile(file: unknown): { absPath: string } | { status: number; reason: string } {
    if (typeof file !== 'string' || file.trim() === '') {
      return { status: 400, reason: '`file` must name a *.params.js file' };
    }
    const workspace = normalizePath(this.deps.workspacePath);
    const absPath = normalizePath(isAbsolute(file) || workspace === '' ? file : join(workspace, file));
    if (!isParamsFile(absPath)) {
      return { status: 422, reason: `${absPath} is not a *.params.js file` };
    }
    if (workspace && absPath !== workspace && !absPath.startsWith(workspace.endsWith('/') ? workspace : `${workspace}/`)) {
      return { status: 403, reason: 'the file is outside the workspace' };
    }
    return { absPath };
  }

  /** Whether `file` names a params file — the routes' switch between the part and the global path. */
  static targets(file: unknown): boolean {
    return typeof file === 'string' && isParamsFile(file);
  }

  /**
   * `export const <name> = param(…)` appended to the file — created from the
   * params-file template when it does not exist yet. `spec.name` is the
   * identifier; without one the label's camel-case is used.
   */
  async add(res: Response, absPath: string, spec: ParamSpec): Promise<void> {
    let code = await this.refactor.readFile(absPath);
    let created = false;
    if (code === null) {
      code = newFileContent(absPath);
      created = true;
    }
    // The identifier is settled here, against the file as the server sees
    // it, and carried in the spec — so the host writes the same name the
    // response reports.
    const name = spec.name?.trim() || await ParamEditor.globalNameFor(code, spec.label);
    const paramEdit: ParamEditSpec = { kind: 'add', param: spec, global: true, name };
    const preview = await ParamEditor.apply(code, paramEdit, absPath);
    if (preview.error) {
      res.status(422).json({ success: false, reason: preview.error });
      return;
    }
    if (created) {
      // The host applies edits to a file it can open, so a new file exists
      // on disk before its first edit is dispatched; without a host the
      // transform's output is what gets written below anyway.
      await this.deps.writeFile(absPath, code);
    }
    await this.commit(res, absPath, [], paramEditSpec(absPath, paramEdit), { success: true, name, file: absPath });
  }

  /**
   * Rewrite the declaration's arguments; a changed `spec.name` renames the
   * exported const and, in every consumer, the import specifier and its
   * reads (an aliased import keeps its local name). A changed label only
   * touches the literal — a global has no `insert()` overrides to follow.
   */
  async update(res: Response, absPath: string, label: string, line: number | undefined, spec: ParamSpec): Promise<void> {
    const code = await this.refactor.readFile(absPath);
    if (code === null) {
      res.status(404).json({ success: false, reason: `could not read ${absPath}` });
      return;
    }
    const planned = await ParamEditor.plan(code, label, line, absPath);
    if ('error' in planned) {
      res.status(422).json({ success: false, reason: planned.error });
      return;
    }
    const { plan } = planned;
    const current = plan.declaration.variable;
    const wanted = spec.name?.trim() || undefined;
    const variable = wanted !== undefined && current !== null && wanted !== current ? wanted : undefined;
    const paramEdit: ParamEditSpec = {
      kind: 'update',
      expectedLabel: label,
      line,
      param: spec,
      ...(variable !== undefined ? { variable } : {}),
    };
    const preview = await ParamEditor.apply(code, paramEdit, absPath);
    if (preview.error) {
      res.status(422).json({ success: false, reason: preview.error });
      return;
    }
    let consumers: ApplyFeatureEditSpec[] = [];
    if (variable !== undefined) {
      const newExport = plan.declaration.variableExport === current ? variable : plan.declaration.variableExport;
      consumers = await this.refactor.renameSpecs(plan.declaration, spec.label, variable, newExport);
    }
    await this.commit(res, absPath, consumers, paramEditSpec(absPath, paramEdit), { success: true, name: variable ?? current });
  }

  /**
   * Delete the declaration: its default literal stands in for every read in
   * every consumer, whose import specifier goes with it (the whole import
   * line when it brought nothing else), and for the declaring file's own
   * reads (a derived export). Refused before any file changes when the
   * value would not mean the same where it is read.
   */
  async remove(res: Response, absPath: string, label: string, line: number | undefined): Promise<void> {
    const code = await this.refactor.readFile(absPath);
    if (code === null) {
      res.status(404).json({ success: false, reason: `could not read ${absPath}` });
      return;
    }
    const planned = await ParamEditor.plan(code, label, line, absPath);
    if ('error' in planned) {
      res.status(422).json({ success: false, reason: planned.error });
      return;
    }
    const { plan, tree, declaration } = planned;
    const refusal = DeclarationRewrite.inlineRefusal(tree, 'param', declaration, plan);
    if (refusal) {
      res.status(422).json({ success: false, reason: refusal });
      return;
    }
    const consumers = await this.refactor.inlineSpecs(plan.declaration, plan.value, plan.portable);
    if ('error' in consumers) {
      res.status(422).json({ success: false, reason: consumers.error });
      return;
    }
    const paramEdit: ParamEditSpec = { kind: 'remove', expectedLabel: label, line };
    const preview = await ParamEditor.apply(code, paramEdit, absPath);
    if (preview.error) {
      res.status(422).json({ success: false, reason: preview.error });
      return;
    }
    await this.commit(res, absPath, consumers.specs, paramEditSpec(absPath, paramEdit), { success: true });
  }

  /**
   * Land the edits, consumers first and the declaring file last, through
   * the host when one is attached and onto the disk otherwise; answer the
   * request; tell the catalog. A consumer's refusal stops the sequence with
   * the declaring file untouched, naming how many files already changed.
   */
  private async commit(
    res: Response,
    declaringFile: string,
    consumers: ApplyFeatureEditSpec[],
    declaring: ApplyFeatureEditSpec,
    successBody: Record<string, unknown>,
  ): Promise<void> {
    if (this.deps.hasEditorHost()) {
      if (!await this.refactor.dispatchConsumers(res, consumers)) {
        return;
      }
      await this.deps.dispatcher.dispatch(res, declaring, successBody);
      if (res.statusCode < 400) {
        await this.deps.onChanged?.(declaringFile);
      }
      return;
    }
    const specs = [...consumers, declaring];
    let render: RenderOutcome | undefined;
    try {
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const code = await this.refactor.readFile(spec.filePath);
        if (code === null) {
          res.status(404).json({ success: false, reason: `could not read ${spec.filePath}` });
          return;
        }
        const result = await applyFeatureEdit(code, spec);
        if (result.error) {
          const done = i === 0 ? '' : ` (${i} other file${i === 1 ? '' : 's'} already updated)`;
          res.status(422).json({ success: false, reason: `${spec.filePath.split('/').pop()}: ${result.error}${done}` });
          return;
        }
        await this.deps.writeFile(spec.filePath, result.newCode);
        render = await this.deps.runLiveRender(spec.filePath, result.newCode, { keepCurrent: true });
      }
      await this.deps.onChanged?.(declaringFile);
      res.json({ ...successBody, ...(render ? { render } : {}) });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  }
}

/** The declaration as it is, with only the default changed. */
function specOf(row: GlobalParam, defaultValue: GlobalParamValue): ParamSpec {
  const spec: ParamSpec = { label: row.label, defaultValue, type: row.controlType };
  if (row.description !== undefined) spec.description = row.description;
  if (row.group !== undefined) spec.group = row.group;
  if (row.min !== undefined) spec.min = row.min;
  if (row.max !== undefined) spec.max = row.max;
  if (row.step !== undefined) spec.step = row.step;
  if (row.options !== undefined) spec.options = row.options;
  if (row.multi !== undefined) spec.multi = row.multi;
  if (row.multiControlType !== undefined) spec.multiControlType = row.multiControlType;
  return spec;
}
