// Which solids a shapes export (`POST /api/export` with `shapeIds`) writes:
// the listed shapes of the scene on screen, or every solid of the scene being
// exported — the live one, or a configuration's scratch render, whose solids
// can differ from the screen's (a row may add or drop a body).

import { ShapeLabels } from '../../../lib/dist/rendering/shape-labels.js';

/** A shapes export's selector: shape ids of the scene on screen, or `'all'` — every solid of the scene being exported. */
export type ShapeSelection = string[] | typeof ShapeExportSelection.ALL;

/** A solid of the scene on screen that the exported configuration does not build, as a refusal names it. */
export type UnmappedShape = { shapeId: string; label: string };

/**
 * Why a selection exports nothing: `400` for ids the request got wrong
 * (unknown on screen, or with no counterpart in the configuration's render,
 * listed in `missing`), `422` for a scene with no solid to write.
 */
export type ShapeExportRefusal = { reason: string; status: 400 | 422; missing?: UnmappedShape[] };

/** The scratch render a selection is resolved against: its scene and the row it rendered. */
export type ShapeExportTarget = { scene: any; configuration: string };

/**
 * Resolves a {@link ShapeSelection} to the ids of the scene that is exported.
 *
 * - `'all'` is every solid of that scene — the solids the scene's rows draw
 *   (no meta shape, no guide), hidden ones included: what File ▸ Export
 *   offers. Against a scratch render that is the row's own solids, so a row
 *   that adds a body exports it and a row that drops one does not.
 * - A list names shapes of the scene on screen. Against a scratch render each
 *   is found again by its lineage key (solids), else by its position among
 *   the shapes of the same statement; an id with no counterpart is refused
 *   with the solid's label and the row, never exported as some other body.
 */
export class ShapeExportSelection {
  static readonly ALL = 'all' as const;

  static isSelection(value: unknown): value is ShapeSelection {
    if (value === ShapeExportSelection.ALL) {
      return true;
    }
    return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.length > 0);
  }

  /**
   * The ids to hand the engine, or why there are none. `live` is the scene on
   * screen; `target`, when set, is the configuration's scratch render the
   * export comes from.
   */
  static resolve(live: any, selection: ShapeSelection, target?: ShapeExportTarget): { shapeIds: string[] } | ShapeExportRefusal {
    if (selection === ShapeExportSelection.ALL) {
      return ShapeExportSelection.everySolidOf(target?.scene ?? live, target?.configuration);
    }
    const liveRows = ShapeExportSelection.rowsOf(live);
    const unknown = selection.filter((id) => !ShapeExportSelection.shapeOf(liveRows, id));
    if (unknown.length > 0) {
      return {
        status: 400,
        reason: `Unknown shape id${unknown.length === 1 ? '' : 's'} ${unknown.map((id) => `'${id}'`).join(', ')}: `
          + 'not a shape of the scene on screen (ids change on every render; GET /api/scene/shapes lists them).',
      };
    }
    if (!selection.some((id) => ShapeExportSelection.isSolid(ShapeExportSelection.shapeOf(liveRows, id)))) {
      return { status: 422, reason: 'None of the selected shapes is a solid. STEP and STL export solids.' };
    }
    if (!target) {
      return { shapeIds: selection };
    }
    return ShapeExportSelection.mapOnto(liveRows, ShapeExportSelection.rowsOf(target.scene), selection, target.configuration);
  }

  /** Every solid `scene`'s rows draw, in timeline order; a refusal when there is none. */
  private static everySolidOf(scene: any, configuration: string | undefined): { shapeIds: string[] } | ShapeExportRefusal {
    const shapeIds: string[] = [];
    for (const row of ShapeExportSelection.rowsOf(scene)) {
      for (const shape of ShapeExportSelection.drawn(row)) {
        if (ShapeExportSelection.isSolid(shape)) {
          shapeIds.push(shape.shapeId);
        }
      }
    }
    if (shapeIds.length === 0) {
      return {
        status: 422,
        reason: configuration === undefined
          ? 'The scene has no solids to export.'
          : `Configuration '${configuration}' builds no solids to export.`,
      };
    }
    return { shapeIds };
  }

  /**
   * The scratch ids for the live `shapeIds`. A solid goes by its lineage key
   * first (the key survives re-renders and rows that move statements around);
   * any shape then by its position among the shapes of the same statement —
   * the scratch row with the live row's type and source location, or, for
   * rows without a location, the row at the same index with the same type.
   */
  private static mapOnto(liveRows: any[], scratchRows: any[], shapeIds: string[], configuration: string): { shapeIds: string[] } | ShapeExportRefusal {
    const byLineage = new Map<string, string>();
    for (const row of scratchRows) {
      for (const shape of ShapeExportSelection.drawn(row)) {
        if (typeof shape.lineageKey === 'string' && !byLineage.has(shape.lineageKey)) {
          byLineage.set(shape.lineageKey, shape.shapeId);
        }
      }
    }
    const scratchByStatement = new Map<string, any>();
    for (const row of scratchRows) {
      const key = ShapeExportSelection.statementKey(row);
      if (key !== null && !scratchByStatement.has(key)) {
        scratchByStatement.set(key, row);
      }
    }

    const mapped = new Map<string, string>();
    liveRows.forEach((row, index) => {
      const key = ShapeExportSelection.statementKey(row);
      const sameStatement = key !== null
        ? scratchByStatement.get(key)
        : ShapeExportSelection.sameUnlocatedRow(row, scratchRows[index]);
      const liveShapes = ShapeExportSelection.drawn(row);
      const scratchShapes = sameStatement ? ShapeExportSelection.drawn(sameStatement) : [];
      liveShapes.forEach((shape, position) => {
        const sameLineage = typeof shape.lineageKey === 'string' ? byLineage.get(shape.lineageKey) : undefined;
        const samePlace = scratchShapes[position]?.shapeId;
        const counterpart = sameLineage ?? samePlace;
        if (typeof counterpart === 'string') {
          mapped.set(shape.shapeId, counterpart);
        }
      });
    });

    const missing = shapeIds.filter((id) => !mapped.has(id));
    if (missing.length > 0) {
      const labels = ShapeLabels.labelsFor(liveRows);
      const named = missing.map((shapeId) => ({ shapeId, label: ShapeExportSelection.describe(labels.get(shapeId), shapeId) }));
      const list = named.map((shape) => shape.label).join(', ');
      return {
        status: 400,
        missing: named,
        reason: `Configuration '${configuration}' does not build ${list}, which the configuration on screen does. `
          + 'Export every solid instead, or pick shapes that configuration builds.',
      };
    }
    return { shapeIds: shapeIds.map((id) => mapped.get(id)!) };
  }

  /** "Solid 2 (Boss, part 'Plate')" — the Shapes panel's label, the statement and the part. */
  private static describe(label: { label: string; part: string | null; holder: { name?: string } } | undefined, shapeId: string): string {
    if (!label) {
      return `shape '${shapeId}'`;
    }
    const where = [label.holder.name, label.part ? `part '${label.part}'` : null].filter((part): part is string => !!part);
    return where.length > 0 ? `${label.label} (${where.join(', ')})` : label.label;
  }

  /** A row's statement identity: its type and source location (occurrence included); null without a location. */
  private static statementKey(row: any): string | null {
    const location = row?.sourceLocation;
    if (!location || typeof location.line !== 'number') {
      return null;
    }
    return `${row.uniqueType ?? row.type ?? ''}@${location.filePath ?? ''}:${location.line}:${location.column ?? 0}#${location.occurrence ?? 0}`;
  }

  /** The scratch row at a location-less live row's index, when it is a row of the same type. */
  private static sameUnlocatedRow(live: any, scratch: any): any {
    if (!scratch || ShapeExportSelection.statementKey(scratch) !== null) {
      return undefined;
    }
    return (scratch.uniqueType ?? scratch.type) === (live.uniqueType ?? live.type) ? scratch : undefined;
  }

  private static shapeOf(rows: any[], shapeId: string): any {
    for (const row of rows) {
      const shape = ShapeExportSelection.drawn(row).find((s) => s.shapeId === shapeId);
      if (shape) {
        return shape;
      }
    }
    return undefined;
  }

  private static isSolid(shape: any): boolean {
    return !!shape && shape.shapeType === 'solid' && !shape.isMetaShape && !shape.isGuide;
  }

  private static drawn(row: any): any[] {
    return (row?.sceneShapes ?? []) as any[];
  }

  private static rowsOf(scene: any): any[] {
    return (scene?.getRenderedObjects?.() ?? []) as any[];
  }
}
