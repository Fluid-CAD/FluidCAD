import type { SceneObject } from "../common/scene-object.js";
import { Part } from "../features/part.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { samePartSite, type StatementLoc } from "./expose-lookup.js";
import type { SelectionScene } from "./types.js";

/**
 * Which parts of a rendered scene build from which: the graph a cross-part
 * pick is checked against BEFORE it is written. A part reads another by
 * holding an object whose dependency (the face selection a sketch lands on,
 * the exposure source a projection copies, a cut's up-to boundary) lives in
 * the other part's body, so the edges come straight off the built objects.
 * The engine refuses a loop at build time (`PartBuildStack`); this answers
 * earlier, so the tool that would close one never does.
 */
export class PartDependencies {
  /** part → the parts whose objects its own objects depend on. */
  private readonly readers = new Map<Part, Set<Part>>();

  constructor(private readonly scene: SelectionScene) {
    for (const obj of scene.getAllSceneObjects()) {
      const owner = scene.findEnclosingPart(obj);
      if (!(owner instanceof Part)) {
        continue;
      }
      for (const donor of this.ownersRead(obj)) {
        if (donor !== owner) {
          this.edgesOf(owner).add(donor);
        }
      }
    }
  }

  /**
   * The parts owning what `obj` builds from. A source without an owner —
   * an accessor selection like `e.endFaces()` lives in no part, only its
   * producer does — is read through to ITS sources until owned ones turn
   * up, so the edge lands on the producer's part.
   */
  private ownersRead(obj: SceneObject): Set<Part> {
    const owners = new Set<Part>();
    const seen = new Set<SceneObject>([obj]);
    const pending = PartDependencies.sourcesOf(obj);
    while (pending.length > 0) {
      const source = pending.pop()!;
      if (seen.has(source)) {
        continue;
      }
      seen.add(source);
      const owner = this.scene.findEnclosingPart(source);
      if (owner instanceof Part) {
        owners.add(owner);
      } else {
        pending.push(...PartDependencies.sourcesOf(source));
      }
    }
    return owners;
  }

  /**
   * What an object builds from: its dependencies and the boundaries it
   * resolves against. A sketch plane taken from a face keeps that face out
   * of `getDependencies()` so cloning wraps the resolved plane instead of
   * re-deriving it, but the face is still what the sketch reads.
   */
  private static sourcesOf(obj: SceneObject): SceneObject[] {
    const sources = [...obj.getDependencies(), ...obj.getBoundaryDependencies()];
    if (obj instanceof PlaneFromObject) {
      sources.push(obj.sourceObject);
    }
    return sources;
  }

  /** The parts `part` builds from directly. */
  readBy(part: Part): Part[] {
    return [...(this.readers.get(part) ?? [])];
  }

  /**
   * The shortest chain of parts from `from` to `to` through what each
   * builds from (`from` first, `to` last), or null when `from` does not
   * depend on `to`. Null for the same part: a part is not its own dependency.
   */
  pathBetween(from: Part, to: Part): Part[] | null {
    if (from === to) {
      return null;
    }
    const previous = new Map<Part, Part>();
    const queue: Part[] = [from];
    const seen = new Set<Part>([from]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of this.readers.get(current) ?? []) {
        if (seen.has(next)) {
          continue;
        }
        previous.set(next, current);
        if (next === to) {
          const path = [to];
          for (let step = current; ; step = previous.get(step)!) {
            path.unshift(step);
            if (step === from) {
              return path;
            }
          }
        }
        seen.add(next);
        queue.push(next);
      }
    }
    return null;
  }

  /** The rendered part whose `part()` call sits at `site`, or null. */
  partAt(site: StatementLoc): Part | null {
    for (const obj of this.scene.getAllSceneObjects()) {
      if (obj instanceof Part) {
        const at = obj.getSourceLocation();
        if (at && samePartSite({ partName: obj.partName, ...at }, site)) {
          return obj;
        }
      }
    }
    return null;
  }

  private edgesOf(part: Part): Set<Part> {
    let edges = this.readers.get(part);
    if (!edges) {
      edges = new Set();
      this.readers.set(part, edges);
    }
    return edges;
  }
}

/**
 * The names along the chain through which the part at `from` builds from
 * the part at `to` (`from` first, `to` last), or null when it does not —
 * including when either site is not a rendered part. A donor that depends
 * on the consumer this way must not be read by it: the read would close a
 * loop the engine refuses.
 */
export function resolvePartDependency(scene: SelectionScene, from: StatementLoc, to: StatementLoc): string[] | null {
  const graph = new PartDependencies(scene);
  const fromPart = graph.partAt(from);
  const toPart = graph.partAt(to);
  if (!fromPart || !toPart) {
    return null;
  }
  return graph.pathBetween(fromPart, toPart)?.map(p => p.partName) ?? null;
}
