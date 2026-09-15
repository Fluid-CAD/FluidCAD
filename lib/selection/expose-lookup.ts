import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Part } from "../features/part.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick } from "./attribution.js";
import { PickRef, SelectionScene } from "./types.js";

/**
 * The inverse map a consumer-side pick needs: which part owns the picked
 * geometry, and whether one of that part's exposures already publishes the
 * picked shape. `donor: null` means the pick resolved fine but lies outside
 * any `part()` block — the caller falls back to the ordinary flow.
 */
export type PickExposureResolution =
  | {
    ok: true;
    donor: PartSite & {
      /** Exposure name whose source already serves the picked shape, or null. */
      matched: string | null;
      /** Every exposure name the donor already registers. */
      existingNames: string[];
    } | null;
  }
  | { ok: false; reason: string };

/**
 * A `part()` statement as the scene captured it — the identity every
 * cross-part decision compares (the donor of a pick against the consumer a
 * statement lives in). Both sides come from the scene's own source-location
 * capture, so the comparison is exact without any column convention.
 */
export type PartSite = {
  partName: string;
  filePath: string;
  line: number;
  column: number;
};

/** A statement's source location as the scene captured it. */
export type StatementLoc = { filePath: string; line: number; column?: number };

/**
 * The part whose body contains the statement at `loc` — the consumer side
 * of a cross-part reference (the sketch a projection lands in). Null when no
 * rendered object carries that location or it lies outside every part.
 * Matching is by file and line, plus the column when the caller has one:
 * the location comes from the scene rows the UI holds, so it round-trips.
 */
export function resolveStatementPart(scene: SelectionScene, loc: StatementLoc): PartSite | null {
  const target = normalizePath(loc.filePath);
  for (const obj of scene.getAllSceneObjects()) {
    const at = obj.getSourceLocation();
    if (!at || at.line !== loc.line || normalizePath(at.filePath) !== target) {
      continue;
    }
    if (loc.column !== undefined && at.column !== loc.column) {
      continue;
    }
    const enclosing = scene.findEnclosingPart(obj);
    return enclosing instanceof Part ? partSite(enclosing) : null;
  }
  return null;
}

/** Whether two statement sites name the same `part()` call. */
export function samePartSite(a: PartSite, b: StatementLoc): boolean {
  return a.line === b.line && (b.column === undefined || a.column === b.column)
    && normalizePath(a.filePath) === normalizePath(b.filePath);
}

/** The part's call site, or null when the render captured none. */
function partSite(part: Part): PartSite | null {
  const loc = part.getSourceLocation();
  if (!loc) {
    return null;
  }
  return { partName: part.partName, filePath: loc.filePath, line: loc.line, column: loc.column };
}

/** Forward slashes, so a Windows-captured path compares with a POSIX one. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a single face/edge pick to its enclosing part and that part's
 * matching exposure, if any. Read-only over a built scene — matching compares
 * the picked sub-shape against each exposure source's built shapes by
 * topological identity (`IsSame`), so a `select(...)`/lazy-selection source
 * created from the same solid matches its viewport pick.
 */
export function resolvePickExposure(scene: SelectionScene, ref: PickRef): PickExposureResolution {
  const index = new SelectionIndex(scene);
  let picked: Shape | null;
  let solidOwner: SceneObject | null;
  try {
    const attribution = attributePick(scene, index, ref);
    picked = attribution.picked;
    solidOwner = attribution.solidOwner;
  } finally {
    index.dispose();
  }
  if (!picked) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const enclosing = solidOwner ? scene.findEnclosingPart(solidOwner) : null;
  if (!(enclosing instanceof Part)) {
    return { ok: true, donor: null };
  }
  const site = partSite(enclosing);
  if (!site) {
    return { ok: false, reason: 'the enclosing part() has no source location — re-render and try again' };
  }

  let matched: string | null = null;
  for (const exposure of enclosing.getExposed()) {
    if (sourceServes(exposure.source, picked)) {
      matched = exposure.exposeName;
      break;
    }
  }

  return {
    ok: true,
    donor: {
      ...site,
      matched,
      existingNames: Object.keys(enclosing.getNamedExposures()),
    },
  };
}

/** Whether one of the source's built shapes IS the picked sub-shape. */
function sourceServes(source: SceneObject, picked: Shape): boolean {
  try {
    for (const shape of source.getShapes()) {
      if (shape.isSame(picked)) {
        return true;
      }
    }
  } catch {
    // An unbuilt or shape-less source never matches.
  }
  return false;
}
