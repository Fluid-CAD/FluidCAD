import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { MeasureEntityResolver } from '../measure-entities.ts';
import { SelectionRequests } from './selection-requests.ts';

const MAX_ENTITIES = 8;

function finiteFields(v: unknown, keys: string[]): boolean {
  return typeof v === 'object' && v !== null && keys.every(k => Number.isFinite((v as Record<string, unknown>)[k]));
}

/** The live-pose shape `measure` and `interfere` accept for an assembly instance. */
export class PoseRequests {
  static readonly DESCRIPTION = 'a finite position {x,y,z} and a non-zero quaternion {x,y,z,w}';

  static isPose(v: unknown): boolean {
    if (typeof v !== 'object' || v === null) {
      return false;
    }
    const { position, quaternion } = v as { position?: unknown; quaternion?: unknown };
    if (!finiteFields(position, ['x', 'y', 'z']) || !finiteFields(quaternion, ['x', 'y', 'z', 'w'])) {
      return false;
    }
    const q = quaternion as { x: number; y: number; z: number; w: number };
    return Math.hypot(q.x, q.y, q.z, q.w) > 0;
  }
}

export function createMeasureRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/measure', (req, res) => {
    const entities = req.body?.entities;
    if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_ENTITIES) {
      res.status(400).json({ error: `entities must be an array of 1-${MAX_ENTITIES} face/edge references` });
      return;
    }
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      // Filter form: { expression, scope? } resolves to one face/edge before
      // measuring; pose applies to it as to an index entity.
      if (MeasureEntityResolver.isFilterEntity(entity)) {
        const problem = SelectionRequests.expressionError(entity.expression, `entities[${i}].expression`)
          ?? SelectionRequests.scopeError(entity.scope, `entities[${i}].scope`);
        if (problem) {
          res.status(400).json({ error: problem });
          return;
        }
      } else {
        const validKind = entity?.kind === 'face' || entity?.kind === 'edge';
        const validIndex = Number.isInteger(entity?.index) && entity.index >= 0;
        if (!entity || typeof entity.shapeId !== 'string' || !entity.shapeId || !validKind || !validIndex) {
          res.status(400).json({ error: 'Each entity needs a shapeId, a kind (face|edge) and a non-negative index, or an expression (with optional scope)' });
          return;
        }
      }
      // Assembly entities: the owning instance, and optionally the live
      // world pose the browser-side solver put it at (else the engine
      // measures at the statement pose).
      if (entity.instanceId !== undefined && (typeof entity.instanceId !== 'string' || !entity.instanceId)) {
        res.status(400).json({ error: 'instanceId must be a non-empty string' });
        return;
      }
      if (entity.pose !== undefined && !PoseRequests.isPose(entity.pose)) {
        res.status(400).json({ error: 'pose needs a finite position {x,y,z} and a non-zero quaternion {x,y,z,w}' });
        return;
      }
    }

    try {
      const outcome = fluidCadServer.measureEntities(entities);
      if (outcome.ok === false) {
        res.status(SelectionRequests.statusFor(outcome.code)).json({
          error: outcome.error,
          code: outcome.code,
          ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        });
        return;
      }
      // Every length in the result is in the document's unit — the kernel
      // runs in it — so the response names that unit rather than the
      // caller assuming mm.
      res.json({ ...outcome.result, unit: fluidCadServer.getSceneUnit() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
