import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { SelectionRequests } from './selection-requests.ts';

/**
 * POST /resolve-selection — evaluate a filter expression against the current
 * scene with the candidate set a `select()` statement sees at the given scope
 * (see the lib's SelectionResolver). Zero matches is a 200; an unknown
 * scope, an ambiguous part name or an expression that does not evaluate is a
 * 4xx naming the problem.
 */
export function createResolveSelectionRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/resolve-selection', (req, res) => {
    const { expression, scope } = req.body ?? {};
    const expressionError = SelectionRequests.expressionError(expression);
    if (expressionError) {
      res.status(400).json({ error: expressionError });
      return;
    }
    const scopeError = SelectionRequests.scopeError(scope);
    if (scopeError) {
      res.status(400).json({ error: scopeError });
      return;
    }

    try {
      const result = fluidCadServer.resolveSelection({ expression, scope: SelectionRequests.asScope(scope) });
      if (result.ok === false) {
        const candidates = 'candidates' in result ? result.candidates : undefined;
        res.status(SelectionRequests.statusFor(result.code)).json({
          error: result.reason,
          code: result.code,
          ...(candidates ? { candidates } : {}),
        });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
