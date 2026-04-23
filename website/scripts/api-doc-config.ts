export type FeatureCategory = '2d' | '3d' | 'transforms' | 'utilities';

export interface FeatureEntry {
  name: string;
  displayName: string;
  category: FeatureCategory | FeatureCategory[];
  sourceFile: string;
  interfaceName: string | null;
  returnType: string;
  relatedGuide?: string;
  sidebarPosition: number;
  /** Override sidebarPosition per category (for multi-category features) */
  sidebarPositions?: Partial<Record<FeatureCategory, number>>;
}

export interface TypeEntry {
  name: string;
  displayName: string;
  sourceFile: string;
  extendsType?: string;
  sidebarPosition: number;
}

export interface FilterEntry {
  name: string;
  displayName: string;
  sourceFile: string;
  className: string;
  factoryName: string;
  factoryDescription: string;
  sidebarPosition: number;
}

export interface ConstraintEntry {
  name: string;
  sourceFile: string;
  functionName: string;
}

export const categoryLabels: Record<FeatureCategory, string> = {
  '2d': '2D Sketching',
  '3d': '3D Operations',
  'transforms': 'Transforms',
  'utilities': 'Utilities',
};

export const categoryPositions: Record<FeatureCategory, number> = {
  '2d': 1,
  '3d': 2,
  'transforms': 3,
  'utilities': 4,
};

export const features: FeatureEntry[] = [
  // 2D Sketching — Basic Geometry
  { name: 'line', displayName: 'line', category: '2d', sourceFile: 'core/2d/line.ts', interfaceName: 'LineFunction', returnType: 'IGeometry', relatedGuide: '/docs/guides/sketching/introduction', sidebarPosition: 1 },
  { name: 'arc', displayName: 'arc', category: '2d', sourceFile: 'core/2d/arc.ts', interfaceName: 'ArcFunction', returnType: 'IArcPoints | IArcAngles', sidebarPosition: 2 },
  { name: 'circle', displayName: 'circle', category: '2d', sourceFile: 'core/2d/circle.ts', interfaceName: 'CircleFunction', returnType: 'IExtrudableGeometry', relatedGuide: '/docs/guides/sketching/primitive-shapes', sidebarPosition: 3 },
  { name: 'rect', displayName: 'rect', category: '2d', sourceFile: 'core/2d/rect.ts', interfaceName: 'RectFunction', returnType: 'IRect', relatedGuide: '/docs/guides/sketching/primitive-shapes', sidebarPosition: 4 },
  { name: 'slot', displayName: 'slot', category: '2d', sourceFile: 'core/2d/slot.ts', interfaceName: 'SlotFunction', returnType: 'ISlot', sidebarPosition: 5 },
  { name: 'polygon', displayName: 'polygon', category: '2d', sourceFile: 'core/2d/polygon.ts', interfaceName: 'PolygonFunction', returnType: 'IPolygon', sidebarPosition: 6 },
  { name: 'bezier', displayName: 'bezier', category: '2d', sourceFile: 'core/2d/bezier.ts', interfaceName: 'BezierFunction', returnType: 'IGeometry', sidebarPosition: 7 },
  // 2D Sketching — Line Shortcuts
  { name: 'hLine', displayName: 'hLine', category: '2d', sourceFile: 'core/2d/hline.ts', interfaceName: 'HLineFunction', returnType: 'IGeometry', sidebarPosition: 8 },
  { name: 'vLine', displayName: 'vLine', category: '2d', sourceFile: 'core/2d/vline.ts', interfaceName: 'VLineFunction', returnType: 'IGeometry', sidebarPosition: 9 },
  { name: 'aLine', displayName: 'aLine', category: '2d', sourceFile: 'core/2d/aline.ts', interfaceName: 'ALineFunction', returnType: 'IGeometry', sidebarPosition: 10 },
  // 2D Sketching — Positioning
  { name: 'center', displayName: 'center', category: '2d', sourceFile: 'core/2d/center.ts', interfaceName: 'CenterFunction', returnType: 'IGeometry', sidebarPosition: 11 },
  { name: 'move', displayName: 'move', category: '2d', sourceFile: 'core/2d/move.ts', interfaceName: 'MoveFunction', returnType: 'IGeometry', sidebarPosition: 12 },
  { name: 'hMove', displayName: 'hMove', category: '2d', sourceFile: 'core/2d/hmove.ts', interfaceName: 'HMoveFunction', returnType: 'void', sidebarPosition: 13 },
  { name: 'vMove', displayName: 'vMove', category: '2d', sourceFile: 'core/2d/vmove.ts', interfaceName: 'VMoveFunction', returnType: 'void', sidebarPosition: 14 },
  { name: 'rMove', displayName: 'rMove', category: '2d', sourceFile: 'core/2d/rmove.ts', interfaceName: 'RMoveFunction', returnType: 'IGeometry', sidebarPosition: 15 },
  { name: 'pMove', displayName: 'pMove', category: '2d', sourceFile: 'core/2d/pmove.ts', interfaceName: 'PolarMoveFunction', returnType: 'IGeometry', sidebarPosition: 16 },
  // 2D Sketching — Constrained Geometry
  { name: 'tLine', displayName: 'tLine', category: '2d', sourceFile: 'core/2d/tline.ts', interfaceName: 'TLineFunction', returnType: 'IGeometry', relatedGuide: '/docs/guides/sketching/constrained-geometry', sidebarPosition: 17 },
  { name: 'tCircle', displayName: 'tCircle', category: '2d', sourceFile: 'core/2d/tcircle.ts', interfaceName: 'TCircleFunction', returnType: 'IGeometry', relatedGuide: '/docs/guides/sketching/constrained-geometry', sidebarPosition: 18 },
  { name: 'tArc', displayName: 'tArc', category: '2d', sourceFile: 'core/2d/tarc.ts', interfaceName: 'TArcFunction', returnType: 'IGeometry', relatedGuide: '/docs/guides/sketching/constrained-geometry', sidebarPosition: 19 },
  { name: 'connect', displayName: 'connect', category: '2d', sourceFile: 'core/2d/connect.ts', interfaceName: 'ConnectFunction', returnType: 'IGeometry', sidebarPosition: 20 },
  // 2D Sketching — Advanced Operations
  { name: 'offset', displayName: 'offset', category: '2d', sourceFile: 'core/2d/offset.ts', interfaceName: 'OffsetFunction', returnType: 'IExtrudableGeometry', relatedGuide: '/docs/guides/sketching/offset', sidebarPosition: 21 },

  // 3D Operations
  { name: 'sketch', displayName: 'sketch', category: '3d', sourceFile: 'core/sketch.ts', interfaceName: 'SketchFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/sketching/introduction', sidebarPosition: 1 },
  { name: 'extrude', displayName: 'extrude', category: '3d', sourceFile: 'core/extrude.ts', interfaceName: 'ExtrudeFunction', returnType: 'IExtrude', relatedGuide: '/docs/guides/3d-operations/extrude', sidebarPosition: 2 },
  { name: 'cut', displayName: 'cut', category: '3d', sourceFile: 'core/cut.ts', interfaceName: 'CutFunction', returnType: 'ICut', relatedGuide: '/docs/guides/3d-operations/cut', sidebarPosition: 3 },
  { name: 'revolve', displayName: 'revolve', category: '3d', sourceFile: 'core/revolve.ts', interfaceName: 'RevolveFunction', returnType: 'IRevolve', relatedGuide: '/docs/guides/3d-operations/revolve', sidebarPosition: 4 },
  { name: 'loft', displayName: 'loft', category: '3d', sourceFile: 'core/loft.ts', interfaceName: 'LoftFunction', returnType: 'ILoft', relatedGuide: '/docs/guides/3d-operations/loft', sidebarPosition: 5 },
  { name: 'sweep', displayName: 'sweep', category: '3d', sourceFile: 'core/sweep.ts', interfaceName: 'SweepFunction', returnType: 'ISweep', relatedGuide: '/docs/guides/3d-operations/sweep', sidebarPosition: 6 },
  { name: 'sphere', displayName: 'sphere', category: '3d', sourceFile: 'core/sphere.ts', interfaceName: 'SphereFunction', returnType: 'ITransformable', sidebarPosition: 7 },
  { name: 'cylinder', displayName: 'cylinder', category: '3d', sourceFile: 'core/cylinder.ts', interfaceName: 'CylinderFunction', returnType: 'ITransformable', sidebarPosition: 8 },
  { name: 'fuse', displayName: 'fuse', category: ['2d', '3d'], sourceFile: 'core/fuse.ts', interfaceName: 'FuseFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/booleans-and-fusion', sidebarPosition: 9, sidebarPositions: { '2d': 29 } },
  { name: 'subtract', displayName: 'subtract', category: ['2d', '3d'], sourceFile: 'core/subtract.ts', interfaceName: 'SubtractFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/booleans-and-fusion', sidebarPosition: 10, sidebarPositions: { '2d': 30 } },
  { name: 'common', displayName: 'common', category: ['2d', '3d'], sourceFile: 'core/common.ts', interfaceName: 'CommonFunction', returnType: 'ICommon', relatedGuide: '/docs/guides/booleans-and-fusion', sidebarPosition: 11, sidebarPositions: { '2d': 31 } },
  { name: 'shell', displayName: 'shell', category: '3d', sourceFile: 'core/shell.ts', interfaceName: 'ShellFunction', returnType: 'IShell', relatedGuide: '/docs/guides/3d-operations/shell', sidebarPosition: 12 },
  { name: 'fillet', displayName: 'fillet', category: '3d', sourceFile: 'core/fillet.ts', interfaceName: 'FilletFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/3d-operations/fillet', sidebarPosition: 13 },
  { name: 'chamfer', displayName: 'chamfer', category: '3d', sourceFile: 'core/chamfer.ts', interfaceName: 'ChamferFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/3d-operations/chamfer', sidebarPosition: 14 },
  { name: 'draft', displayName: 'draft', category: '3d', sourceFile: 'core/draft.ts', interfaceName: 'DraftFunction', returnType: 'IDraft', sidebarPosition: 15 },

  // Transforms
  { name: 'translate', displayName: 'translate', category: 'transforms', sourceFile: 'core/translate.ts', interfaceName: 'TranslateFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/transforms', sidebarPosition: 1 },
  { name: 'rotate', displayName: 'rotate', category: ['2d', 'transforms'], sourceFile: 'core/rotate.ts', interfaceName: 'RotateFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/transforms', sidebarPosition: 2, sidebarPositions: { '2d': 26 } },
  { name: 'mirror', displayName: 'mirror', category: ['2d', 'transforms'], sourceFile: 'core/mirror.ts', interfaceName: 'MirrorFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/transforms', sidebarPosition: 3, sidebarPositions: { '2d': 27 } },
  { name: 'copy', displayName: 'copy', category: ['2d', 'transforms'], sourceFile: 'core/copy.ts', interfaceName: 'CopyFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/copying', sidebarPosition: 4, sidebarPositions: { '2d': 28 } },
  { name: 'repeat', displayName: 'repeat', category: 'transforms', sourceFile: 'core/repeat.ts', interfaceName: 'RepeatFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/patterns', sidebarPosition: 5 },

  // Utilities
  { name: 'select', displayName: 'select', category: 'utilities', sourceFile: 'core/select.ts', interfaceName: 'SelectFunction', returnType: 'ISelect', relatedGuide: '/docs/guides/selections-and-filters', sidebarPosition: 1 },
  { name: 'color', displayName: 'color', category: 'utilities', sourceFile: 'core/color.ts', interfaceName: 'ColorFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/3d-operations/color', sidebarPosition: 2 },
  { name: 'remove', displayName: 'remove', category: 'utilities', sourceFile: 'core/remove.ts', interfaceName: 'RemoveFunction', returnType: 'ISceneObject', sidebarPosition: 3 },
  { name: 'load', displayName: 'load', category: 'utilities', sourceFile: 'core/load.ts', interfaceName: 'LoadFunction', returnType: 'ISceneObject', relatedGuide: '/docs/guides/import', sidebarPosition: 4 },
  { name: 'axis', displayName: 'axis', category: 'utilities', sourceFile: 'core/axis.ts', interfaceName: 'AxisFunction', returnType: 'IAxis', sidebarPosition: 5 },
  { name: 'plane', displayName: 'plane', category: 'utilities', sourceFile: 'core/plane.ts', interfaceName: 'PlaneFunction', returnType: 'IPlane', sidebarPosition: 6 },
  { name: 'local', displayName: 'local', category: 'utilities', sourceFile: 'core/local.ts', interfaceName: 'LocalFunction', returnType: 'IAxis', relatedGuide: '/docs/guides/sketching/transforms', sidebarPosition: 7 },
  { name: 'split', displayName: 'split', category: '2d', sourceFile: 'core/split.ts', interfaceName: 'SplitFunction', returnType: 'ISceneObject', sidebarPosition: 22 },
  { name: 'trim', displayName: 'trim', category: '2d', sourceFile: 'core/trim.ts', interfaceName: 'TrimFunction', returnType: 'ITrim', relatedGuide: '/docs/guides/sketching/trim', sidebarPosition: 23 },
  { name: 'project', displayName: 'project', category: '2d', sourceFile: 'core/2d/project.ts', interfaceName: 'ProjectFunction', returnType: 'IExtrudableGeometry', relatedGuide: '/docs/guides/sketching/projection', sidebarPosition: 24 },
  { name: 'intersect', displayName: 'intersect', category: '2d', sourceFile: 'core/2d/intersect.ts', interfaceName: 'IntersectFunction', returnType: 'IExtrudableGeometry', sidebarPosition: 25 },
  { name: 'part', displayName: 'part', category: 'utilities', sourceFile: 'core/part.ts', interfaceName: null, returnType: 'ISceneObject', relatedGuide: '/docs/guides/3d-operations/parts', sidebarPosition: 9 },
];

export const types: TypeEntry[] = [
  { name: 'ISceneObject', displayName: 'SceneObject', sourceFile: 'core/interfaces.ts', sidebarPosition: 1 },
  { name: 'ITransformable', displayName: 'Transformable', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 2 },
  { name: 'IBooleanOperation', displayName: 'BooleanOperation', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 3 },
  { name: 'IGeometry', displayName: 'Geometry', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 4 },
  { name: 'IExtrudableGeometry', displayName: 'ExtrudableGeometry', sourceFile: 'core/interfaces.ts', extendsType: 'IGeometry', sidebarPosition: 5 },
  { name: 'IExtrude', displayName: 'Extrude', sourceFile: 'core/interfaces.ts', extendsType: 'IBooleanOperation', sidebarPosition: 6 },
  { name: 'ICut', displayName: 'Cut', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 7 },
  { name: 'IRevolve', displayName: 'Revolve', sourceFile: 'core/interfaces.ts', extendsType: 'IBooleanOperation', sidebarPosition: 8 },
  { name: 'ILoft', displayName: 'Loft', sourceFile: 'core/interfaces.ts', extendsType: 'IBooleanOperation', sidebarPosition: 9 },
  { name: 'ISweep', displayName: 'Sweep', sourceFile: 'core/interfaces.ts', extendsType: 'IBooleanOperation', sidebarPosition: 10 },
  { name: 'ICommon', displayName: 'Common', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 11 },
  { name: 'IShell', displayName: 'Shell', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 12 },
  { name: 'IDraft', displayName: 'Draft', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 29 },
  { name: 'IArcPoints', displayName: 'ArcPoints', sourceFile: 'core/interfaces.ts', extendsType: 'IExtrudableGeometry', sidebarPosition: 13 },
  { name: 'IArcAngles', displayName: 'ArcAngles', sourceFile: 'core/interfaces.ts', extendsType: 'IExtrudableGeometry', sidebarPosition: 14 },
  { name: 'IRect', displayName: 'Rect', sourceFile: 'core/interfaces.ts', extendsType: 'IExtrudableGeometry', sidebarPosition: 15 },
  { name: 'ISlot', displayName: 'Slot', sourceFile: 'core/interfaces.ts', extendsType: 'IExtrudableGeometry', sidebarPosition: 16 },
  { name: 'IPolygon', displayName: 'Polygon', sourceFile: 'core/interfaces.ts', extendsType: 'IExtrudableGeometry', sidebarPosition: 17 },
  { name: 'IPlane', displayName: 'Plane', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 18 },
  { name: 'IAxis', displayName: 'Axis', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 19 },
  { name: 'ISelect', displayName: 'Select', sourceFile: 'core/interfaces.ts', extendsType: 'ISceneObject', sidebarPosition: 20 },
  { name: 'ITwoObjectsTangentLine', displayName: 'TwoObjectsTangentLine', sourceFile: 'core/interfaces.ts', extendsType: 'IGeometry', sidebarPosition: 21 },
  { name: 'ITangentArcTwoObjects', displayName: 'TangentArcTwoObjects', sourceFile: 'core/interfaces.ts', extendsType: 'IGeometry', sidebarPosition: 22 },
  { name: 'Point2DLike', displayName: 'Point2DLike', sourceFile: 'math/point.ts', sidebarPosition: 23 },
  { name: 'PointLike', displayName: 'PointLike', sourceFile: 'math/point.ts', sidebarPosition: 24 },
  { name: 'PlaneLike', displayName: 'PlaneLike', sourceFile: 'math/plane.ts', sidebarPosition: 25 },
  { name: 'AxisLike', displayName: 'AxisLike', sourceFile: 'math/axis.ts', sidebarPosition: 26 },
  { name: 'LazyVertex', displayName: 'Vertex', sourceFile: 'features/lazy-vertex.ts', sidebarPosition: 27 },
  { name: 'LinearRepeatOptions', displayName: 'LinearRepeatOptions', sourceFile: 'features/repeat-linear.ts', sidebarPosition: 28 },
  { name: 'CircularRepeatOptions', displayName: 'CircularRepeatOptions', sourceFile: 'features/repeat-circular.ts', sidebarPosition: 29 },
  { name: 'PlaneTransformOptions', displayName: 'PlaneTransformOptions', sourceFile: 'math/plane.ts', sidebarPosition: 30 },
  { name: 'ITrim', displayName: 'Trim', sourceFile: 'core/trim.ts', sidebarPosition: 31 },
];

export const filters: FilterEntry[] = [
  {
    name: 'face',
    displayName: 'FaceFilter',
    sourceFile: 'filters/face/face-filter.ts',
    className: 'FaceFilterBuilder',
    factoryName: 'face',
    factoryDescription: 'Creates a new face filter builder for selecting faces by geometric properties.',
    sidebarPosition: 1,
  },
  {
    name: 'edge',
    displayName: 'EdgeFilter',
    sourceFile: 'filters/edge/edge-filter.ts',
    className: 'EdgeFilterBuilder',
    factoryName: 'edge',
    factoryDescription: 'Creates a new edge filter builder for selecting edges by geometric properties.',
    sidebarPosition: 2,
  },
];

export const constraints: ConstraintEntry[] = [
  { name: 'outside', sourceFile: 'features/2d/constraints/geometry-qualifier.ts', functionName: 'outside' },
  { name: 'enclosed', sourceFile: 'features/2d/constraints/geometry-qualifier.ts', functionName: 'enclosed' },
  { name: 'enclosing', sourceFile: 'features/2d/constraints/geometry-qualifier.ts', functionName: 'enclosing' },
  { name: 'unqualified', sourceFile: 'features/2d/constraints/geometry-qualifier.ts', functionName: 'unqualified' },
];

// ── Expandable options types ──
// These appear as param types in signatures and get expanded into property tables

export interface OptionsProperty {
  name: string;
  type: string;
  description: string;
  optional: boolean;
}

export const optionsTypeProperties: Record<string, OptionsProperty[]> = {
  LinearRepeatOptions: [
    { name: 'count', type: 'number | number[]', description: 'Number of instances per axis (including the original)', optional: false },
    { name: 'offset', type: 'number | number[]', description: 'Spacing between each instance. Cannot be used with `length`.', optional: true },
    { name: 'length', type: 'number | number[]', description: 'Total span to distribute instances across (evenly spaced). Cannot be used with `offset`.', optional: true },
    { name: 'centered', type: 'boolean', description: 'When `true`, centers the pattern around the original object\'s position', optional: true },
    { name: 'skip', type: 'number[][]', description: 'Index tuples to skip (e.g. `[[1], [3]]` for single axis, `[[1, 2]]` for multi-axis)', optional: true },
  ],
  CircularRepeatOptions: [
    { name: 'count', type: 'number', description: 'Number of instances (including the original)', optional: false },
    { name: 'angle', type: 'number', description: 'Total angle to spread across. Cannot be used with `offset`.', optional: true },
    { name: 'offset', type: 'number', description: 'Angle between each instance. Cannot be used with `angle`.', optional: true },
    { name: 'centered', type: 'boolean', description: 'When `true`, centers the pattern around the original object\'s position', optional: true },
    { name: 'skip', type: 'number[]', description: 'Indices to skip (e.g. `[2, 4]` to skip the 3rd and 5th instances)', optional: true },
  ],
  PlaneTransformOptions: [
    { name: 'offset', type: 'number', description: 'Distance to translate the plane along its normal', optional: true },
    { name: 'rotateX', type: 'number', description: 'Rotation around the plane\'s X axis (in degrees)', optional: true },
    { name: 'rotateY', type: 'number', description: 'Rotation around the plane\'s Y axis (in degrees)', optional: true },
    { name: 'rotateZ', type: 'number', description: 'Rotation around the plane\'s Z axis / normal (in degrees)', optional: true },
  ],
};

/** Maps internal type names to display names for the docs */
export const typeDisplayNameMap: Record<string, string> = {
  'ISceneObject': 'SceneObject',
  'ITransformable': 'Transformable',
  'IBooleanOperation': 'BooleanOperation',
  'IGeometry': 'Geometry',
  'IExtrudableGeometry': 'ExtrudableGeometry',
  'IExtrude': 'Extrude',
  'ICut': 'Cut',
  'IRevolve': 'Revolve',
  'ILoft': 'Loft',
  'ISweep': 'Sweep',
  'ICommon': 'Common',
  'IShell': 'Shell',
  'IDraft': 'Draft',
  'IArcPoints': 'ArcPoints',
  'IArcAngles': 'ArcAngles',
  'IRect': 'Rect',
  'ISlot': 'Slot',
  'IPolygon': 'Polygon',
  'IPlane': 'Plane',
  'IAxis': 'Axis',
  'ISelect': 'Select',
  'ITwoObjectsTangentLine': 'TwoObjectsTangentLine',
  'ITangentArcTwoObjects': 'TangentArcTwoObjects',
  'FaceFilterBuilder': 'FaceFilter',
  'EdgeFilterBuilder': 'EdgeFilter',
  'Point2DLike': 'Point2DLike',
  'PointLike': 'PointLike',
  'PlaneLike': 'PlaneLike',
  'PlaneObjectBase': 'PlaneLike',
  'AxisLike': 'AxisLike',
  'AxisObjectBase': 'AxisLike',
  'LazyVertex': 'Vertex',
  'ITrim': 'Trim',
  'QualifiedSceneObject': 'QualifiedGeometry',
  'LinearRepeatOptions': 'LinearRepeatOptions',
  'CircularRepeatOptions': 'CircularRepeatOptions',
  'PlaneTransformOptions': 'PlaneTransformOptions',
  'PlaneRenderableOptions': 'PlaneTransformOptions',
};

/** Maps type display names to their docs URL slug */
export function typeSlug(displayName: string): string {
  // Convert PascalCase/camelCase to kebab-case
  return displayName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Resolves a raw type string to its display name */
export function resolveTypeName(raw: string): string {
  // Handle union types: resolve each part individually
  if (raw.includes(' | ')) {
    return raw.split(' | ').map(part => resolveTypeName(part.trim())).join(' | ');
  }
  // Handle parenthesized array wrapper: (Foo | Bar)[]
  const parenArrayMatch = raw.match(/^\((.+)\)\[\]$/);
  if (parenArrayMatch) {
    return `(${resolveTypeName(parenArrayMatch[1])})[]`;
  }
  // Handle simple array type: Foo[]
  const simpleArrayMatch = raw.match(/^(.+)\[\]$/);
  if (simpleArrayMatch) {
    return `${resolveTypeName(simpleArrayMatch[1])}[]`;
  }
  // Strip generic parameters for lookup
  const base = raw.replace(/<.*>$/, '').trim();
  return typeDisplayNameMap[base] || typeDisplayNameMap[raw] || raw;
}

/** Checks if a type has a dedicated docs page */
export function hasTypePage(typeName: string): boolean {
  const displayName = resolveTypeName(typeName);
  return types.some(t => t.displayName === displayName);
}

/** Returns the full inheritance chain for a type (parent, grandparent, etc.) */
export function getInheritanceChain(typeName: string): TypeEntry[] {
  const chain: TypeEntry[] = [];
  let current = types.find(t => t.name === typeName);
  while (current?.extendsType) {
    const parent = types.find(t => t.name === current!.extendsType);
    if (parent) {
      chain.push(parent);
      current = parent;
    } else {
      break;
    }
  }
  return chain;
}
