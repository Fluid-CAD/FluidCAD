import type { SceneObject } from "../common/scene-object.js";
import { Sketch } from "../features/2d/sketch.js";

/**
 * The default label of every unnamed row: `<DisplayType> <n>`, n the row's
 * 1-based ordinal among the rows of that display type IN THE SAME FILE, in
 * timeline order — "Extrude 1", "Extrude 2", "Sketch 3". A custom name in
 * that file that already reads `<DisplayType> <k>` takes its number out of
 * the sequence, so an unnamed extrude never reads the same as a user's
 * `.name('Extrude 2')` above or below it.
 *
 * Rows that keep their own names are left out of the map: a row with a
 * custom name (parts, connectors and exposures name themselves from their
 * first argument), everything inside a sketch (its entities, constraints,
 * regions, images and derived ops), `select()` rows and internal rows. A
 * clone a repeat or a copy placed carries its original's label and takes no
 * number of its own — the repeat's count must not renumber the cuts below.
 *
 * Nothing persistent hangs off the number: a label renumbers when a row of
 * the same type is inserted above it. Lineage keys (`BodyLineage`) are what
 * state is keyed on; labels are for people.
 */
export class DefaultNames {
  /** `<DisplayType> <n>` for every row of `sceneObjects` (timeline order) that takes a default label. */
  static labelsFor(sceneObjects: SceneObject[]): Map<SceneObject, string> {
    const taken = DefaultNames.customNumbers(sceneObjects);
    const next = new Map<string, number>();
    const labels = new Map<SceneObject, string>();
    const clones: SceneObject[] = [];

    for (const obj of sceneObjects) {
      if (!DefaultNames.takesLabel(obj)) {
        continue;
      }
      if (obj.getCloneSource() !== null) {
        clones.push(obj);
        continue;
      }
      const type = obj.getDisplayType();
      const bucket = `${DefaultNames.fileOf(obj)}\n${type}`;
      const used = taken.get(bucket);
      let n = next.get(bucket) ?? 1;
      while (used?.has(n)) {
        n++;
      }
      labels.set(obj, `${type} ${n}`);
      next.set(bucket, n + 1);
    }

    for (const clone of clones) {
      const root = DefaultNames.rootOf(clone);
      const label = root.hasCustomName() ? root.getName() : labels.get(root);
      if (label !== undefined) {
        labels.set(clone, label);
      }
    }
    return labels;
  }

  /** The name a row is listed under: its custom name, else its default label, else its bare display type. */
  static labelFor(obj: SceneObject, labels: ReadonlyMap<SceneObject, string>): string {
    if (obj.hasCustomName()) {
      return obj.getName();
    }
    return labels.get(obj) ?? obj.getDisplayType();
  }

  /** Whether the row is numbered — see the class comment for the rows that keep their own names. */
  private static takesLabel(obj: SceneObject): boolean {
    if (obj.hasCustomName() || obj.isInternal() || obj.getType() === 'select') {
      return false;
    }
    return !(obj.getParent() instanceof Sketch);
  }

  /** Per (file, display type): the numbers custom names of that shape already hold. */
  private static customNumbers(sceneObjects: SceneObject[]): Map<string, Set<number>> {
    const taken = new Map<string, Set<number>>();
    for (const obj of sceneObjects) {
      if (!obj.hasCustomName()) {
        continue;
      }
      const match = /^(.+) (\d+)$/.exec(obj.getName());
      if (!match) {
        continue;
      }
      const bucket = `${DefaultNames.fileOf(obj)}\n${match[1]}`;
      let numbers = taken.get(bucket);
      if (!numbers) {
        numbers = new Set<number>();
        taken.set(bucket, numbers);
      }
      numbers.add(Number(match[2]));
    }
    return taken;
  }

  private static fileOf(obj: SceneObject): string {
    return obj.getSourceLocation()?.filePath ?? '';
  }

  /** The original a chain of clones started from. */
  private static rootOf(obj: SceneObject): SceneObject {
    let current = obj;
    const seen = new Set<SceneObject>();
    for (let source = current.getCloneSource(); source !== null && !seen.has(source); source = current.getCloneSource()) {
      seen.add(current);
      current = source;
    }
    return current;
  }
}
