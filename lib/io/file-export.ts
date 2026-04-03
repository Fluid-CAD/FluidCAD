import { OcIO } from "../oc/io.js";
import { Solid } from "../common/solid.js";

export interface ExportOptions {
  format: 'step' | 'stl';
  includeColors?: boolean;
  resolution?: 'coarse' | 'medium' | 'fine' | 'custom';
  customLinearDeflection?: number;
  customAngularDeflectionDeg?: number;
}

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

    if (includeColors) {
      const data = OcIO.writeStepXCAF(solids, fileName);
      return { data, fileName };
    }

    const compound = OcIO.makeCompoundRaw(solids.map(s => s.getShape()));
    const data = OcIO.writeStepRaw(compound, fileName);
    return { data, fileName };
  }

  private static exportStl(solids: Solid[], options: ExportOptions): { data: Uint8Array; fileName: string } {
    const fileName = 'export.stl';
    const compound = OcIO.makeCompoundRaw(solids.map(s => s.getShape()));

    let linearDeflection: number;
    let angularDeflection: number;

    if (options.resolution === 'custom' && options.customLinearDeflection != null && options.customAngularDeflectionDeg != null) {
      linearDeflection = options.customLinearDeflection;
      angularDeflection = options.customAngularDeflectionDeg * Math.PI / 180;
    } else {
      const preset = RESOLUTION_PRESETS[options.resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS.medium;
      linearDeflection = preset.linearDeflection;
      angularDeflection = preset.angularDeflection;
    }

    const data = OcIO.writeStl(compound, fileName, linearDeflection, angularDeflection);
    return { data, fileName };
  }
}
