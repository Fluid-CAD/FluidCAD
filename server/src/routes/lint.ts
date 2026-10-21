import { Router } from 'express';
import { lintFluidJs } from '../lint-fluid-js.ts';
import { isParamsFile } from '../file-kind.ts';
import { readDeclaredUnit } from '../file-unit.ts';
import type { LengthUnit } from '../project-config.ts';
import type { NumericGlobal } from '../unit-lint.ts';

export type LintRouterDeps = {
  /** The project's document unit, read live. */
  projectUnit?: () => LengthUnit;
  /** The project parameters (`GlobalParamCatalog.list()`), for the unit rule on their reads. */
  globals?: () => Promise<readonly NumericGlobal[]>;
};

/**
 * `POST /api/lint-fluid-js` — static import lint for a `.fluid.js` payload.
 * Used by the MCP server before it writes a file so the agent learns to add
 * imports on retry instead of failing at runtime with `ReferenceError`.
 *
 * Request body: `{ code: string, filePath?: string }` — the path lets the
 *               `unit()` rules know an assembly file when they see one.
 * Response:     `{ missing: MissingImport[], suggestion: string, diagnostics: LintDiagnostic[] }`
 */
export function createLintRouter(deps: LintRouterDeps = {}): Router {
  const router = Router();

  router.post('/lint-fluid-js', async (req, res) => {
    const { code, filePath } = req.body ?? {};
    if (typeof code !== 'string') {
      res.status(400).json({ error: '`code` must be a string.' });
      return;
    }
    try {
      const path = typeof filePath === 'string' ? filePath : undefined;
      // The unit rule on project-parameter reads needs the file's unit and
      // the catalog; a params file has no unit of its own and is skipped.
      const globalUnits = path && !isParamsFile(path) && deps.projectUnit && deps.globals
        ? { fileUnit: await readDeclaredUnit(code), projectUnit: deps.projectUnit(), globals: await deps.globals() }
        : undefined;
      const result = await lintFluidJs(code, { filePath: path, globalUnits });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
