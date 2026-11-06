import {
  Float32BufferAttribute,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix3,
  ShaderLib,
  Vector3,
  type Matrix4,
} from 'three';
import { LineMaterial, type LineMaterialParameters } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Edge lines that lie on their own faces.
 *
 * A fat line is a band a few pixels wide that `LineMaterial` draws at its
 * centerline's depth. Where a face falls toward the viewer from the edge (a
 * rib meeting a floor) that half of the band sinks behind the face, so the
 * faces used to be pushed back by a slope-scaled polygon offset — about a
 * pixel's worth of depth on a steep face, which zoomed out is more than a
 * thin wall and let the edges behind it draw through.
 *
 * A solid's edge carries, per segment, the vector from the segment into the
 * face triangle on either side of it, as long as the face runs flat from
 * there (the engine's `faceSides`, see lib/oc/edge-face-sides.ts). This
 * material puts each corner of the band on the face that covers it: the
 * view ray through the corner meets that face's plane within its reach, and
 * that depth goes into the corner's clip z. Depth over a plane is affine on
 * screen, and the band has a centerline column of vertices (see
 * {@link FaceEdgeGeometry}), so each half of the band follows its face
 * exactly; the faces then keep only a constant offset.
 *
 * A corner no face covers — the empty side of a silhouette — keeps the
 * centerline depth, as does a line without face data. But when the edge is
 * seen through its own solid (a rib meeting a skin, from outside the skin;
 * the order of the two faces carries the edge's convexity, and with it
 * their outward normals), that corner goes as far back as either face's
 * plane carried across the edge: behind the wall it is seen through.
 */

/** Floats per segment in the engine's `faceSides`: two vectors, x y z each. */
export const FACE_SIDE_STRIDE = 6;

/**
 * How steep a face may turn from the view before its corner's depth stops
 * following it, as depth change per unit of the band's half-width: a face
 * all but edge-on would otherwise throw the corner arbitrarily far along the
 * ray.
 */
const FACE_SLOPE_LIMIT = 16;

const FACE_EDGE_DECLARATIONS = /* glsl */ `
		attribute vec3 instanceSideA;
		attribute vec3 instanceSideB;

		// The depth shift (view space, + toward the eye) from the line point
		// to where the corner's view ray meets the plane through the segment
		// that runs into side: lateral goes from the point to the ray at the
		// point's depth, ray is the ray's direction with z = -1. False when
		// there is no face or its plane is edge-on to the ray.
		bool planeShift( vec3 lateral, vec3 ray, vec3 segment, vec3 side, out float shift ) {

			shift = 0.0;
			if ( dot( side, side ) == 0.0 ) return false;

			vec3 normal = cross( segment, side );
			float den = dot( normal, ray );
			if ( abs( den ) <= 1e-6 * length( normal ) * length( ray ) ) return false;

			shift = dot( normal, lateral ) / den;
			return true;

		}

		// Whether the face itself covers the corner, its plane met at shift:
		// on the face's side of the edge, within the face's flat reach (the
		// side's length), no further than slack past the segment's ends, and
		// in front of the eye. Past that the plane is not the face: a narrow
		// face seen edge-on would throw the corner through whatever stands in
		// front of it.
		bool faceCovers( vec3 point, vec3 start, vec3 lateral, vec3 ray, vec3 segment, vec3 side, float slack, bool perspective, float shift ) {

			vec3 hit = lateral - shift * ray;
			float across = dot( hit, side );
			if ( across <= 0.0 || across > dot( side, side ) ) return false;

			float span = dot( segment, segment );
			float along = dot( point + hit - start, segment );
			float past = slack * sqrt( span );
			if ( along < - past || along > span + past ) return false;

			return ! perspective || point.z + shift < 0.0;

		}

		// Whether the eye, looking along eye's opposite, sees the edge through
		// its solid's own material. The faces come in convexity order —
		// (A x B) . segment > 0 at a convex edge, < 0 at a concave one — and
		// at a convex edge each face's outward normal turns away from the
		// other face, at a concave one toward it. Seen through the material:
		// both faces turned away from the eye at a convex edge, either at a
		// concave one. Faces in one plane have no convexity to read.
		bool behindOwnMaterial( vec3 segment, vec3 sideA, vec3 sideB, vec3 eye ) {

			if ( dot( sideA, sideA ) == 0.0 || dot( sideB, sideB ) == 0.0 ) return false;

			vec3 a = normalize( sideA );
			vec3 b = normalize( sideB );
			if ( abs( dot( a, b ) ) > 0.999 ) return false;

			// A mirroring model matrix turns the pair's handedness.
			float handed = sign( determinant( mat3( modelViewMatrix ) ) );
			bool convex = dot( cross( a, b ), segment ) * handed > 0.0;

			vec3 normalA = cross( segment, a );
			vec3 normalB = cross( segment, b );
			if ( ( dot( normalA, b ) < 0.0 ) != convex ) normalA = - normalA;
			if ( ( dot( normalB, a ) < 0.0 ) != convex ) normalB = - normalB;

			bool awayA = dot( normalA, eye ) < 0.0;
			bool awayB = dot( normalB, eye ) < 0.0;
			return convex ? awayA && awayB : awayA || awayB;

		}
`;

// After the corner's screen offset is applied (non-world-units branch).
const FACE_EDGE_CORNER_DEPTH = /* glsl */ `

				if ( position.x != 0.0 && clip.w > 0.0 ) {

					vec3 point = ( position.y < 0.5 ) ? start.xyz : end.xyz;
					vec2 ndcOffset = offset / clip.w;
					vec2 ndcScale = vec2( projectionMatrix[ 0 ][ 0 ], projectionMatrix[ 1 ][ 1 ] );
					vec3 lateral = vec3( ndcOffset / ndcScale * ( perspective ? - point.z : 1.0 ), 0.0 );
					vec3 ray = perspective ? ( point + lateral ) / ( - point.z ) : vec3( 0.0, 0.0, - 1.0 );
					vec3 segment = end.xyz - start.xyz;
					vec3 sideA = mat3( modelViewMatrix ) * instanceSideA;
					vec3 sideB = mat3( modelViewMatrix ) * instanceSideB;

					// How far past the segment's ends a face's plane still stands
					// for the face. An edge in view gets the band's half-width and
					// a quarter of the segment: the band's ends map onto the plane
					// a little past them, and a long edge would otherwise lose the
					// half on its face. One seen through its own solid gets none:
					// there the plane past an end runs out through the material.
					bool behind = behindOwnMaterial( segment, sideA, sideB, - ray );
					float slack = behind ? 0.0 : length( lateral ) + 0.25 * length( segment );

					float shiftA;
					float shiftB;
					bool planeA = planeShift( lateral, ray, segment, sideA, shiftA );
					bool planeB = planeShift( lateral, ray, segment, sideB, shiftB );
					bool onA = planeA && faceCovers( point, start.xyz, lateral, ray, segment, sideA, slack, perspective, shiftA );
					bool onB = planeB && faceCovers( point, start.xyz, lateral, ray, segment, sideB, slack, perspective, shiftB );

					float shift = 0.0;
					if ( onA || onB ) {

						// Both may cover it (the near side of a convex silhouette):
						// the nearer is the one seen there.
						shift = onA && onB ? max( shiftA, shiftB ) : ( onA ? shiftA : shiftB );

					} else if ( behind ) {

						// Seen through its own solid: behind that material, as far
						// back as either face's plane carried across the edge.
						if ( planeA ) shift = min( shift, shiftA );
						if ( planeB ) shift = min( shift, shiftB );

					}

					float limit = ${FACE_SLOPE_LIMIT.toFixed(1)} * length( lateral );
					shift = clamp( shift, - limit, limit );

					if ( shift != 0.0 ) {

						vec4 corner = projectionMatrix * vec4( point + lateral - shift * ray, 1.0 );
						if ( corner.w > 0.0 ) clip.z = corner.z / corner.w * clip.w;

					}

				}
`;

/** `LineMaterial`'s vertex shader with the corners put on their faces. */
export const FACE_EDGE_VERTEX_SHADER = patchLineVertexShader(ShaderLib.line.vertexShader);

/**
 * The three edits: declare the face attributes, let the centerline column
 * (`position.x` 0) stay on the line — `LineMaterial` only flips the offset
 * by the sign of x — and move the corners onto their faces. Throws when
 * three's shader no longer has the text an edit anchors on, so an upgrade
 * that moves it fails loudly instead of drawing the band wrong.
 */
export function patchLineVertexShader(source: string): string {
  const edits: [string, string][] = [
    ['attribute vec3 instanceEnd;', `attribute vec3 instanceEnd;\n${FACE_EDGE_DECLARATIONS}`],
    ['if ( position.x < 0.0 ) offset *= - 1.0;', 'offset *= position.x;'],
    ['clip.xy += offset;', `clip.xy += offset;${FACE_EDGE_CORNER_DEPTH}`],
  ];
  let patched = source;
  for (const [anchor, replacement] of edits) {
    if (patched.split(anchor).length !== 2) {
      throw new Error(`FaceEdgeMaterial: three's line shader no longer has "${anchor}" exactly once.`);
    }
    patched = patched.replace(anchor, replacement);
  }
  return patched;
}

/**
 * A `LineMaterial` whose band lies on the faces either side of the line. On
 * a plain `LineSegmentsGeometry` (no face attributes, no centerline column)
 * it draws exactly as `LineMaterial` does — a section overlay or a ghost
 * that clones it onto such a geometry stays right.
 */
export class FaceEdgeMaterial extends LineMaterial {
  readonly isFaceEdgeMaterial = true;

  constructor(parameters?: LineMaterialParameters) {
    super(parameters);
    this.vertexShader = FACE_EDGE_VERTEX_SHADER;
    // A geometry without the attributes reads them as zero (no face), not
    // as whatever another program last left in the attribute slot.
    Object.assign(this.defaultAttributeValues, {
      instanceSideA: [0, 0, 0],
      instanceSideB: [0, 0, 0],
    });
  }
}

/**
 * `LineSegmentsGeometry` with the band split down its centerline (columns
 * at x = -1, 0, 1 instead of -1, 1) and the segments' face directions as
 * the `instanceSideA` / `instanceSideB` attributes. Each half of the band is
 * then its own pair of triangles, on its own face's plane — one quad across
 * the line would blend the two planes and sink the middle of a convex edge.
 * Draw it with {@link FaceEdgeMaterial} only: `LineMaterial` reads x = 0 as
 * the right-hand side.
 */
export class FaceEdgeGeometry extends LineSegmentsGeometry {
  readonly isFaceEdgeGeometry = true;

  constructor() {
    super();
    // Rows as LineSegmentsGeometry's: the end cap (y 2), the end (1), the
    // start (0) and the start cap (-1), with its uv rows.
    const rows = [2, 1, 0, -1];
    const uvRows = [2, 1, -1, -2];
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      for (let x = -1; x <= 1; x++) {
        positions.push(x, rows[r], 0);
        uvs.push(x, uvRows[r]);
      }
    }
    const index: number[] = [];
    for (let r = 0; r + 1 < rows.length; r++) {
      for (let c = 0; c < 2; c++) {
        const a = r * 3 + c;
        const b = a + 1;
        const d = a + 3;
        const e = d + 1;
        index.push(a, d, b, d, e, b);
      }
    }
    this.setIndex(index);
    this.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  }

  /** Per segment, in `setPositions` order: the two in-face vectors (`FACE_SIDE_STRIDE` floats), zero where a side has no face. */
  setFaceSides(sides: Float32Array): this {
    const buffer = new InstancedInterleavedBuffer(sides, FACE_SIDE_STRIDE, 1);
    this.setAttribute('instanceSideA', new InterleavedBufferAttribute(buffer, 3, 0));
    this.setAttribute('instanceSideB', new InterleavedBufferAttribute(buffer, 3, 3));
    return this;
  }

  /** The positions move; the face vectors turn and scale with them (their length is a reach). */
  override applyMatrix4(matrix: Matrix4): this {
    super.applyMatrix4(matrix);
    const linear = new Matrix3().setFromMatrix4(matrix);
    const v = new Vector3();
    for (const name of ['instanceSideA', 'instanceSideB']) {
      const side = this.getAttribute(name) as InterleavedBufferAttribute | undefined;
      if (!side) {
        continue;
      }
      for (let i = 0; i < side.count; i++) {
        v.fromBufferAttribute(side, i).applyMatrix3(linear);
        side.setXYZ(i, v.x, v.y, v.z);
      }
      side.data.needsUpdate = true;
    }
    return this;
  }
}

/** The face vectors of an edge line's mesh data, when it has a pair for every segment. */
export function faceSidesOf(meshData: { indices: number[]; faceSides?: number[] }): Float32Array | null {
  const sides = meshData.faceSides;
  if (!sides || sides.length === 0 || sides.length !== (meshData.indices.length / 2) * FACE_SIDE_STRIDE) {
    return null;
  }
  return new Float32Array(sides);
}

/** The material a fat line on `geometry` needs: {@link FaceEdgeMaterial} on a {@link FaceEdgeGeometry}, else `LineMaterial`. */
export function createEdgeLineMaterial(geometry: LineSegmentsGeometry, parameters: LineMaterialParameters): LineMaterial {
  return (geometry as Partial<FaceEdgeGeometry>).isFaceEdgeGeometry
    ? new FaceEdgeMaterial(parameters)
    : new LineMaterial(parameters);
}
