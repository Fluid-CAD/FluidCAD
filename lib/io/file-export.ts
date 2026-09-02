import { OcIO } from "../oc/io.js";
import { Solid } from "../common/solid.js";
import { unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";

export interface ExportOptions {
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

/** Presets are defined in mm and converted into the unit of the mesh being written. */
export const RESOLUTION_PRESETS = {
  coarse: { linearDeflection: 1.0, angularDeflection: 0.5 },
  medium: { linearDeflection: 0.3, angularDeflection: 0.3 },
  fine: { linearDeflection: 0.05, angularDeflection: 0.1 },
} as const;

export class FileExport {
  static exportShapes(solids: Solid[], options: ExportOptions): { data: string | Uint8Array; fileName: string } {
    if (solids.length === 0) {
      throw new Error('No solids to export');
    }

    if (options.format === 'step') {
      return FileExport.exportStep(solids, options);
    }
    return FileExport.exportStl(solids, options);
  }

  private static exportStep(solids: Solid[], options: ExportOptions): { data: string; fileName: string } {
    const fileName = 'export.step';
    const includeColors = options.includeColors !== false;
    const unit = options.unit ?? 'mm';

    if (includeColors) {
      const data = OcIO.writeStepXCAF(solids, fileName, unit);
      return { data, fileName };
    }

    const data = OcIO.writeStep(solids, fileName, unit);
    return { data, fileName };
  }

  private static exportStl(solids: Solid[], options: ExportOptions): { data: Uint8Array; fileName: string } {
    const fileName = 'export.stl';
    const unit = options.unit ?? 'mm';
    const scaleTo = options.scaleTo ?? 'mm';
    // The unit the numbers in the written mesh are in — what deflections
    // must be expressed in.
    const meshUnit: LengthUnit = scaleTo === 'mm' ? 'mm' : unit;

    const { linearDeflection, angularDeflection } = FileExport.stlDeflections(options, unit, meshUnit);

    const compound = OcIO.makeCompoundRaw(solids.map(s => s.getShape()));
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
    options: Pick<ExportOptions, 'resolution' | 'customLinearDeflection' | 'customAngularDeflectionDeg'>,
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
