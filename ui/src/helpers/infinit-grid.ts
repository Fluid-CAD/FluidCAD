import { Color, FrontSide, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';

/** Optional in-plane frame: aligns the grid lattice with a sketch plane's
 * x/y directions and anchors a lattice crossing at its origin. Without it
 * the tangent basis is derived from the normal alone (default 3D view). */
export type GridFrame = { xDirection: Vector3; origin: Vector3 };

// Author: Fyrestar https://mevedia.com (https://github.com/Fyrestar/THREE.InfiniteGridHelper)
class InfiniteGridHelper extends Mesh {
    constructor(
        size1 : number = 10,
        size2 : number = 100,
        color = new Color('white'),
        distance : number = 8000,
        normal : Vector3 = new Vector3(0, 1, 0),
        frame? : GridFrame
    ) {

        const geometry = new PlaneGeometry(2, 2, 1, 1);

        const material = new ShaderMaterial({

            side: FrontSide,
            polygonOffset: true,
            polygonOffsetFactor: 2,
            polygonOffsetUnits: 2,

            uniforms: {
                uSize1: {
                    value: size1
                },
                uSize2: {
                    value: size2
                },
                uColor: {
                    value: color
                },
                uDistance: {
                    value: distance
                },
                uNormal: {
                    value: normal.normalize()
                },
                // Zero = derive the tangent from the normal (legacy behavior).
                uXDir: {
                    value: frame ? frame.xDirection.clone().normalize() : new Vector3(0, 0, 0)
                },
                uOrigin: {
                    value: frame ? frame.origin.clone() : new Vector3(0, 0, 0)
                },
                // Per-frame camera state for the fragment-side ray cast (see
                // onBeforeRender): the plane point the quad lies on, and the
                // matrices that turn a pixel back into a world-space ray.
                uPlanePoint: {
                    value: new Vector3(0, 0, 0)
                },
                uInvProjection: {
                    value: new Matrix4()
                },
                uCameraWorld: {
                    value: new Matrix4()
                },
                uViewport: {
                    value: new Vector2(1, 1)
                }
            },
            transparent: true,
            vertexShader: `

            uniform float uDistance;
            uniform vec3 uNormal;
            uniform vec3 uXDir;

            void main() {
                    // In-plane basis: the sketch frame when provided, else
                    // derived from the normal alone.
                    vec3 tangent;
                    if (dot(uXDir, uXDir) > 0.5) {
                        tangent = normalize(uXDir);
                    } else {
                        vec3 up = abs(uNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                        tangent = normalize(cross(uNormal, up));
                    }
                    vec3 bitangent = normalize(cross(uNormal, tangent));

                    // Span the quad around the camera's projection onto the
                    // plane. The quad only provides coverage: the fragment
                    // shader reconstructs each pixel's plane point itself.
                    float dist = dot(cameraPosition, uNormal);
                    vec3 projectedCamera = cameraPosition - uNormal * dist;
                    vec3 pos = (position.x * tangent + position.y * bitangent) * uDistance + projectedCamera;

                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

            }
            `,


            fragmentShader: `

            uniform float uSize1;
            uniform float uSize2;
            uniform vec3 uColor;
            uniform float uDistance;
            uniform vec3 uNormal;
            uniform vec3 uXDir;
            uniform vec3 uOrigin;
            uniform vec3 uPlanePoint;
            uniform mat4 uInvProjection;
            uniform mat4 uCameraWorld;
            uniform vec2 uViewport;

                float getGrid(float size, vec2 coords) {

                    vec2 r = coords / size;

                    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
                    float line = min(grid.x, grid.y);

                    return 1.0 - min(line, 1.0);
                }

                // Pixel → world point on the near (z = -1) or far (z = 1)
                // plane; the w-divide makes this valid for both projections.
                vec3 unproject(vec2 ndc, float z) {
                    vec4 v = uInvProjection * vec4(ndc, z, 1.0);
                    vec3 view = v.xyz / v.w;
                    return (uCameraWorld * vec4(view, 1.0)).xyz;
                }

            void main() {

                    vec3 tangent;
                    if (dot(uXDir, uXDir) > 0.5) {
                        tangent = normalize(uXDir);
                    } else {
                        vec3 up = abs(uNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                        tangent = normalize(cross(uNormal, up));
                    }
                    vec3 bitangent = normalize(cross(uNormal, tangent));

                    // Ray-cast this pixel onto the grid plane. Interpolating
                    // the quad's corner coordinates instead would carry
                    // float32 error at the QUAD's magnitude (≈ 0.008 at 1e5),
                    // which erased any sub-millimetre lattice; the cast's
                    // error scales with the pixel's own distance from the
                    // camera, so the quad can stay effectively infinite.
                    vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
                    vec3 a = unproject(ndc, -1.0);
                    vec3 b = unproject(ndc, 1.0);
                    vec3 n = normalize(uNormal);
                    float denom = dot(b - a, n);
                    if (abs(denom) < 1e-20) discard;
                    float t = dot(uPlanePoint - a, n) / denom;
                    vec3 p = a + t * (b - a);

                    vec2 coords = vec2(dot(p - uOrigin, tangent), dot(p - uOrigin, bitangent));
                    vec2 cameraPlanar = vec2(dot(cameraPosition - uOrigin, tangent), dot(cameraPosition - uOrigin, bitangent));

                    float d = 1.0 - min(distance(cameraPlanar, coords) / uDistance, 1.0);

                    float g1 = getGrid(uSize1, coords);
                    float g2 = getGrid(uSize2, coords);

                    gl_FragColor = vec4(uColor.rgb, mix(g2, g1, g1) * pow(d, 3.0));
                    gl_FragColor.a = mix(0.5 * gl_FragColor.a, gl_FragColor.a, g2);

                    if ( gl_FragColor.a <= 0.0 ) discard;

            }

            `,

            extensions: {
                clipCullDistance: false,
                multiDraw: false
            }

        });


        super(geometry, material);

        this.frustumCulled = false;

        // The fragment ray cast needs this frame's camera and viewport.
        const size = new Vector2();
        this.onBeforeRender = (renderer : WebGLRenderer, _scene : Scene, camera : Camera) => {
            const uniforms = (this.material as ShaderMaterial).uniforms;
            uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
            uniforms.uCameraWorld.value.copy(camera.matrixWorld);
            renderer.getDrawingBufferSize(size);
            uniforms.uViewport.value.set(size.x, size.y);
            this.getWorldPosition(uniforms.uPlanePoint.value);
        };
    }

    /**
     * Re-pitch the lattice. `uSize1/uSize2` are plain uniforms, so a zoom
     * change re-grids for the price of two floats — no rebuild.
     */
    setSpacing(minor : number, major : number) : void {
        const uniforms = (this.material as ShaderMaterial).uniforms;
        uniforms.uSize1.value = minor;
        uniforms.uSize2.value = major;
    }

    /**
     * Re-size the quad / fade radius. Precision no longer depends on it (the
     * fragment shader ray-casts each pixel), so it only has to be large
     * enough that the grid reads as infinite from wherever the camera is.
     */
    setExtent(distance : number) : void {
        (this.material as ShaderMaterial).uniforms.uDistance.value = distance;
    }
};

export default InfiniteGridHelper;
