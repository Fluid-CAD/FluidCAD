import { ShaderLib, Vector2, type BufferGeometry, type Texture } from 'three';
import { LineMaterial, type LineMaterialParameters } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * A curve's line: visible where its centerline is visible.
 *
 * A curve (a scene object whose shapes are only wires or edges: a helix, an
 * intersection curve) is drawn as a fat line, a band a few pixels wide at
 * its centerline's depth. A solid's own edges know the faces either side of
 * them and lie on them (face-edge-line.ts); a curve does not: it lies on
 * whatever faces it was made on, and where such a face tilts toward the
 * viewer the half of the band over it sinks behind it. An intersection curve
 * lies on two faces, so both halves sink and the curve all but disappears.
 *
 * When the scene holds such a line, the viewer first draws the opaque faces
 * into a map of their window depth and its slopes across the pixel (see
 * scene/face-depth-prepass.ts). This material then decides visibility per
 * fragment on the centerline, not on the band: it finds the point of its
 * segment's centerline nearest the fragment on screen, that point's view
 * depth, and the faces' depth there — the plane of the face in each of the
 * four map pixels around the point, carried to its exact position (a face
 * the curve lies on reconstructs the curve's own depth, at any tilt, even in
 * the concave corner two faces meet in, where every pixel's centre is in
 * front of the crease). The fragment is dropped when the centerline is
 * behind the faces by more than they can stand in front of a curve lying on
 * them ({@link CURVE_SAG_MARGIN}, {@link CURVE_TILT_LIMIT}); otherwise it is
 * written in front of the face under the fragment itself, so the faces lose
 * to the whole band, and the band is cut square where the centerline goes
 * behind something.
 *
 * The allowance holds no pixel's worth of depth: the carried planes make
 * the sub-pixel position exact, and zoomed out a pixel's worth is more than
 * a thin wall, which a curve behind it would then show through. What is
 * left of the pixel grid is the silhouette of whatever stands in front: a
 * centerline within a pixel of it counts as seen.
 *
 * The hardware depth test stays on: whatever the map does not hold — a
 * section's caps, a face drawn translucent — hides the line as it always
 * has. Without a map (no faces, or a GPU that cannot draw a float target)
 * the line draws exactly as `LineMaterial` does.
 */

/**
 * The faces are chordal approximations of the true surfaces, and so is the
 * curve's own polyline: a curve on a concave face seen from inside (a bore)
 * lies behind the face's chords by up to the face's chordal deviation, and
 * a curve on a convex face (a helix on a shaft) dips behind its true surface
 * by up to its own. The engine meshes at a deflection that follows each
 * body's size and the document's mesh quality (lib/oc/mesh.ts: 5e-4 of the
 * size bucket's diagonal, clamped to 0.005..0.5 mm at the standard quality),
 * which the viewer is not told — so the deviation is measured from the
 * meshes themselves ({@link chordSag}, faceSagOf in face-depth-prepass.ts),
 * and a centerline may stand behind a face by the face's sag plus the
 * curve's, times this margin: a triangle of a doubly curved face bows out
 * further at its middle than along its edges, where the sag is measured.
 */
export const CURVE_SAG_MARGIN = 1.5;

/**
 * The deviations are across the surface; along a view ray they grow with
 * the secant of the face's tilt from the view, read from the map's depth
 * slopes. A wall in front of a curve is crossed along the same ray, so the
 * allowance hides a curve behind any wall thicker than the sags, at any
 * tilt. Capped where a face turns all but edge-on, its plane no longer a
 * measure of anything.
 */
export const CURVE_TILT_LIMIT = 8;

/**
 * Window-depth slack: the faces in the main pass sit one polygon-offset unit
 * behind the map's (face-depth-offset.ts), the map stores 32-bit floats where
 * the canvas holds 24-bit depth, and the two draws round apart. Four 24-bit
 * steps, as the vertex dots' occlusion allows (interactive/occluder-depth.ts).
 */
export const CURVE_DEPTH_EPSILON = 4 / 16777215;

/** The deviations are measured only where consecutive directions turn less than this: a sharper turn is a corner, not a chord of a curve. */
const SAG_MAX_TURN = Math.PI / 3;

/**
 * How far a polyline's chord of `length` bows from the circular arc it
 * stands for, when the next chord turns `turn` radians from it: `length / 2
 * · tan(turn / 4)`.
 */
export function chordSag(length: number, turn: number): number {
  if (!(turn > 0) || turn > SAG_MAX_TURN || !(length > 0)) {
    return 0;
  }
  return (length / 2) * Math.tan(turn / 4);
}

const curveSags = new WeakMap<BufferGeometry, number>();

/**
 * The polyline's largest chordal deviation from the curve it approximates,
 * in its geometry's own units: per pair of joined segments, the sag of the
 * longer one over the turn between them. Cached per geometry, which a
 * line's mesh never rewrites.
 */
export function curveSagOf(geometry: LineSegmentsGeometry): number {
  const cached = curveSags.get(geometry);
  if (cached !== undefined) {
    return cached;
  }
  let sag = 0;
  const start = geometry.getAttribute('instanceStart');
  const end = geometry.getAttribute('instanceEnd');
  if (start && end) {
    for (let i = 0; i + 1 < start.count; i++) {
      const ax = end.getX(i) - start.getX(i);
      const ay = end.getY(i) - start.getY(i);
      const az = end.getZ(i) - start.getZ(i);
      const bx = end.getX(i + 1) - start.getX(i + 1);
      const by = end.getY(i + 1) - start.getY(i + 1);
      const bz = end.getZ(i + 1) - start.getZ(i + 1);
      // Joined: this segment ends where the next starts.
      const gap = Math.hypot(start.getX(i + 1) - end.getX(i), start.getY(i + 1) - end.getY(i), start.getZ(i + 1) - end.getZ(i));
      const la = Math.hypot(ax, ay, az);
      const lb = Math.hypot(bx, by, bz);
      if (la === 0 || lb === 0 || gap > 1e-6 * Math.max(la, lb)) {
        continue;
      }
      const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (la * lb)));
      sag = Math.max(sag, chordSag(Math.max(la, lb), Math.acos(cos)));
    }
  }
  curveSags.set(geometry, sag);
  return sag;
}

const CURVE_LINE_VERTEX_DECLARATIONS = /* glsl */ `
		// What the fragment needs to find its centerline: its own clip
		// position (xy / w is the fragment's NDC exactly, where a screen-
		// linear varying would bend under perspective), the segment's ends
		// on screen, and their view depth and clip w.
		varying vec4 vCurveClip;
		varying vec4 vCurveSegment;
		varying vec4 vCurveDepth;
`;

const CURVE_LINE_VERTEX_OUTPUTS = /* glsl */ `
			vCurveClip = clip;
			vCurveSegment = vec4( ndcStart.xy, ndcEnd.xy );
			vCurveDepth = vec4( start.z, end.z, clipStart.w, clipEnd.w );
`;

const CURVE_LINE_FRAGMENT_DECLARATIONS = /* glsl */ `
		#include <packing>

		// The faces' map (scene/face-depth-prepass.ts): per pixel the
		// nearest face's window depth, its slopes along x and y, and the
		// face mesh's chordal sag (world units). faceDepthReady is 0 when
		// there is no map: the line then draws as LineMaterial does.
		uniform sampler2D faceDepth;
		uniform vec2 faceDepthSize;
		uniform float faceDepthReady;
		uniform float faceDepthNear;
		uniform float faceDepthFar;
		// World size of one map pixel, at unit view distance (perspective)
		// or anywhere (orthographic).
		uniform float faceDepthPixel;
		// The curve's own chordal sag, world units.
		uniform float curveSag;

		varying vec4 vCurveClip;
		varying vec4 vCurveSegment;
		varying vec4 vCurveDepth;

		float curveFaceViewZ( float depth ) {

			return isOrthographic
				? orthographicDepthToViewZ( depth, faceDepthNear, faceDepthFar )
				: perspectiveDepthToViewZ( depth, faceDepthNear, faceDepthFar );

		}

		// Whether the centerline point at map pixel position point, view
		// depth z, is in front of the faces — or behind one by no more than
		// a curve lying on it can be. Any of the four map pixels around the
		// point will do: the face the curve lies on is in one of them, its
		// plane carried to the point's exact position.
		bool centerlineVisible( vec2 point, float z ) {

			ivec2 p0 = ivec2( floor( point - 0.5 ) );
			ivec2 last = ivec2( faceDepthSize ) - 1;
			for ( int dy = 0; dy <= 1; dy ++ ) {

				for ( int dx = 0; dx <= 1; dx ++ ) {

					ivec2 texel = clamp( p0 + ivec2( dx, dy ), ivec2( 0 ), last );
					vec4 face = texelFetch( faceDepth, texel, 0 );
					// No face there: nothing in the map hides the point.
					if ( face.r >= 1.0 ) return true;

					vec2 offset = point - ( vec2( texel ) + 0.5 );
					float depth = face.r + face.g * offset.x + face.b * offset.y;
					if ( depth >= 1.0 ) return true;
					float faceZ = curveFaceViewZ( depth + ${CURVE_DEPTH_EPSILON.toExponential()} );

					// The face's tilt from the view: its view-depth change
					// per map pixel against a map pixel's world size there.
					float zx = curveFaceViewZ( depth + face.g ) - curveFaceViewZ( depth );
					float zy = curveFaceViewZ( depth + face.b ) - curveFaceViewZ( depth );
					float pixel = faceDepthPixel * ( isOrthographic ? 1.0 : max( - faceZ, 0.0 ) );
					float tilt = pixel > 0.0
						? min( sqrt( 1.0 + ( zx * zx + zy * zy ) / ( pixel * pixel ) ), ${CURVE_TILT_LIMIT.toFixed(1)} )
						: ${CURVE_TILT_LIMIT.toFixed(1)};

					float allowance = ( face.a + curveSag ) * ${CURVE_SAG_MARGIN.toFixed(2)} * tilt;
					if ( z >= faceZ - allowance ) return true;

				}

			}
			return false;

		}
`;

const CURVE_LINE_FRAGMENT_TEST = /* glsl */ `

			float curveFragDepth = gl_FragCoord.z;
			if ( faceDepthReady > 0.5 ) {

				// The centerline point nearest the fragment on screen,
				// measured in pixel-proportional units.
				vec2 ndc = vCurveClip.xy / vCurveClip.w;
				vec2 aspect = vec2( faceDepthSize.x / faceDepthSize.y, 1.0 );
				vec2 a = vCurveSegment.xy;
				vec2 b = vCurveSegment.zw;
				vec2 ab = ( b - a ) * aspect;
				float span = dot( ab, ab );
				float t = span > 0.0 ? clamp( dot( ( ndc - a ) * aspect, ab ) / span, 0.0, 1.0 ) : 0.0;
				vec2 center = mix( a, b, t );

				// Its view depth: 1 / w is affine on screen, so the point of
				// the segment that projects to t is s along it in view space.
				float ws = vCurveDepth.z;
				float we = vCurveDepth.w;
				float s = t * ws / max( t * ws + ( 1.0 - t ) * we, 1e-20 );
				float z = mix( vCurveDepth.x, vCurveDepth.y, s );

				if ( ! centerlineVisible( ( center * 0.5 + 0.5 ) * faceDepthSize, z ) ) discard;

				// Visible: in front of the face under the fragment itself
				// (its depth anywhere in the pixel, for the samples), so
				// that face loses to the band wherever it rises toward the
				// viewer.
				vec2 here = ( ndc * 0.5 + 0.5 ) * faceDepthSize;
				ivec2 texel = clamp( ivec2( floor( here ) ), ivec2( 0 ), ivec2( faceDepthSize ) - 1 );
				vec4 under = texelFetch( faceDepth, texel, 0 );
				vec2 offset = here - ( vec2( texel ) + 0.5 );
				float faceHere = under.r + under.g * offset.x + under.b * offset.y
					- 0.5 * ( abs( under.g ) + abs( under.b ) ) - ${CURVE_DEPTH_EPSILON.toExponential()};
				curveFragDepth = clamp( min( curveFragDepth, faceHere ), 0.0, 1.0 );

			}
			gl_FragDepth = curveFragDepth;
`;

/**
 * Inserts `addition` after `anchor`, which must occur exactly once. Throws
 * when three's shader no longer has it, so an upgrade that moves the text
 * fails loudly instead of drawing the line wrong.
 */
function insertAfter(source: string, anchor: string, addition: string): string {
  if (source.split(anchor).length !== 2) {
    throw new Error(`CurveLineMaterial: three's line shader no longer has "${anchor}" exactly once.`);
  }
  return source.replace(anchor, `${anchor}\n${addition}`);
}

/** `LineMaterial`'s vertex shader handing the fragment its segment. */
export function patchCurveVertexShader(source: string): string {
  let patched = insertAfter(source, 'attribute vec3 instanceEnd;', CURVE_LINE_VERTEX_DECLARATIONS);
  patched = insertAfter(patched, 'gl_Position = clip;', CURVE_LINE_VERTEX_OUTPUTS);
  return patched;
}

/** `LineMaterial`'s fragment shader testing its centerline against the faces' map. */
export function patchCurveFragmentShader(source: string): string {
  let patched = insertAfter(source, '#include <clipping_planes_pars_fragment>', CURVE_LINE_FRAGMENT_DECLARATIONS);
  patched = insertAfter(patched, '#include <clipping_planes_fragment>', CURVE_LINE_FRAGMENT_TEST);
  return patched;
}

export const CURVE_LINE_VERTEX_SHADER = patchCurveVertexShader(ShaderLib.line.vertexShader);
export const CURVE_LINE_FRAGMENT_SHADER = patchCurveFragmentShader(ShaderLib.line.fragmentShader);

/** What a frame's face map hands every curve line drawn in it. */
export type FaceDepthBinding = {
  texture: Texture;
  /** The map's size in pixels: the drawing buffer the line is drawn into. */
  width: number;
  height: number;
  /** The camera's depth range, as its projection matrix has it. */
  near: number;
  far: number;
  /** World size of one map pixel at unit view distance (perspective) or anywhere (orthographic). */
  pixel: number;
};

/**
 * A `LineMaterial` for a curve's line: visible where its centerline is,
 * against the faces' depth map bound for the frame ({@link bindFaceDepth}).
 * Unbound, it draws as `LineMaterial` does.
 */
export class CurveLineMaterial extends LineMaterial {
  readonly isCurveLineMaterial = true;

  constructor(parameters?: LineMaterialParameters) {
    super(parameters);
    this.vertexShader = CURVE_LINE_VERTEX_SHADER;
    this.fragmentShader = CURVE_LINE_FRAGMENT_SHADER;
    Object.assign(this.uniforms, {
      faceDepth: { value: null },
      faceDepthSize: { value: new Vector2(1, 1) },
      faceDepthReady: { value: 0 },
      faceDepthNear: { value: 0 },
      faceDepthFar: { value: 1 },
      faceDepthPixel: { value: 0 },
      curveSag: { value: 0 },
    });
  }

  /**
   * Bind the frame's face map, with the curve's chordal sag in world units;
   * null unbinds (the map is dropped after the frame, so a clone taken
   * between frames copies no render target texture).
   */
  bindFaceDepth(binding: FaceDepthBinding | null, curveSag = 0): void {
    const uniforms = this.uniforms;
    uniforms.faceDepth.value = binding?.texture ?? null;
    uniforms.faceDepthReady.value = binding ? 1 : 0;
    uniforms.curveSag.value = binding ? curveSag : 0;
    if (binding) {
      (uniforms.faceDepthSize.value as Vector2).set(binding.width, binding.height);
      uniforms.faceDepthNear.value = binding.near;
      uniforms.faceDepthFar.value = binding.far;
      uniforms.faceDepthPixel.value = binding.pixel;
    }
  }
}

/** Whether `material` is a {@link CurveLineMaterial}. */
export function isCurveLineMaterial(material: unknown): material is CurveLineMaterial {
  return Boolean((material as Partial<CurveLineMaterial> | null)?.isCurveLineMaterial);
}
