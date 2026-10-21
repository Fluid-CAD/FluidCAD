import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import type { FluidCadServer, ScratchRender } from '../fluidcad-server/index.ts';
import type { AssemblyExportPose } from '../../../lib/dist/index.js';

type ExportFormatOptions = {
  format: 'step' | 'stl';
  includeColors?: boolean;
  resolution?: string;
  customLinearDeflection?: number;
  customAngularDeflectionDeg?: number;
  scaleTo?: 'mm' | 'document';
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is { x: number; y: number; z: number } {
  return v !== null && typeof v === 'object'
    && isFiniteNumber((v as any).x) && isFiniteNumber((v as any).y) && isFiniteNumber((v as any).z);
}

function isQuat(v: unknown): v is { x: number; y: number; z: number; w: number } {
  return isVec3(v) && isFiniteNumber((v as any).w);
}

/**
 * The `assembly.poses` list as sent by the UI: one live world pose per
 * instance. Returns the parsed list, `undefined` when the client sent none
 * (statement poses), or an error string.
 */
function parseAssemblyPoses(assembly: unknown): AssemblyExportPose[] | undefined | string {
  if (assembly === null || typeof assembly !== 'object' || Array.isArray(assembly)) {
    return 'assembly must be an object.';
  }
  const poses = (assembly as { poses?: unknown }).poses;
  if (poses === undefined) {
    return undefined;
  }
  if (!Array.isArray(poses)) {
    return 'assembly.poses must be an array.';
  }
  const parsed: AssemblyExportPose[] = [];
  for (const pose of poses) {
    if (
      pose === null || typeof pose !== 'object'
      || typeof pose.instanceId !== 'string' || pose.instanceId.length === 0
      || !isVec3(pose.position) || !isQuat(pose.quaternion)
    ) {
      return 'assembly.poses entries need instanceId, position {x,y,z} and quaternion {x,y,z,w}.';
    }
    parsed.push({ instanceId: pose.instanceId, position: pose.position, quaternion: pose.quaternion });
  }
  return parsed;
}

/**
 * `POST /api/export` with `configuration`: the named `configurations()` row
 * is rendered for the request alone (`FluidCadServer.renderWithConfiguration`)
 * and exported from — the session's active row, overrides and the scene the
 * viewer shows are untouched (`docs/assembly-configurations-plan.md` §3.7).
 * The row that is already active exports the live scene, tweaks included;
 * `'Default'` is the literals. An assembly exported from a scratch render
 * sits at its statement poses — the viewer's solved poses belong to the
 * configuration on screen — and says so in `X-FluidCAD-Assembly-Poses`.
 * A name the file does not declare is a 400 listing the declared names.
 */
export function createExportRouter(fluidCadServer: FluidCadServer, workspacePath: string): Router {
  const router = Router();
  // Resolve the workspace root once so symlink checks below match the path
  // we actually allow writes into.
  const workspaceRoot = (() => {
    try {
      return fs.realpathSync(workspacePath);
    } catch {
      return path.resolve(workspacePath);
    }
  })();

  router.post('/export', async (req, res) => {
    const { format, shapeIds, assembly, includeColors, resolution, customAngularDeflectionDeg, customLinearDeflection, saveAsPath, scaleTo, configuration } = req.body;

    if (format !== 'step' && format !== 'stl') {
      res.status(400).json({ error: 'Invalid format. Must be "step" or "stl".' });
      return;
    }

    // Exactly one selector: a list of solids, or the whole assembly.
    const hasShapeIds = shapeIds !== undefined;
    const hasAssembly = assembly !== undefined;
    if (hasShapeIds === hasAssembly) {
      res.status(400).json({ error: 'Pass exactly one of shapeIds (solids to export) or assembly (the whole assembly).' });
      return;
    }
    if (hasShapeIds && (!Array.isArray(shapeIds) || shapeIds.length === 0)) {
      res.status(400).json({ error: 'shapeIds must be a non-empty array.' });
      return;
    }
    let livePoses: AssemblyExportPose[] | undefined;
    if (hasAssembly) {
      const parsed = parseAssemblyPoses(assembly);
      if (typeof parsed === 'string') {
        res.status(400).json({ error: parsed });
        return;
      }
      livePoses = parsed;
    }

    if (format === 'stl') {
      const validResolutions = ['coarse', 'medium', 'fine', 'custom'];
      if (resolution && !validResolutions.includes(resolution)) {
        res.status(400).json({ error: 'Invalid resolution.' });
        return;
      }
      if (resolution === 'custom') {
        if (typeof customLinearDeflection !== 'number' || typeof customAngularDeflectionDeg !== 'number') {
          res.status(400).json({ error: 'Custom resolution requires customLinearDeflection and customAngularDeflectionDeg.' });
          return;
        }
      }
      if (scaleTo !== undefined && scaleTo !== 'mm' && scaleTo !== 'document') {
        res.status(400).json({ error: 'Invalid scaleTo. Must be "mm" or "document".' });
        return;
      }
    }

    if (saveAsPath !== undefined && typeof saveAsPath !== 'string') {
      res.status(400).json({ error: 'saveAsPath must be a string.' });
      return;
    }
    if (configuration !== undefined && (typeof configuration !== 'string' || configuration.trim() === '')) {
      res.status(400).json({ error: 'configuration must be a non-empty string — a configurations() row name, or Default.' });
      return;
    }

    // A row other than the one showing is a scratch render of its own; the
    // active row (or no row asked for) is the live scene.
    let scratch: Extract<ScratchRender, { ok: true }> | undefined;
    if (configuration !== undefined) {
      const file = fluidCadServer.getCurrentFileName();
      if (!file) {
        res.status(404).json({ error: 'No active scene to export.' });
        return;
      }
      if (configuration !== fluidCadServer.getActiveConfiguration(file)) {
        let rendered: ScratchRender | null;
        try {
          rendered = await fluidCadServer.renderWithConfiguration(file, configuration);
        } catch (err: any) {
          res.status(500).json({ error: err?.message || String(err) });
          return;
        }
        if (!rendered) {
          res.status(404).json({ error: 'No active scene to export.' });
          return;
        }
        if (rendered.ok === false) {
          res.status(400).json({ error: rendered.reason, names: rendered.names });
          return;
        }
        scratch = rendered;
        // The viewer's poses were solved for the configuration on screen.
        livePoses = undefined;
      }
    }

    const options: ExportFormatOptions = {
      format,
      includeColors,
      resolution: resolution || 'medium',
      customLinearDeflection,
      customAngularDeflectionDeg,
      // The shapes' unit is the scene's; the engine fills it in. Only the
      // STL target scale is the client's choice.
      ...(format === 'stl' && scaleTo ? { scaleTo } : {}),
    };

    try {
      let result: { data: string | Uint8Array; fileName: string };
      if (hasAssembly) {
        const outcome = fluidCadServer.exportAssembly(options, livePoses, scratch);
        if (!outcome) {
          res.status(404).json({ error: 'No active scene to export.' });
          return;
        }
        if ('reason' in outcome) {
          res.status(422).json({ error: outcome.reason });
          return;
        }
        res.setHeader('X-FluidCAD-Assembly-Poses', outcome.posesSource);
        result = outcome;
      } else {
        const exported = fluidCadServer.exportShapes(shapeIds, options, scratch);
        if (!exported) {
          res.status(404).json({ error: 'No active scene to export.' });
          return;
        }
        result = exported;
      }

      const mimeType = format === 'step' ? 'application/step' : 'application/sla';
      const bytes = typeof result.data === 'string'
        ? Buffer.from(result.data, 'utf-8')
        : Buffer.from(result.data);

      if (saveAsPath) {
        // Resolve against the workspace root, then verify the canonical path
        // (after symlink resolution of the parent) still lives inside it.
        const candidate = path.resolve(workspaceRoot, saveAsPath);
        const parent = path.dirname(candidate);
        let parentReal: string;
        try {
          parentReal = fs.realpathSync(parent);
        } catch {
          res.status(400).json({ error: `Parent directory does not exist: ${parent}` });
          return;
        }
        const canonical = path.join(parentReal, path.basename(candidate));
        const rel = path.relative(workspaceRoot, canonical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.status(400).json({ error: `saveAsPath escapes workspace root: ${saveAsPath}` });
          return;
        }
        fs.writeFileSync(canonical, bytes);
        res.json({ savedTo: canonical, bytesWritten: bytes.length });
        return;
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.send(bytes);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    } finally {
      scratch?.dispose();
    }
  });

  return router;
}
