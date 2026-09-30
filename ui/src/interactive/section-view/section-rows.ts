import type { SceneObjectRender, SourceLocation } from '../../types';
import type { SectionSpec, Vec3Tuple } from '../../scene/section-spec';
import { SectionPlaneMath } from '../../scene/section-spec';

/** One `section()` statement of the rendered scene, as its row serializes it. */
export type SectionRow = {
  /** Stable across renders: the statement's file and line, else its name. */
  key: string;
  name: string;
  origin: Vec3Tuple;
  normal: Vec3Tuple;
  offset: number;
  flip: boolean;
  sourceLocation: SourceLocation | null;
  /** The build error the row carries (a non-planar face), or null. */
  error: string | null;
};

function keyOf(row: SceneObjectRender, name: string, index: number): string {
  const loc = row.sourceLocation;
  if (loc) {
    return `${loc.filePath}:${loc.line}`;
  }
  return `name:${name}#${index}`;
}

/**
 * The scene's section views in statement order: every `section` row that
 * built (a row whose plane failed keeps its name and the error, for the
 * menu to say why it cannot be shown).
 */
export function collectSectionRows(result: SceneObjectRender[]): SectionRow[] {
  const rows: SectionRow[] = [];
  result.forEach((row, index) => {
    if (row.type !== 'section') {
      return;
    }
    const data = row.object as { name?: unknown; origin?: unknown; normal?: unknown; offset?: unknown; flip?: unknown } | undefined;
    const name = typeof data?.name === 'string' ? data.name : (row.name ?? 'Section');
    const built = SectionPlaneMath.isVec3(data?.origin) && SectionPlaneMath.isVec3(data?.normal)
      && SectionPlaneMath.length(data!.normal as Vec3Tuple) > 0;
    rows.push({
      key: keyOf(row, name, index),
      name,
      origin: built ? [...(data!.origin as Vec3Tuple)] : [0, 0, 0],
      normal: built ? [...(data!.normal as Vec3Tuple)] : [0, 0, 1],
      offset: typeof data?.offset === 'number' && Number.isFinite(data.offset) ? data.offset : 0,
      flip: data?.flip === true,
      sourceLocation: row.sourceLocation ?? null,
      error: row.hasError ? (row.errorMessage ?? 'This section view did not build.') : built ? null : 'This section view has no plane yet.',
    });
  });
  return rows;
}

/** The clip spec of a row, at its own offset or a live override (the arrow mid-drag). */
export function sectionSpecOf(row: SectionRow, offset: number = row.offset): SectionSpec {
  return { plane: { origin: row.origin, normal: row.normal }, offset, flip: row.flip };
}
