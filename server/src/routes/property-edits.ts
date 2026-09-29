import { Router, type Response } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { DeclarationRefactor } from '../declaration-refactor.ts';
import { DeclarationRewrite } from '../declaration-rewrite.ts';
import { declaresName } from '../code-editor/declaration-calls.ts';
import {
  PropertyEditor,
  type PropertyEditSpec,
  type PropertyPartTarget,
  type PropertySpec,
} from '../property-edit.ts';

/**
 * The declaration the panel wants written, or null when the request body
 * cannot describe one. Shape only — whether the expression is writable is
 * `PropertyEditor`'s call, so the route and the editor agree on one verdict.
 */
function validPropertySpec(input: unknown): PropertySpec | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const expression = typeof raw.expression === 'string' ? raw.expression.trim() : '';
  if (name === '' || expression === '') {
    return null;
  }
  return { name, expression };
}

/**
 * The `part()` statement a new declaration goes into — the Add dialog's Part
 * choice, as `{filePath, line, column}` of the statement the render captured.
 */
function validPartLocation(input: unknown): (PropertyPartTarget & { filePath: string }) | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const { filePath, line, column } = input as Record<string, unknown>;
  if (typeof filePath !== 'string' || filePath === '') {
    return null;
  }
  if (!Number.isInteger(line) || (line as number) < 1 || !Number.isInteger(column) || (column as number) < 0) {
    return null;
  }
  return { filePath, line: line as number, column: column as number };
}

/**
 * Declaration edits for `property()` calls — the parameters panel's
 * Properties rows writing the source. Mirrors the `/params/*` declaration
 * routes: every edit rides the shared apply-feature-edit round trip, so the
 * host rewrites its live buffer and the resulting save re-renders.
 */
export function createPropertyEditsRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
  workspacePath = '',
): Router {
  const router = Router();
  // A rename or delete reaches every file that reads the property through
  // `.properties.<name>`, sent ahead of the declaring file's own edit.
  const refactor = new DeclarationRefactor(fluidCadServer, workspacePath, dispatcher);

  async function dispatchPropertyEdit(res: Response, propertyEdit: PropertyEditSpec, declaringFile?: string): Promise<void> {
    // The edit follows the declaration's file, not the file on screen; a
    // new declaration has no home yet and lands in the chosen part's file.
    const filePath = declaringFile || fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      propertyEdit,
    };
    await dispatcher.dispatch(res, spec, { success: true });
  }

  /**
   * What the panel needs before editing or deleting a declaration: the
   * value's source text (the dialog's seed), the variable it binds, every
   * file that reads the property, and what a delete would put in place of
   * those reads — or which of them it cannot.
   */
  router.get('/properties/usage', async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const line = Number(req.query.line);
    const filePath = typeof req.query.filePath === 'string' && req.query.filePath !== ''
      ? req.query.filePath
      : fluidCadServer.getCurrentFileName();
    if (name === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const code = filePath ? await refactor.readFile(filePath) : null;
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    try {
      const usage = await PropertyEditor.inspect(code, name, Number.isInteger(line) ? line : undefined, filePath);
      res.json(await refactor.extendReport(usage));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/properties/add', async (req, res) => {
    const spec = validPropertySpec(req.body?.property);
    if (spec === null) {
      res.status(400).json({ error: 'a well-formed property is required' });
      return;
    }
    const part = validPartLocation(req.body?.part);
    if (!part) {
      res.status(400).json({
        error: 'part must be {filePath, line, column} of the part() statement the property is declared in',
      });
      return;
    }
    await dispatchPropertyEdit(res, {
      kind: 'add',
      property: spec,
      part: { line: part.line, column: part.column },
    }, part.filePath);
  });

  router.post('/properties/update', async (req, res) => {
    const { name, line, filePath, property } = req.body ?? {};
    const spec = validPropertySpec(property);
    if (typeof name !== 'string' || name === '' || spec === null) {
      res.status(400).json({ error: 'name and a well-formed property are required' });
      return;
    }
    const declaringFile = typeof filePath === 'string' && filePath !== '' ? filePath : fluidCadServer.getCurrentFileName();
    const at = Number.isInteger(line) ? line : undefined;
    let variable: string | undefined;
    if (spec.name !== name) {
      // A renamed property renames the const it binds after itself, and
      // every other file's `.properties.<name>` reads follow first.
      const code = declaringFile ? await refactor.readFile(declaringFile) : null;
      if (code === null) {
        res.status(404).json({ error: 'No active scene' });
        return;
      }
      const planned = await PropertyEditor.plan(code, name, at, declaringFile);
      if ('error' in planned) {
        res.status(422).json({ success: false, reason: planned.error });
        return;
      }
      const { plan, tree } = planned;
      const current = plan.declaration.variable;
      if (current !== null && current !== spec.name && !declaresName(tree, spec.name)) {
        variable = spec.name;
      }
      const newVariable = variable ?? null;
      const newExport = newVariable !== null && plan.declaration.variableExport === current
        ? newVariable
        : plan.declaration.variableExport;
      const specs = await refactor.renameSpecs(plan.declaration, spec.name, newVariable, newExport);
      if (!await refactor.dispatchConsumers(res, specs)) {
        return;
      }
    }
    await dispatchPropertyEdit(res, {
      kind: 'update',
      expectedName: name,
      line: at,
      property: spec,
      ...(variable !== undefined ? { variable } : {}),
    }, declaringFile);
  });

  router.post('/properties/remove', async (req, res) => {
    const { name, line, filePath } = req.body ?? {};
    if (typeof name !== 'string' || name === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const declaringFile = typeof filePath === 'string' && filePath !== '' ? filePath : fluidCadServer.getCurrentFileName();
    const at = Number.isInteger(line) ? line : undefined;
    // The value stands in for every read of the property, in every file.
    // Where it cannot — it names the part's own parameters — the whole
    // delete is refused before any file changes.
    const code = declaringFile ? await refactor.readFile(declaringFile) : null;
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    const planned = await PropertyEditor.plan(code, name, at, declaringFile);
    if ('error' in planned) {
      res.status(422).json({ success: false, reason: planned.error });
      return;
    }
    const { plan, tree, declaration } = planned;
    const refusal = DeclarationRewrite.inlineRefusal(tree, 'property', declaration, plan);
    if (refusal) {
      res.status(422).json({ success: false, reason: refusal });
      return;
    }
    const consumers = await refactor.inlineSpecs(plan.declaration, plan.value, plan.portable);
    if ('error' in consumers) {
      res.status(422).json({ success: false, reason: consumers.error });
      return;
    }
    if (!await refactor.dispatchConsumers(res, consumers.specs)) {
      return;
    }
    await dispatchPropertyEdit(res, { kind: 'remove', expectedName: name, line: at }, declaringFile);
  });

  return router;
}
