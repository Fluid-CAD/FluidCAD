import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { ShapeExportSelection, type FluidCadServer, type ScratchRender } from '../fluidcad-server/index.ts';
import type { AssemblyExportPose, DrawingExportOptions, ExportOptions, SolidExportOptions } from '../../../lib/dist/index.js';
import { STANDARD_PLANES, isStandardPlane, standardPlaneView } from '../../../lib/dist/math/plane.js';

/** The formats that write the solids themselves. */
const SOLID_FORMATS = ['step', 'stl'] as const;
/** The formats that write a 2D drawing of the solids' view on a plane. */
const DRAWING_FORMATS = ['dxf', 'svg'] as const;

type SolidFormat = typeof SOLID_FORMATS[number];
type DrawingFormat = typeof DRAWING_FORMATS[number];

/** The body fields that only mean something for a 3D format; a drawing request carrying one is refused. */
const SOLID_ONLY_OPTIONS = ['includeColors', 'resolution', 'customLinearDeflection', 'customAngularDeflectionDeg', 'scaleTo'] as const;

/** The body fields that put an SVG on its page, in millimetres on paper; any other format carrying one is refused. */
const SVG_ONLY_OPTIONS = ['strokeWidth', 'margin'] as const;

const MIME_TYPES: Record<SolidFormat | DrawingFormat, string> = {
  step: 'application/step',
  stl: 'application/sla',
  dxf: 'image/vnd.dxf',
  svg: 'image/svg+xml',
};

/** Carries an export's warnings on a binary answer: a URI-encoded JSON array of strings. */
export const EXPORT_WARNINGS_HEADER = 'X-FluidCAD-Export-Warnings';

function isDrawingFormat(format: unknown): format is DrawingFormat {
  return (DRAWING_FORMATS as readonly unknown[]).includes(format);
}

/**
 * The 400 for a body carrying the SVG page options (`strokeWidth`, `margin`)
 * with a format that has no page; null when it carries none.
 */
function straySvgOptions(format: string, body: Record<string, unknown>): string | null {
  const stray = SVG_ONLY_OPTIONS.filter((name) => body[name] !== undefined);
  if (stray.length === 0) {
    return null;
  }
  return `${stray.join(', ')} ${stray.length === 1 ? 'applies' : 'apply'} to an SVG drawing only, not to ${format.toUpperCase()}.`;
}

/**
 * The drawing options of a `dxf` or `svg` body, or the 400 that says what
 * is wrong with them. `plane` is required: a drawing is a view, and no view
 * is a sensible default for every part. The 3D formats' options are refused
 * rather than dropped — a `resolution` sent with `dxf` is a caller that
 * thinks it is meshing — and so are the SVG page options on a DXF, which
 * has no page.
 */
function parseDrawingOptions(format: DrawingFormat, body: Record<string, unknown>): DrawingExportOptions | { error: string; planes?: readonly string[] } {
  const stray = SOLID_ONLY_OPTIONS.filter((name) => body[name] !== undefined);
  if (stray.length > 0) {
    return {
      error: `${stray.join(', ')} ${stray.length === 1 ? 'does' : 'do'} not apply to a ${format.toUpperCase()} drawing. `
        + (format === 'svg'
          ? 'An SVG drawing takes plane, hiddenLines, tangentEdges, strokeWidth and margin.'
          : 'A drawing takes plane, hiddenLines and tangentEdges.'),
    };
  }
  if (format !== 'svg') {
    const strayPage = straySvgOptions(format, body);
    if (strayPage) {
      return { error: strayPage };
    }
  }
  if (!isStandardPlane(body.plane)) {
    return {
      error: `${format.toUpperCase()} draws the model's view on a plane: plane must be one of ${STANDARD_PLANES.join(', ')}.`,
      planes: STANDARD_PLANES,
    };
  }
  for (const name of ['hiddenLines', 'tangentEdges'] as const) {
    if (body[name] !== undefined && typeof body[name] !== 'boolean') {
      return { error: `${name} must be a boolean.` };
    }
  }
  // Both in millimetres on paper, whatever the document's unit.
  const page: { strokeWidth?: number; margin?: number } = {};
  if (format === 'svg') {
    if (body.strokeWidth !== undefined) {
      if (!isFiniteNumber(body.strokeWidth) || body.strokeWidth <= 0) {
        return { error: 'strokeWidth must be a number of millimetres greater than 0.' };
      }
      page.strokeWidth = body.strokeWidth;
    }
    if (body.margin !== undefined) {
      if (!isFiniteNumber(body.margin) || body.margin < 0) {
        return { error: 'margin must be a number of millimetres, 0 or more.' };
      }
      page.margin = body.margin;
    }
  }
  return {
    format,
    plane: body.plane,
    ...(body.hiddenLines !== undefined ? { hiddenLines: body.hiddenLines as boolean } : {}),
    ...(body.tangentEdges !== undefined ? { tangentEdges: body.tangentEdges as boolean } : {}),
    ...(Object.keys(page).length > 0 ? { svg: page } : {}),
  };
}

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
 * (the engine's own solve places the instances), or an error string.
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
 * sits where the engine's mate solve of that render puts it — the viewer's
 * live poses belong to the configuration on screen — and says so in
 * `X-FluidCAD-Assembly-Poses`.
 * A name the file does not declare is a 400 listing the declared names.
 *
 * `shapeIds: "all"` exports every solid of the scene exported — the row's
 * own render when it is not on screen, so a row that adds or drops a body
 * exports its own set. Listed ids are the scene on screen's; one the row
 * does not build is a 400 naming the solid and the row (`missing`), never
 * some other body (`ShapeExportSelection`).
 *
 * `format: "dxf"` or `"svg"` writes a 2D drawing instead of the solids:
 * their view on the standard plane `plane` names (required — `top`,
 * `front`, `xy`, `-xz` …), hidden-line removed, at model coordinates in the
 * document's unit. `hiddenLines` and `tangentEdges` add those edges on
 * their own layers. The solids of the selection are drawn together, one
 * hiding another. The file is `export-<view>.dxf` / `.svg`; what the
 * drawing had to approximate comes back in `X-FluidCAD-Export-Warnings` (a
 * URI-encoded JSON array of strings), or as `warnings` beside `savedTo`.
 * The 3D formats' options are a 400 here, and the whole assembly is a 422:
 * it has no drawing export yet.
 *
 * An SVG is put on a page: `strokeWidth` (default 0.25) is the stroke of
 * its visible edges and `margin` (default 5) the blank band around the
 * drawing, both in millimetres on paper whatever the document's unit. Any
 * other format carrying one of them is a 400. The document has no script,
 * no style sheet and no external reference: it is safe behind an `<img>`.
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

    const drawingFormat = isDrawingFormat(format);
    if (!drawingFormat && !(SOLID_FORMATS as readonly unknown[]).includes(format)) {
      res.status(400).json({ error: 'Invalid format. Must be "step", "stl", "dxf" or "svg".' });
      return;
    }
    if (!drawingFormat) {
      const strayPage = straySvgOptions(format, req.body);
      if (strayPage) {
        res.status(400).json({ error: strayPage });
        return;
      }
    }

    // Exactly one selector: a list of solids, or the whole assembly.
    const hasShapeIds = shapeIds !== undefined;
    const hasAssembly = assembly !== undefined;
    if (hasShapeIds === hasAssembly) {
      res.status(400).json({ error: 'Pass exactly one of shapeIds (solids to export) or assembly (the whole assembly).' });
      return;
    }
    if (hasShapeIds && !ShapeExportSelection.isSelection(shapeIds)) {
      res.status(400).json({ error: 'shapeIds must be a non-empty array of shape ids, or "all" (every solid of the scene exported).' });
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

    let drawing: DrawingExportOptions | undefined;
    if (drawingFormat) {
      const parsed = parseDrawingOptions(format, req.body);
      if ('error' in parsed) {
        res.status(400).json(parsed);
        return;
      }
      if (hasAssembly) {
        res.status(422).json({
          error: `A ${format.toUpperCase()} drawing of the whole assembly is not available yet. Export a part or its solids instead.`,
        });
        return;
      }
      drawing = parsed;
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
        // The viewer's poses belong to the configuration on screen; the
        // engine solves the row it renders.
        livePoses = undefined;
      }
    }

    const solidOptions: SolidExportOptions = {
      format,
      includeColors,
      resolution: resolution || 'medium',
      customLinearDeflection,
      customAngularDeflectionDeg,
      // The shapes' unit is the scene's; the engine fills it in. Only the
      // STL target scale is the client's choice.
      ...(format === 'stl' && scaleTo ? { scaleTo } : {}),
    };
    const options: ExportOptions = drawing ?? solidOptions;

    try {
      let result: { data: string | Uint8Array; fileName: string; warnings?: string[] };
      if (hasAssembly) {
        const outcome = fluidCadServer.exportAssembly(solidOptions, livePoses, scratch);
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
        if ('reason' in exported) {
          res.status(exported.status).json({ error: exported.reason, ...(exported.missing ? { missing: exported.missing } : {}) });
          return;
        }
        result = exported;
      }

      const mimeType = MIME_TYPES[format as SolidFormat | DrawingFormat];
      // A drawing is named after its view whatever name the plane was asked
      // under: `xy` and `top` are both `export-top.dxf` (or `.svg`).
      const fileName = drawing ? `export-${standardPlaneView(drawing.plane)}.${drawing.format}` : result.fileName;
      const warnings = (result.warnings ?? []).filter((warning) => typeof warning === 'string' && warning.length > 0);
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
        res.json({ savedTo: canonical, bytesWritten: bytes.length, ...(warnings.length > 0 ? { warnings } : {}) });
        return;
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      if (warnings.length > 0) {
        // Header values are Latin-1: the list travels URI-encoded.
        res.setHeader(EXPORT_WARNINGS_HEADER, encodeURIComponent(JSON.stringify(warnings)));
      }
      res.send(bytes);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    } finally {
      scratch?.dispose();
    }
  });

  return router;
}
