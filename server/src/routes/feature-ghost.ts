import { Router } from 'express';
import { extractNumericParams, resolveParamValues } from '../apply-feature-edit.ts';
import type { FeatureGhostRequest, FluidCadServer, GhostAxisRef } from '../fluidcad-server.ts';

/** A dialog numeric slot on the wire: a number, or verbatim expression text. */
type ValueExpr = number | string;

type GhostBody = {
  feature?: unknown;
  op?: unknown;
  distance?: unknown;
  distance2?: unknown;
  symmetric?: unknown;
  draft?: unknown;
  drill?: unknown;
  thin?: unknown;
  angle?: unknown;
  axis?: { kind?: unknown; axis?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  profile?: { filePath?: unknown; line?: unknown };
};

const FEATURES = ['extrude', 'revolve'];

const OPS = ['add', 'remove', 'new'];

const STANDARD_AXES = ['x', 'y', 'z'];

/** A bare JS identifier — the only expression form resolvable server-side. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isValueExpr(value: unknown): value is ValueExpr {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '');
}

function isValueExprOrNull(value: unknown): value is ValueExpr | null {
  return value === null || value === undefined || isValueExpr(value);
}

function isThin(value: unknown): value is [ValueExpr] | [ValueExpr, ValueExpr] | null {
  if (value === null || value === undefined) {
    return true;
  }
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(isValueExpr);
}

/**
 * The revolve axis slot, narrowed to the three forms the kernel resolves.
 * Anything else — a keep chip the client failed to resolve, a malformed pick
 * — is a bad request, not a silent fall back to a world axis.
 */
function parseAxis(value: GhostBody['axis']): GhostAxisRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (value.kind === 'standard') {
    return typeof value.axis === 'string' && STANDARD_AXES.includes(value.axis)
      ? { kind: 'standard', axis: value.axis as 'x' | 'y' | 'z' }
      : null;
  }
  if (value.kind === 'axis') {
    return typeof value.filePath === 'string' && typeof value.line === 'number'
      ? { kind: 'axis', filePath: value.filePath, line: value.line }
      : null;
  }
  if (value.kind === 'edge') {
    return typeof value.shapeId === 'string' && typeof value.index === 'number'
      ? { kind: 'edge', shapeId: value.shapeId, index: value.index }
      : null;
  }
  return null;
}

/**
 * Resolve a dialog value to the number the kernel needs. A number passes
 * through; a bare identifier resolves against the file's top-level numeric
 * params, exactly as apply-feature's synthesis links dimensions. There is no
 * expression evaluator server-side, so arithmetic and unknown names resolve
 * to null — the ghost then simply doesn't show.
 */
function resolveExpr(value: ValueExpr, params: Map<string, number>): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const name = value.trim();
  if (!IDENTIFIER.test(name)) {
    return null;
  }
  const resolved = params.get(name);
  return resolved !== undefined && Number.isFinite(resolved) ? resolved : null;
}

/**
 * Live geometry preview for the open feature dialog ("ghost"): the bodies an
 * extrude/revolve/cut would sweep, meshed and returned to the requesting
 * client only. Nothing here writes code, scene state, or a broadcast — see
 * `FluidCadServer.featureGhost`.
 *
 * Its own small validator on purpose: the ghost body is a fraction of an
 * apply-feature payload, and the two must not drift into each other.
 */
export function createFeatureGhostRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/feature-ghost', async (req, res) => {
    const body = (req.body ?? {}) as GhostBody;

    if (typeof body.feature !== 'string' || !FEATURES.includes(body.feature)) {
      res.status(400).json({ success: false, reason: 'Unsupported ghost feature' });
      return;
    }
    if (typeof body.op !== 'string' || !OPS.includes(body.op)) {
      res.status(400).json({ success: false, reason: 'Invalid op' });
      return;
    }
    if (!isValueExprOrNull(body.distance) || !isValueExprOrNull(body.distance2)
      || !isValueExprOrNull(body.draft) || !isValueExprOrNull(body.angle) || !isThin(body.thin)) {
      res.status(400).json({ success: false, reason: 'Invalid dimension' });
      return;
    }
    const profile = body.profile;
    if (typeof profile?.filePath !== 'string' || typeof profile?.line !== 'number') {
      res.status(400).json({ success: false, reason: 'Invalid profile reference' });
      return;
    }
    const axis = body.feature === 'revolve' ? parseAxis(body.axis) : null;
    if (body.feature === 'revolve' && !axis) {
      res.status(400).json({ success: false, reason: 'Invalid axis reference' });
      return;
    }

    const code = fluidCadServer.getCurrentCode();
    const params = new Map<string, number>(
      code
        ? resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions())
          .map(p => [p.name, p.value] as const)
        : [],
    );

    const values: (number | null)[] = [];
    const resolve = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const resolved = resolveExpr(value as ValueExpr, params);
      values.push(resolved);
      return resolved;
    };

    const distance = resolve(body.distance);
    const distance2 = resolve(body.distance2);
    const draft = resolve(body.draft);
    const angle = resolve(body.angle);
    const thin = Array.isArray(body.thin)
      ? body.thin.map(v => resolve(v)) as [number] | [number, number]
      : null;

    if (values.some(v => v === null)) {
      // An expression this server can't evaluate — the client clears the ghost.
      res.json({ success: false, reason: 'That value is not a number the preview can resolve.' });
      return;
    }

    const op = body.op as FeatureGhostRequest['op'];
    const profileRef = { filePath: profile.filePath, line: profile.line };
    let request: FeatureGhostRequest;
    if (body.feature === 'revolve') {
      if (angle === null) {
        res.status(400).json({ success: false, reason: 'Invalid sweep angle' });
        return;
      }
      request = { feature: 'revolve', op, angle, thin, profile: profileRef, axis: axis! };
    } else {
      request = {
        feature: 'extrude',
        op,
        distance,
        distance2,
        symmetric: body.symmetric === true,
        draft,
        drill: body.drill !== false,
        thin,
        profile: profileRef,
      };
    }

    const result = await fluidCadServer.featureGhost(request);
    if (!result.solids) {
      res.status(result.status).json({ success: false, reason: result.reason });
      return;
    }
    res.json({ success: true, solids: result.solids });
  });

  return router;
}
