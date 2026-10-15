/**
 * The engine's own scene types: every string a scene object of the engine
 * answers from `getType()` — features, sketch geometry and constraints,
 * datums, parts and assemblies, the engine's built-in custom features
 * (`draft`) — plus the few names the server and the UI read as a kind of
 * thing rather than as a type (`feature`, which a producer of any feature
 * is filed under).
 *
 * The server and the UI treat these types specially: a timeline row typed
 * `extrude` opens the Extrude dialog, `part` and `assembly` are found by
 * their type. A custom feature's type is its id, so the SDK refuses a
 * custom feature whose plain id is one of these (see
 * {@link SceneTypes.isEngineType}). A lib test keeps the list complete by
 * collecting every `getType()` literal under `lib/`.
 */
export class SceneTypes {
  static readonly ENGINE: ReadonlySet<string> = new Set([
    // Features and operations
    'chamfer', 'color', 'common', 'copy-circular', 'copy-linear', 'copy-pattern', 'cut', 'cylinder',
    'draft', 'extrude', 'fillet', 'fuse', 'helix', 'hole', 'load', 'loft', 'mirror', 'remove',
    'repeat-circular', 'repeat-linear', 'repeat-matrix', 'revolve', 'rib', 'rotate', 'section',
    'shell', 'sphere', 'subtract', 'sweep', 'translate', 'wrap',
    // Selections, datums and references
    'axis', 'connector', 'exposed', 'fixed-location', 'frozen-geometry', 'lazy-vertex', 'plane',
    'select', 'static',
    // Parts and assemblies
    'assembly', 'part', 'part-definition',
    // Sketches, their geometry and tools
    'arc', 'bezier', 'circle', 'ellipse', 'fillet2d', 'image', 'intersect', 'line', 'offset', 'point',
    'projection', 'rect', 'region', 'sketch', 'spline', 'text',
    // Sketch constraints (a constraint's type is its kind)
    'angle', 'coincident', 'collinear', 'concentric', 'diameter', 'distance', 'equal', 'fix',
    'horizontal', 'midpoint', 'offsetFrom', 'parallel', 'perpendicular', 'radius', 'symmetric',
    'tangent', 'vertical',
    // Read by the server as a kind, not a type
    'feature',
  ]);

  /** Whether `type` is one of the engine's own (see the class comment). */
  static isEngineType(type: string): boolean {
    return SceneTypes.ENGINE.has(type);
  }
}
