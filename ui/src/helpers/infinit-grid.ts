import { Color, FrontSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

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
                }
            },
            transparent: true,
            vertexShader: `

            varying vec2 vPlaneCoords;
            varying vec2 vCameraPlanar;

            uniform float uDistance;
            uniform vec3 uNormal;
            uniform vec3 uXDir;
            uniform vec3 uOrigin;

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

                    // Span the quad around the camera's projection onto the plane.
                    float dist = dot(cameraPosition, uNormal);
                    vec3 projectedCamera = cameraPosition - uNormal * dist;
                    vec3 pos = (position.x * tangent + position.y * bitangent) * uDistance + projectedCamera;

                    // Lattice coordinates relative to the anchor, in TRUE world
                    // space (the mesh's translation onto the sketch plane counts),
                    // so grid lines run along the frame and cross at the origin.
                    vec3 world = (modelMatrix * vec4(pos, 1.0)).xyz;
                    vPlaneCoords = vec2(dot(world - uOrigin, tangent), dot(world - uOrigin, bitangent));
                    vCameraPlanar = vec2(dot(cameraPosition - uOrigin, tangent), dot(cameraPosition - uOrigin, bitangent));

                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

            }
            `,


            fragmentShader: `

            varying vec2 vPlaneCoords;
            varying vec2 vCameraPlanar;

            uniform float uSize1;
            uniform float uSize2;
            uniform vec3 uColor;
            uniform float uDistance;



                float getGrid(float size, vec2 coords) {

                    vec2 r = coords / size;

                    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
                    float line = min(grid.x, grid.y);

                    return 1.0 - min(line, 1.0);
                }

            void main() {

                    float d = 1.0 - min(distance(vCameraPlanar, vPlaneCoords) / uDistance, 1.0);

                    float g1 = getGrid(uSize1, vPlaneCoords);
                    float g2 = getGrid(uSize2, vPlaneCoords);

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
     * Re-size the quad / fade radius. The plane coordinates are varyings
     * interpolated from the quad's corners, so their precision near the
     * camera is float32's at `distance` magnitude (≈ 0.008 at 1e5): a fixed
     * extent erases any lattice finer than that once zoomed in. Callers
     * keep it a constant multiple of the visible height instead.
     */
    setExtent(distance : number) : void {
        (this.material as ShaderMaterial).uniforms.uDistance.value = distance;
    }
};

export default InfiniteGridHelper;
