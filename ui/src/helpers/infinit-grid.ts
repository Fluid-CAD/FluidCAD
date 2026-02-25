import { Color, FrontSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

// Author: Fyrestar https://mevedia.com (https://github.com/Fyrestar/THREE.InfiniteGridHelper)
class InfiniteGridHelper extends Mesh {
    constructor(
        size1 : number = 10,
        size2 : number = 100,
        color = new Color('white'),
        distance : number = 8000,
        normal : Vector3 = new Vector3(0, 1, 0)
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
                }
            },
            transparent: true,
            vertexShader: `

            varying vec3 worldPosition;

            uniform float uDistance;
            uniform vec3 uNormal;

            void main() {
                    // Create a coordinate system based on the normal
                    vec3 up = abs(uNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                    vec3 tangent = normalize(cross(uNormal, up));
                    vec3 bitangent = cross(uNormal, tangent);

                    // Transform the position to align with the plane defined by the normal
                    vec3 pos = (position.x * tangent + position.y * bitangent) * uDistance;
                    pos += cameraPosition;

                    // Project camera position onto the plane
                    float dist = dot(cameraPosition, uNormal);
                    vec3 projectedCamera = cameraPosition - uNormal * dist;
                    pos = (position.x * tangent + position.y * bitangent) * uDistance + projectedCamera;

                    worldPosition = pos;

                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

            }
            `,


            fragmentShader: `

            varying vec3 worldPosition;

            uniform float uSize1;
            uniform float uSize2;
            uniform vec3 uColor;
            uniform float uDistance;
            uniform vec3 uNormal;



                float getGrid(float size, vec2 coords) {

                    vec2 r = coords / size;

                    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
                    float line = min(grid.x, grid.y);

                    return 1.0 - min(line, 1.0);
                }

            void main() {
                    // Create the same coordinate system as in vertex shader
                    vec3 up = abs(uNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                    vec3 tangent = normalize(cross(uNormal, up));
                    vec3 bitangent = cross(uNormal, tangent);

                    // Project world position onto the plane coordinate system
                    vec2 planeCoords = vec2(dot(worldPosition, tangent), dot(worldPosition, bitangent));

                    // Project camera position onto the plane coordinate system
                    vec2 cameraPlanarPos = vec2(dot(cameraPosition, tangent), dot(cameraPosition, bitangent));

                    float d = 1.0 - min(distance(cameraPlanarPos, planeCoords) / uDistance, 1.0);

                    float g1 = getGrid(uSize1, planeCoords);
                    float g2 = getGrid(uSize2, planeCoords);

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
};

export default InfiniteGridHelper;
