import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { InterferenceRequest } from '../../../lib/dist/index.js';
import { PoseRequests } from './measure.ts';

const MAX_SHAPE_IDS = 500;
const MAX_INSTANCE_IDS = 500;

/**
 * Body validation for `/interfere` and the HTTP status each refusal maps
 * to. Mirrors ValidateRequests so the inspection routes refuse the same way.
 */
export class InterfereRequests {

  /** The error naming what is wrong with the body, or null when it is usable. */
  static bodyError(body: unknown): string | null {
    if (body === undefined || body === null) {
      return null;
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
      return 'body must be an object: { instanceIds?: string[], shapeIds?: string[], tolerance?: number, poses?: { instanceId, position, quaternion }[] }';
    }
    const { instanceIds, shapeIds, tolerance, poses } = body as {
      instanceIds?: unknown; shapeIds?: unknown; tolerance?: unknown; poses?: unknown;
    };
    const idsError = InterfereRequests.idListError('shapeIds', shapeIds, MAX_SHAPE_IDS)
      ?? InterfereRequests.idListError('instanceIds', instanceIds, MAX_INSTANCE_IDS);
    if (idsError) {
      return idsError;
    }
    if (tolerance !== undefined && (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0)) {
      return 'tolerance must be a finite number >= 0 (a volume in the document unit cubed)';
    }
    if (poses !== undefined) {
      if (!Array.isArray(poses) || poses.length === 0 || poses.length > MAX_INSTANCE_IDS) {
        return `poses must be an array of 1-${MAX_INSTANCE_IDS} instance poses`;
      }
      for (const pose of poses) {
        const instanceId = (pose as { instanceId?: unknown } | null)?.instanceId;
        if (typeof instanceId !== 'string' || instanceId.length === 0) {
          return 'poses entries need a non-empty instanceId';
        }
        if (!PoseRequests.isPose(pose)) {
          return `poses entries need ${PoseRequests.DESCRIPTION}`;
        }
      }
    }
    return null;
  }

  private static idListError(field: string, value: unknown, max: number): string | null {
    if (value === undefined) {
      return null;
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
      return `${field} must be an array of 1-${max} ids`;
    }
    if (!value.every(id => typeof id === 'string' && id.length > 0)) {
      return `${field} entries must be non-empty strings`;
    }
    return null;
  }

  static asRequest(body: unknown): InterferenceRequest {
    const { instanceIds, shapeIds, tolerance, poses } = (body ?? {}) as {
      instanceIds?: string[];
      shapeIds?: string[];
      tolerance?: number;
      poses?: InterferenceRequest['poses'];
    };
    return {
      ...(instanceIds ? { instanceIds } : {}),
      ...(shapeIds ? { shapeIds } : {}),
      ...(tolerance !== undefined ? { tolerance } : {}),
      ...(poses
        ? { poses: poses.map(p => ({ instanceId: p.instanceId, position: p.position, quaternion: p.quaternion })) }
        : {}),
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
 * POST /interfere — shared volume between bodies of the current scene (see
 * the lib's SceneInterference): clashes between parts or instances, intra-part
 * overlaps reported separately, inconclusive when fewer than two parts.
 * A clash or an inconclusive check is a 200 with `ok: false`; an unknown
 * shape or instance, or no rendered scene, is a 404; an engine without the
 * checker a 501.
 */
export function createInterfereRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/interfere', (req, res) => {
    const bodyError = InterfereRequests.bodyError(req.body);
    if (bodyError) {
      res.status(400).json({ error: bodyError });
      return;
    }

    try {
      const outcome = fluidCadServer.interfere(InterfereRequests.asRequest(req.body));
      if (outcome.kind === 'refused') {
        res.status(InterfereRequests.statusFor(outcome.code)).json({ error: outcome.reason, code: outcome.code });
        return;
      }
      res.json(outcome.report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
