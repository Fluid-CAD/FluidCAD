import { OcIO } from "../oc/io.js";
import type { ColoredSolid } from "../common/colored-solid.js";
import { unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import { standardPlaneView } from "../math/plane.js";
import { DrawingExport, DxfWriter, SvgWriter } from "./drawing/index.js";
import type { DrawingExportOptions } from "./drawing/index.js";

/** The options of a 3D export: the solids themselves, as B-rep (STEP) or mesh (STL). */
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
 * What `FileExport.exportShapes` writes, told apart by `format`: the solids
 * themselves (`'step'`, `'stl'`), or a 2D drawing of their view on a plane
 * (`'dxf'`, `'svg'`).
 */
export type ExportOptions = SolidExportOptions | DrawingExportOptions;

export type { DrawingExportOptions } from "./drawing/index.js";

/**
 * A written file. `warnings` is what the user should be told about it — a
 * drawing whose curves had to be approximated says so here.
 */
export type ExportResult = { data: string | Uint8Array; fileName: string; warnings?: string[] };

/** Presets are defined in mm and converted into the unit of the mesh being written. */
export const RESOLUTION_PRESETS = {
  coarse: { linearDeflection: 1.0, angularDeflection: 0.5 },
  medium: { linearDeflection: 0.3, angularDeflection: 0.3 },
  fine: { linearDeflection: 0.05, angularDeflection: 0.1 },
} as const;

export class FileExport {
  /** Writes `solids` — each with the colours its holder resolves for it (`ColoredSolids.fromHolder`). */
  static exportShapes(solids: ColoredSolid[], options: ExportOptions): ExportResult {
    if (solids.length === 0) {
      throw new Error('No solids to export');
    }

    if (FileExport.isDrawing(options)) {
      return FileExport.exportDrawing(solids, options);
    }
    if (options.format === 'step') {
      return FileExport.exportStep(solids, options);
    }
    return FileExport.exportStl(solids, options);
  }

  /** Whether the options ask for a 2D drawing (`'dxf'`, `'svg'`) rather than the solids themselves. */
  static isDrawing(options: ExportOptions): options is DrawingExportOptions {
    return options.format === 'dxf' || options.format === 'svg';
  }

  /**
   * The solids' view on `options.plane` as a 2D file. They are drawn
   * together — one hides another as on screen — at model coordinates, in the
   * document's unit. The file is named after the view (`export-top.dxf`,
   * `export-top.svg`): one part is usually drawn on several planes.
   */
  private static exportDrawing(solids: ColoredSolid[], options: DrawingExportOptions): ExportResult {
    // Each solid with the seams its wrapper records: the drawing shows no edge the viewer hides.
    const shapes = solids.map(s => ({ shape: s.solid.getShape(), renderSeams: s.solid.getRenderSeams() }));
    const drawing = DrawingExport.fromShapes(shapes, {
      plane: options.plane,
      hiddenLines: options.hiddenLines,
      tangentEdges: options.tangentEdges,
      unit: options.unit ?? 'mm',
    });
    const view = standardPlaneView(options.plane);
    const fileName = `export-${view}.${options.format}`;
    const data = options.format === 'svg'
      ? SvgWriter.write(drawing, { ...options.svg, title: `${view[0].toUpperCase()}${view.slice(1)} view` })
      : DxfWriter.write(drawing);
    return { data, fileName, ...(drawing.warnings.length > 0 ? { warnings: drawing.warnings } : {}) };
  }

  private static exportStep(solids: ColoredSolid[], options: SolidExportOptions): { data: string; fileName: string } {
    const fileName = 'export.step';
    const includeColors = options.includeColors !== false;
    const unit = options.unit ?? 'mm';

    if (includeColors) {
      const data = OcIO.writeStepXCAF(solids, fileName, unit);
      return { data, fileName };
    }

    const data = OcIO.writeStep(solids.map(s => s.solid), fileName, unit);
    return { data, fileName };
  }

  private static exportStl(solids: ColoredSolid[], options: SolidExportOptions): { data: Uint8Array; fileName: string } {
    const fileName = 'export.stl';
    const unit = options.unit ?? 'mm';
    const scaleTo = options.scaleTo ?? 'mm';
    // The unit the numbers in the written mesh are in — what deflections
    // must be expressed in.
    const meshUnit: LengthUnit = scaleTo === 'mm' ? 'mm' : unit;

    const { linearDeflection, angularDeflection } = FileExport.stlDeflections(options, unit, meshUnit);

    const compound = OcIO.makeCompoundRaw(solids.map(s => s.solid.getShape()));
    const factor = unitFactor(unit, meshUnit);
    if (factor === 1) {
      const data = OcIO.writeStl(compound, fileName, linearDeflection, angularDeflection);
      return { data, fileName };
    }

    const scaled = OcIO.scaleShapeRaw(compound, factor);
    try {
      const data = OcIO.writeStl(scaled, fileName, linearDeflection, angularDeflection);
      return { data, fileName };
    } finally {
      scaled.delete();
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
