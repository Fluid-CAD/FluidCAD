import type { TopoDS_Shape, TopTools_IndexedMapOfShape } from "ocjs-fluidcad";
import { getOC } from "../oc/init.js";
import type { Face } from "./face.js";
import type { SceneObject } from "./scene-object.js";

/** One resolved colour of a solid's face and the statement that set it. */
export type FaceColorEntry = {
  face: Face;
  color: string;
  setBy: SceneObject;
};

/**
 * The resolved colour per face of ONE solid under one scope — the carrier
 * everything in `lib/oc` and `lib/helpers` reads colours from, instead of
 * the shapes themselves. Built once per solid per pass by the holder
 * (`SceneObject.getFaceColors`); lookups go by raw face through an OCCT
 * indexed map, whose hasher compares with `IsSame`, so a face handed in by
 * a maker, an explorer or a pick resolves without a scan.
 *
 * Resolution happens here, while the map is filled: among the records
 * naming one face, the one whose author stands latest in the scene wins
 * and, for one author painting twice, the later record. That keeps
 * "latest statement in scope wins" (D3) in one place.
 *
 * Owns native memory: `delete()` it when the pass is done. An empty view
 * never allocates a map, so the common unpainted body costs nothing.
 */
export class FaceColorView {
  private map: TopTools_IndexedMapOfShape | null = null;
  private readonly byKey = new Map<number, FaceColorEntry>();

  /** `records` in write order — the holder's records for one solid, already filtered to the scope. */
  constructor(records: ReadonlyArray<FaceColorEntry>) {
    for (const record of records) {
      this.take(record);
    }
  }

  private take(record: FaceColorEntry): void {
    if (!this.map) {
      this.map = new (getOC().TopTools_IndexedMapOfShape)();
    }
    const key = this.map.Add(record.face.getShape());
    const current = this.byKey.get(key);
    // `>=`: a tie is the same author painting the face again — the later
    // record is the one it meant.
    if (!current || record.setBy.getOrder() >= current.setBy.getOrder()) {
      this.byKey.set(key, { face: record.face, color: record.color, setBy: record.setBy });
    }
  }

  /** The colour of `raw` (any orientation of the face), or undefined when unpainted. */
  get(raw: TopoDS_Shape): string | undefined {
    return this.entryOf(raw)?.color;
  }

  /** The resolved entry for `raw` (any orientation of the face) — its colour and author — or undefined when unpainted. */
  entryOf(raw: TopoDS_Shape): FaceColorEntry | undefined {
    if (!this.map) {
      return undefined;
    }
    const key = this.map.FindIndex(raw);
    if (key === 0) {
      return undefined;
    }
    return this.byKey.get(key);
  }

  isEmpty(): boolean {
    return this.byKey.size === 0;
  }

  entries(): ReadonlyArray<FaceColorEntry> {
    return Array.from(this.byKey.values());
  }

  /** Frees the native map; the view answers nothing afterwards. Safe to call twice. */
  delete(): void {
    if (this.map) {
      this.map.delete();
      this.map = null;
    }
    this.byKey.clear();
  }
}
