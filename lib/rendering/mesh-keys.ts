import type { ShapeMeshPieces } from "./mesh-pieces.js";
import type { SceneObjectMesh } from "./scene.js";
import { TextDigest } from "../common/text-digest.js";

/**
 * What decides a rendered shape's mesh payload besides its pieces: the
 * topology arrays that ride with it and the colour every face resolved to.
 */
export type MeshKeyParts = {
  /** The topology vertices sent (absent: a meta shape other than a lone vertex sends none). */
  vertices?: readonly number[];
  /** The face-vertex lists sent (absent: meta shapes, edges and wires send none). */
  faceVertices?: readonly (readonly number[])[];
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
 * sent it again (generators S6b, P5). The rule: **the same key names the
 * same payload, and anything that changes the payload changes the key.**
 *
 * A key names content, not identity: `<geometry>/<form>[/<colours>]`.
 * - **geometry** — a 96-bit digest of the shape's {@link ShapeMeshPieces}
 *   (every face piece's vertices, normals and indices; every plain mesh with
 *   its label, colour, face mapping, edge index, smooth flag and face sides)
 *   and of the topology arrays sent with it. The pieces' part is computed
 *   once per pieces object (a wrapper's triangulation never changes) and
 *   kept beside it; the topology arrays are digested each render (a few
 *   numbers per vertex). So a shape a compare kept, or a generated template
 *   the cache serves again, keeps its key — and so does a shape rebuilt into
 *   the very same mesh (a template built again at another detail tier, two
 *   templates with equal geometry, a value dragged back): one payload, sent
 *   once, drawn with one geometry.
 * - **form** — which topology arrays ride with the meshes: `v` for
 *   `vertices`, `f` for `faceVertices`, `-` for neither.
 * - **colours** — a digest of the colour each face resolved to in this pass
 *   (`MeshPieces.groupResolved` groups the faces by it); absent when no face
 *   is painted. The same wrapper painted differently (a rollback before its
 *   paint, a second paint) has another key.
 *
 * Digests are not cryptographic: two different payloads sharing a key is a
 * chance of about 2^-96 per pair, which a mesh cache tolerates. Everything
 * else a rendered shape carries (its id, role, lineage, meta data) is sent
 * with every shape and is not part of the key.
 */
export class MeshKeys {
  private static readonly piecesDigests = new WeakMap<ShapeMeshPieces, MeshDigest>();

  /** The key of the payload grouped from `pieces` with `parts`. */
  static of(pieces: ShapeMeshPieces, parts: MeshKeyParts): string {
    const digest = MeshKeys.piecesDigest(pieces).clone();
    digest.numbers(parts.vertices);
    if (parts.faceVertices) {
      digest.word(parts.faceVertices.length);
      for (const face of parts.faceVertices) {
        digest.numbers(face);
      }
    } else {
      digest.absent();
    }
    const form = `${parts.vertices ? 'v' : ''}${parts.faceVertices ? 'f' : ''}` || '-';
    const key = `${digest.text()}/${form}`;
    if (!parts.faceColors) {
      return key;
    }
    // `\u0000` cannot occur in a colour: the sequence reads back unambiguously.
    const colours = parts.faceColors.map(color => color ?? '').join('\u0000');
    return `${key}/${TextDigest.of(colours)}`;
  }

  /** The digest of `pieces`' content, made the first time it is asked for and kept for the pieces' life. */
  private static piecesDigest(pieces: ShapeMeshPieces): MeshDigest {
    let digest = MeshKeys.piecesDigests.get(pieces);
    if (!digest) {
      digest = new MeshDigest();
      digest.word(pieces.faces.length);
      for (const face of pieces.faces) {
        digest.word(face.faceIdx);
        digest.numbers(face.vertices);
        digest.numbers(face.normals);
        digest.numbers(face.indices);
      }
      digest.word(pieces.meshes.length);
      for (const mesh of pieces.meshes) {
        MeshKeys.digestMesh(digest, mesh);
      }
      MeshKeys.piecesDigests.set(pieces, digest);
    }
    return digest;
  }

  private static digestMesh(digest: MeshDigest, mesh: SceneObjectMesh): void {
    digest.string(mesh.label);
    digest.numbers(mesh.vertices);
    digest.numbers(mesh.normals);
    digest.numbers(mesh.indices);
    digest.string(mesh.color);
    digest.numbers(mesh.faceMapping);
    if (mesh.edgeIndex === undefined) {
      digest.absent();
    } else {
      digest.number(mesh.edgeIndex);
    }
    digest.word(mesh.smooth === undefined ? 2 : mesh.smooth ? 1 : 0);
    digest.numbers(mesh.faceSides);
  }
}

/**
 * A streaming 96-bit digest of numbers, words and strings: three 32-bit
 * lanes, each a MurmurHash3-style body (multiply, rotate, multiply, mix)
 * with its own constants, finished with Murmur's avalanche. Every number
 * goes in as the two words of its IEEE-754 double, so equal digests mean
 * equal values bit for bit (a payload differing only by a −0 gets another
 * key for the same JSON: harmless). Array lengths and absence markers go in
 * too, so a boundary between two arrays can't slide.
 */
class MeshDigest {
  private static readonly float = new Float64Array(1);
  private static readonly words = new Uint32Array(MeshDigest.float.buffer);
  private static readonly ABSENT = 0x9e3779b9;

  private a = 0x2545f491;
  private b = 0x6a09e667;
  private c = 0x3c6ef372;
  private count = 0;

  clone(): MeshDigest {
    const copy = new MeshDigest();
    copy.a = this.a;
    copy.b = this.b;
    copy.c = this.c;
    copy.count = this.count;
    return copy;
  }

  word(w: number): void {
    let k = Math.imul(w, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    this.a ^= Math.imul(k, 0x1b873593);
    this.a = (this.a << 13) | (this.a >>> 19);
    this.a = (Math.imul(this.a, 5) + 0xe6546b64) | 0;

    let j = Math.imul(w, 0x85ebca6b);
    j = (j << 16) | (j >>> 16);
    this.b ^= Math.imul(j, 0xc2b2ae35);
    this.b = (this.b << 17) | (this.b >>> 15);
    this.b = (Math.imul(this.b, 9) + 0x52dce729) | 0;

    let m = Math.imul(w ^ (w >>> 16), 0x7feb352d);
    m = (m << 11) | (m >>> 21);
    this.c ^= Math.imul(m, 0x846ca68b);
    this.c = (this.c << 19) | (this.c >>> 13);
    this.c = (Math.imul(this.c, 7) + 0x38495ab5) | 0;

    this.count++;
  }

  number(value: number): void {
    MeshDigest.float[0] = value;
    this.word(MeshDigest.words[0]);
    this.word(MeshDigest.words[1]);
  }

  /** An array, its length first; `undefined` as absent. */
  numbers(values: readonly number[] | undefined): void {
    if (!values) {
      this.absent();
      return;
    }
    this.word(values.length);
    for (let i = 0; i < values.length; i++) {
      this.number(values[i]);
    }
  }

  string(value: string | undefined): void {
    if (value === undefined) {
      this.absent();
      return;
    }
    this.word(value.length);
    for (let i = 0; i < value.length; i++) {
      this.word(value.charCodeAt(i));
    }
  }

  absent(): void {
    this.word(MeshDigest.ABSENT);
  }

  /** The digest so far, as 21 base-36 characters. */
  text(): string {
    return [this.a, this.b, this.c]
      .map(lane => (MeshDigest.finish(lane ^ this.count) >>> 0).toString(36).padStart(7, '0'))
      .join('');
  }

  private static finish(h: number): number {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h;
  }
}
