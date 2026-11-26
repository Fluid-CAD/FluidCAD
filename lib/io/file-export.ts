import { OcIO } from "../oc/io.js";
import type { ColoredBody } from "../common/colored-body.js";
import type { BodyShape } from "../common/body-shape.js";
import type { Solid } from "../common/solid.js";
import { BuildError } from "../common/build-error.js";
import { unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import { standardPlaneView } from "../math/plane.js";
import { DrawingExport, DxfWriter, SvgWriter } from "./drawing/index.js";
import type { Drawing2D, DrawingExportOptions } from "./drawing/index.js";

/** The options of a 3D export: the bodies themselves, as B-rep (STEP) or mesh (STL). */
export interface SolidExportOptions {
  format: 'step' | 'stl';
  includeColors?: boolean;
  resolution?: 'coarse' | 'medium' | 'fine' | 'custom';
  /** Custom linear deflection, in DOCUMENT units (the unit of the exported shapes). */
  customLinearDeflection?: number;
  customAngularDeflectionDeg?: number;
  /**
   * The unit the exported shapes' numbers are in. Defaults to the exporting
   * scene's unit when the export goes through SceneManager; bare callers
   * default to mm.
   */
  unit?: LengthUnit;
  /**
   * STL only. STL carries no unit and slicers assume mm, so by default the
   * mesh is scaled into mm; `'document'` writes the numbers as they are.
   */
  scaleTo?: 'mm' | 'document';
}

/**
 * What `FileExport.exportShapes` writes, told apart by `format`: the bodies
 * themselves (`'step'`, `'stl'`), or a 2D drawing of their view on a plane
 * (`'dxf'`, `'svg'`).
 */
export type ExportOptions = SolidExportOptions | DrawingExportOptions;

export type { DrawingExportOptions } from "./drawing/index.js";

/**
 * A written file. `warnings` is what the user should be told about it — a
 * drawing whose curves had to be approximated, surfaces a mesh or a drawing
 * left out, say so here.
 */
export type ExportResult = { data: string | Uint8Array; fileName: string; warnings?: string[] };

/** Presets are defined in mm and converted into the unit of the mesh being written. */
export const RESOLUTION_PRESETS = {
  coarse: { linearDeflection: 1.0, angularDeflection: 0.5 },
  medium: { linearDeflection: 0.3, angularDeflection: 0.3 },
  fine: { linearDeflection: 0.05, angularDeflection: 0.1 },
} as const;

export class FileExport {
  /**
   * Writes `bodies` — each with the colours its holder resolves for it
   * (`ColoredBodies.fromHolder`). STEP writes solids and surfaces; STL and
   * the drawings write solids only, and say in `warnings` how many surfaces
   * they left out. Asking those formats for surfaces alone is an error that
   * points to STEP.
   */
  static exportShapes(bodies: ColoredBody<BodyShape>[], options: ExportOptions): ExportResult {
    if (bodies.length === 0) {
      throw new BuildError('Nothing to export: no solid or surface matches.', 'Pick a solid or a surface to export.');
    }

    if (options.format === 'step') {
      return FileExport.exportStep(bodies, options);
    }

    // A mesh or a drawing of a surface has no inside to show: they take the
    // solids and name what they dropped.
    const solids = bodies.filter((b): b is ColoredBody<Solid> => b.body.isSolid());
    const dropped = bodies.length - solids.length;
    if (solids.length === 0) {
      const format = options.format.toUpperCase();
      throw new BuildError(
        `${format} cannot hold a surface: a surface encloses no volume.`,
        'Export surfaces as STEP.',
      );
    }
    const result: ExportResult = FileExport.isDrawing(options)
      ? FileExport.exportDrawing(solids, options)
      : FileExport.exportStl(solids, options);
    if (dropped === 0) {
      return result;
    }
    const note = `${dropped} surface${dropped === 1 ? '' : 's'} left out: a surface encloses no volume.`;
    return { ...result, warnings: [...(result.warnings ?? []), note] };
  }

  /** Whether the options ask for a 2D drawing (`'dxf'`, `'svg'`) rather than the bodies themselves. */
  static isDrawing(options: ExportOptions): options is DrawingExportOptions {
    return options.format === 'dxf' || options.format === 'svg';
  }

  /**
   * The solids' view on `options.plane` as a 2D file. They are drawn
   * together — one hides another as on screen — at model coordinates, in the
   * document's unit. The file is named after the view (`export-top.dxf`,
   * `export-top.svg`): one part is usually drawn on several planes.
   */
  private static exportDrawing(solids: ColoredBody<Solid>[], options: DrawingExportOptions): ExportResult {
    // Each solid with the seams its wrapper records: the drawing shows no edge the viewer hides.
    const shapes = solids.map(s => ({ shape: s.body.getShape(), renderSeams: s.body.getRenderSeams() }));
    const drawing = DrawingExport.fromShapes(shapes, {
      plane: options.plane,
      hiddenLines: options.hiddenLines,
      tangentEdges: options.tangentEdges,
      unit: options.unit ?? 'mm',
    });
    return FileExport.writeDrawing(drawing, options, 'export');
  }

  /**
   * A drawing as the file its format asks for, named after the view it
   * shows (`<base>-top.dxf`, `<base>-top.svg`): one model is usually drawn
   * on several planes.
   */
  static writeDrawing(drawing: Drawing2D, options: Omit<DrawingExportOptions, 'unit'>, base: string): ExportResult {
    const view = standardPlaneView(options.plane);
    const fileName = `${base}-${view}.${options.format}`;
    const data = options.format === 'svg'
      ? SvgWriter.write(drawing, { ...options.svg, title: `${view[0].toUpperCase()}${view.slice(1)} view` })
      : DxfWriter.write(drawing);
    return { data, fileName, ...(drawing.warnings.length > 0 ? { warnings: drawing.warnings } : {}) };
  }

  private static exportStep(bodies: ColoredBody<BodyShape>[], options: SolidExportOptions): { data: string; fileName: string } {
    const fileName = 'export.step';
    const includeColors = options.includeColors !== false;
    const unit = options.unit ?? 'mm';

    if (includeColors) {
      const data = OcIO.writeStepXCAF(bodies, fileName, unit);
      return { data, fileName };
    }

    const data = OcIO.writeStep(bodies.map(b => b.body), fileName, unit);
    return { data, fileName };
  }

  private static exportStl(solids: ColoredBody<Solid>[], options: SolidExportOptions): { data: Uint8Array; fileName: string } {
    const fileName = 'export.stl';
    const unit = options.unit ?? 'mm';
    const scaleTo = options.scaleTo ?? 'mm';
    // The unit the numbers in the written mesh are in — what deflections
    // must be expressed in.
    const meshUnit: LengthUnit = scaleTo === 'mm' ? 'mm' : unit;

    const { linearDeflection, angularDeflection } = FileExport.stlDeflections(options, unit, meshUnit);

    const compound = OcIO.makeCompoundRaw(solids.map(s => s.body.getShape()));
    const factor = unitFactor(unit, meshUnit);
    const scaled = factor === 1 ? null : OcIO.scaleShapeRaw(compound, factor);
    try {
      const data = OcIO.writeStl(scaled ?? compound, fileName, linearDeflection, angularDeflection);
      return { data, fileName };
    } finally {
      scaled?.delete();
      compound.delete();
    }
  }

  /**
   * Resolves the STL deflections into `meshUnit`. Presets are mm; a custom
   * linear deflection is given in document units (`unit`).
   */
  static stlDeflections(
    options: Pick<SolidExportOptions, 'resolution' | 'customLinearDeflection' | 'customAngularDeflectionDeg'>,
    unit: LengthUnit,
    meshUnit: LengthUnit,
  ): { linearDeflection: number; angularDeflection: number } {
    if (options.resolution === 'custom' && options.customLinearDeflection != null && options.customAngularDeflectionDeg != null) {
      return {
        linearDeflection: options.customLinearDeflection * unitFactor(unit, meshUnit),
        angularDeflection: options.customAngularDeflectionDeg * Math.PI / 180,
      };
    }
    const preset = RESOLUTION_PRESETS[options.resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS.medium;
    return {
      linearDeflection: preset.linearDeflection * unitFactor('mm', meshUnit),
      angularDeflection: preset.angularDeflection,
    };
  }
}
