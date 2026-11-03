import type { ShapeMeshPieces } from "./mesh-pieces.js";
import { TextDigest } from "../common/text-digest.js";

/**
 * What decides a rendered shape's mesh payload besides its pieces: the
 * topology arrays that ride with it and the colour every face resolved to.
 */
export type MeshKeyParts = {
  /** `vertices` is sent (a meta shape other than a lone vertex sends none). */
  vertices: boolean;
  /** `faceVertices` is sent (meta shapes, edges and wires send none). */
  faceVertices: boolean;
  /**
   * The colour each face piece resolved to, in piece order (`undefined` for
   * an unpainted face) — null when no face is painted.
   */
  faceColors: readonly (string | undefined)[] | null;
};

/**
 * A rendered shape's mesh key (`RenderedShape.meshKey`): the name of the
 * exact mesh payload a host draws for the shape — its `meshes`, `vertices`
 * and `faceVertices` — so a host that already holds that payload need not be
 * sent it again (generators S6b, P5). The rule: **the same key always names
 * the same payload, and anything that changes the payload changes the key.**
 *
 * A key is `<pieces>/<form>[/<colours>]`:
 * - **pieces** — the id of the shape's {@link ShapeMeshPieces}: its
 *   triangulation (face pieces, edge meshes with their face sides and smooth
 *   flags), built once per shape wrapper and never changed after. A rebuilt
 *   shape is a new wrapper with new pieces; a shape kept by a compare — or
 *   held by the generated-part cache and taken again — keeps its wrapper and
 *   so its pieces and its key. The wrapper's raw shape never changes either,
 *   so the topology arrays computed from it are fixed with the pieces. Ids
 *   are process-unique: a random tag for this process, then a counter, so a
 *   key one engine process issued never names another process's mesh.
 * - **form** — which topology arrays ride with the meshes: `v` for
 *   `vertices`, `f` for `faceVertices`, `-` for neither. They depend on the
 *   wrapper's meta flag, not on the pieces.
 * - **colours** — a digest of the colour each face resolved to in this pass
 *   (`MeshPieces.group` groups the faces by it); absent when no face is
 *   painted. The same wrapper painted differently (a rollback before its
 *   paint, a second paint) has another key.
 *
 * Everything else a rendered shape carries (its id, role, lineage, meta
 * data) is sent with every shape and is not part of the key.
 */
export class MeshKeys {
  /** This process's tag: what keeps keys of two engine processes apart. */
  private static readonly processTag = globalThis.crypto.randomUUID().slice(0, 8);
  private static readonly ids = new WeakMap<ShapeMeshPieces, string>();
  private static issued = 0;

  /** The id of `pieces`, given the first time it is asked for and kept for the pieces' life. */
  static piecesId(pieces: ShapeMeshPieces): string {
    let id = MeshKeys.ids.get(pieces);
    if (id === undefined) {
      id = `${MeshKeys.processTag}-${(++MeshKeys.issued).toString(36)}`;
      MeshKeys.ids.set(pieces, id);
    }
    return id;
  }

  /** The key of the payload grouped from `pieces` with `parts`. */
  static of(pieces: ShapeMeshPieces, parts: MeshKeyParts): string {
    const form = `${parts.vertices ? 'v' : ''}${parts.faceVertices ? 'f' : ''}` || '-';
    const key = `${MeshKeys.piecesId(pieces)}/${form}`;
    if (!parts.faceColors) {
      return key;
    }
    // `\u0000` cannot occur in a colour: the sequence reads back unambiguously.
    const colours = parts.faceColors.map(color => color ?? '').join('\u0000');
    return `${key}/${TextDigest.of(colours)}`;
  }
}
