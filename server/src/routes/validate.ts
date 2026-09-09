import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { ValidateSceneRequest } from '../../../lib/dist/index.js';

const MAX_SHAPE_IDS = 500;

/**
 * Body validation for `/validate` and the HTTP status each refusal maps to.
 * Mirrors SelectionRequests so the inspection routes refuse the same way.
 */
export class ValidateRequests {

  /** The error naming what is wrong with the body, or null when it is usable. */
  static bodyError(body: unknown): string | null {
    if (body === undefined || body === null) {
      return null;
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
      return 'body must be an object: { shapeIds?: string[], instanceId?: string }';
    }
    const { shapeIds, instanceId } = body as { shapeIds?: unknown; instanceId?: unknown };
    if (shapeIds !== undefined) {
      if (!Array.isArray(shapeIds) || shapeIds.length === 0 || shapeIds.length > MAX_SHAPE_IDS) {
        return `shapeIds must be an array of 1-${MAX_SHAPE_IDS} shape ids`;
      }
      if (!shapeIds.every(id => typeof id === 'string' && id.length > 0)) {
        return 'shapeIds entries must be non-empty strings';
      }
    }
    if (instanceId !== undefined && (typeof instanceId !== 'string' || instanceId.length === 0)) {
      return 'instanceId must be a non-empty string';
    }
    return null;
  }

  static asRequest(body: unknown): ValidateSceneRequest {
    const { shapeIds, instanceId } = (body ?? {}) as { shapeIds?: string[]; instanceId?: string };
    return {
      ...(shapeIds ? { shapeIds } : {}),
      ...(instanceId !== undefined ? { instanceId } : {}),
    };
  }

  /** HTTP status for a refusal: nothing to examine (404), or an engine that cannot (501). */
  static statusFor(code: string): number {
    switch (code) {
      case 'no-scene':
      case 'unknown-shape':
      case 'unknown-instance':
      case 'not-an-assembly':
        return 404;
      case 'unsupported':
        return 501;
      default:
        return 422;
    }
  }
}

/**
 * POST /validate — kernel soundness of the shapes the current scene renders
 * (see the lib's SceneValidator): topology, shell closure, per-solid volume
 * sign. Findings are a 200 with `ok: false`; an unknown shape or instance,
 * or no rendered scene, is a 404; an engine without the validator a 501.
 */
export function createValidateRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/validate', (req, res) => {
    const bodyError = ValidateRequests.bodyError(req.body);
    if (bodyError) {
      res.status(400).json({ error: bodyError });
      return;
    }

    try {
      const outcome = fluidCadServer.validate(ValidateRequests.asRequest(req.body));
      if (outcome.kind === 'refused') {
        res.status(ValidateRequests.statusFor(outcome.code)).json({ error: outcome.reason, code: outcome.code });
        return;
      }
      res.json(outcome.report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
