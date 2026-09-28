import { Router, type Response } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
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
): Router {
  const router = Router();

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
   * What the panel needs before offering to edit or delete a declaration:
   * the value's source text (the dialog's seed), the variable it
   * binds and how much of the model reads it.
   */
  router.get('/properties/usage', async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const line = Number(req.query.line);
    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
    if (name === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    // Only the file being rendered is readable from here — a declaration in
    // a sibling file still edits fine through the host, so report "nothing
    // known" rather than a refusal it does not deserve.
    if (filePath !== '' && filePath !== fluidCadServer.getCurrentFileName()) {
      res.json({ name, expression: null, variable: null, references: 0, referenceLines: [], editable: true });
      return;
    }
    const code = fluidCadServer.getCurrentCode();
    if (code === null) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    try {
      res.json(await PropertyEditor.inspect(code, name, Number.isInteger(line) ? line : undefined));
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
    await dispatchPropertyEdit(res, {
      kind: 'update',
      expectedName: name,
      line: Number.isInteger(line) ? line : undefined,
      property: spec,
    }, typeof filePath === 'string' ? filePath : undefined);
  });

  router.post('/properties/remove', async (req, res) => {
    const { name, line, filePath } = req.body ?? {};
    if (typeof name !== 'string' || name === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await dispatchPropertyEdit(res, {
      kind: 'remove',
      expectedName: name,
      line: Number.isInteger(line) ? line : undefined,
    }, typeof filePath === 'string' ? filePath : undefined);
  });

  return router;
}
