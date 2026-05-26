import { Router } from 'express';
import { lintFluidJs } from '../lint-fluid-js.ts';

/**
 * `POST /api/lint-fluid-js` — static import lint for a `.fluid.js` payload.
 * Used by the MCP server before it writes a file so the agent learns to add
 * imports on retry instead of failing at runtime with `ReferenceError`.
 *
 * Request body: `{ code: string }`
 * Response:     `{ missing: MissingImport[], suggestion: string }`
 */
export function createLintRouter(): Router {
  const router = Router();

  router.post('/lint-fluid-js', async (req, res) => {
    const { code } = req.body ?? {};
    if (typeof code !== 'string') {
      res.status(400).json({ error: '`code` must be a string.' });
      return;
    }
    try {
      const result = await lintFluidJs(code);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
