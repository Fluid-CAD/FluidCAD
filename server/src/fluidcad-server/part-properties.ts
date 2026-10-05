// Part-level mass properties and the unknown-material warning pass — the two
// places the server resolves a part's `.material(id)` against the merged
// materials table (built-ins + the project's `fluidcad.json` map). Lib keeps
// the raw id; everything that needs a density lives here.

import {
  materialDensityGcm3,
  resolveMaterial,
  type DensityUnit,
  type MaterialSource,
  type ProjectMaterials,
} from '../../../lib/dist/common/materials.js';
import { MM_PER_UNIT } from '../../../lib/dist/units/units.js';
import type { ShapeProperties } from '../../../lib/dist/oc/props.js';
import type { LengthUnit } from '../project-config.ts';
import type { ObjectBuildWarning } from './render-types.ts';

/**
 * A part's material as `/api/part-properties` reports it: the raw id the
 * source assigned plus, when the merged table resolves it, the display
 * name, density and where the entry came from. An unknown id carries the
 * id alone and the response's `warning` says so.
 */
export type PartMaterialSummary = {
  id: string;
  name?: string;
  density?: number;
  densityUnit?: DensityUnit;
  source?: MaterialSource;
  /** The density in canonical g/cm³, whatever unit the entry declares. */
  densityGcm3?: number;
};

/**
 * The aggregate over a part's final solids — the solids still on screen at
 * the end of the render, inside the part, exactly the set the Shapes panel
 * lists for rows of that part. `volumeMm3` / `surfaceAreaMm2` are field
 * NAMES (see the properties routes): the values are in the document unit,
 * and the centroid is in the part's own frame.
 */
export type PartProperties = {
  partId: string;
  name: string;
  /** The final solids summed, in scene order. */
  shapeIds: string[];
  solidCount: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** Volume-weighted; the origin when the part has no volume. */
  centroid: { x: number; y: number; z: number };
  /** Null when the definition assigned no material. */
  material: PartMaterialSummary | null;
  /** Volume × density, in grams; absent without a resolvable material. */
  massG?: number;
  /** `Unknown material: <id>` when the id is in neither table. */
  warning?: string;
};

type RenderedRow = {
  id: string;
  name: string;
  type: string;
  uniqueType?: string;
  parentId: string | null;
  object?: { material?: unknown } | null;
  sceneShapes?: { shapeId?: string; shapeType?: string; isMetaShape?: boolean }[];
  sourceLocation?: { filePath: string; line: number; column: number };
};

/**
 * Sums `ShapeProperties` over a part's final solids and stamps the
 * non-fatal material warnings on rendered rows. Pure over the rendered
 * rows and a shape-properties lookup so it is testable without a kernel.
 */
export class PartPropertiesAggregator {
  /** The warning text a part row shows for an id the merged table lacks. */
  static unknownMaterialWarning(id: string): string {
    return `Unknown material: ${id}`;
  }

  /**
   * The non-fatal warnings of a render: every `part` row whose
   * `.material(id)` names neither a built-in nor a project material. Same
   * numbering and shape as `collectObjectErrors`, kept apart because an
   * unknown material never fails a build — the geometry is fine, only
   * the mass is unknown.
   */
  static collectWarnings(rows: readonly unknown[], project: ProjectMaterials | null): ObjectBuildWarning[] {
    const warnings: ObjectBuildWarning[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as RenderedRow | null | undefined;
      const materialId = PartPropertiesAggregator.materialIdOf(row);
      if (materialId === null || resolveMaterial(materialId, project) !== undefined) {
        continue;
      }
      warnings.push({
        index,
        id: row!.id,
        name: row!.name,
        uniqueKind: row!.uniqueType ?? row!.type,
        message: PartPropertiesAggregator.unknownMaterialWarning(materialId),
        sourceLocation: row!.sourceLocation,
      });
    }
    return warnings;
  }

  /**
   * The aggregate for the part row `partId`, or null when no such part is
   * in the render. `shapeProperties` answers one solid's own properties
   * (the scene manager's `getShapeProperties`); `unit` is the document unit
   * the volumes come back in, needed to turn them into grams.
   */
  static compute(
    rows: readonly unknown[],
    partId: string,
    shapeProperties: (shapeId: string) => ShapeProperties | null,
    project: ProjectMaterials | null,
    unit: LengthUnit,
  ): PartProperties | null {
    const typed = rows as readonly RenderedRow[];
    const byId = new Map<string, RenderedRow>();
    for (const row of typed) {
      if (row && row.id != null && !byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }
    const part = byId.get(partId);
    if (!part || part.type !== 'part') {
      return null;
    }

    const shapeIds: string[] = [];
    let volume = 0;
    let area = 0;
    const weighted = { x: 0, y: 0, z: 0 };
    for (const row of typed) {
      if (!row || (row.id !== partId && PartPropertiesAggregator.enclosingPartId(row, byId) !== partId)) {
        continue;
      }
      for (const shape of row.sceneShapes ?? []) {
        if (shape.shapeType !== 'solid' || shape.isMetaShape || !shape.shapeId) {
          continue;
        }
        const props = shapeProperties(shape.shapeId);
        if (!props) {
          continue;
        }
        shapeIds.push(shape.shapeId);
        volume += props.volumeMm3;
        area += props.surfaceAreaMm2;
        weighted.x += props.centroid.x * props.volumeMm3;
        weighted.y += props.centroid.y * props.volumeMm3;
        weighted.z += props.centroid.z * props.volumeMm3;
      }
    }
    const centroid = volume > 0
      ? { x: weighted.x / volume, y: weighted.y / volume, z: weighted.z / volume }
      : { x: 0, y: 0, z: 0 };

    const result: PartProperties = {
      partId,
      name: part.name,
      shapeIds,
      solidCount: shapeIds.length,
      volumeMm3: volume,
      surfaceAreaMm2: area,
      centroid,
      material: null,
    };
    const materialId = PartPropertiesAggregator.materialIdOf(part);
    if (materialId === null) {
      return result;
    }
    const material = resolveMaterial(materialId, project);
    if (!material) {
      result.material = { id: materialId };
      result.warning = PartPropertiesAggregator.unknownMaterialWarning(materialId);
      return result;
    }
    const densityGcm3 = materialDensityGcm3(material);
    result.material = {
      id: material.id,
      name: material.name,
      density: material.density,
      densityUnit: material.densityUnit,
      source: material.source,
      densityGcm3,
    };
    result.massG = PartPropertiesAggregator.massG(volume, unit, densityGcm3);
    return result;
  }

  /** Grams for a volume in `unit`³ at `densityGcm3`. */
  static massG(volume: number, unit: LengthUnit, densityGcm3: number): number {
    const cmPerUnit = MM_PER_UNIT[unit] / 10;
    return volume * cmPerUnit * cmPerUnit * cmPerUnit * densityGcm3;
  }

  /** The raw `.material(id)` of a part row, null for any other row or no material. */
  private static materialIdOf(row: RenderedRow | null | undefined): string | null {
    if (!row || row.type !== 'part') {
      return null;
    }
    const id = row.object?.material;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /** The nearest `part` ancestor of a row (never the row itself), or null at the root. */
  private static enclosingPartId(row: RenderedRow, byId: Map<string, RenderedRow>): string | null {
    const seen = new Set<string>();
    let current = row.parentId ? byId.get(row.parentId) : undefined;
    while (current && !seen.has(current.id)) {
      if (current.type === 'part') {
        return current.id;
      }
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return null;
  }
}
