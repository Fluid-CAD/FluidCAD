// ---------------------------------------------------------------------------
// Vector / Plane data coming from the FluidCAD backend
// ---------------------------------------------------------------------------

export type Vec3Data = { x: number; y: number; z: number };

export type PlaneData = {
  origin: Vec3Data;
  center: Vec3Data;
  normal: Vec3Data;
  xDirection: Vec3Data;
  yDirection: Vec3Data;
};

// ---------------------------------------------------------------------------
// Object types — every FluidCAD feature / construction element the backend emits
// ---------------------------------------------------------------------------

export type ObjectType =
  // Construction geometry
  | 'sketch'
  | 'plane'
  | 'axis'
  // Selection overlay
  | 'select'
  // Primitives
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'torus'
  | 'wedge'
  // Feature operations
  | 'extrude'
  | 'revolve'
  | 'loft'
  | 'pipe'
  | 'helix'
  // Modification operations
  | 'fillet'
  | 'chamfer'
  | 'draft'
  | 'thickness'
  | 'mirror'
  | 'linear-pattern'
  | 'boolean'
  // Direct solid reference
  | 'solid'
  // Part containers
  | 'part';

// ---------------------------------------------------------------------------
// Shape types — the geometric representation of a scene object
// ---------------------------------------------------------------------------

export type ShapeType = 'solid' | 'face' | 'wire' | 'edge';

// ---------------------------------------------------------------------------
// Mesh render options
// ---------------------------------------------------------------------------

export type FaceMeshOptions = {
  color?: string;
  opacity?: number;
};

export type EdgeMeshOptions = {
  color?: string;
  lineWidth?: number;
  opacity?: number;
  depthWrite?: boolean;
};

export type MeshRenderOptions = {
  face?: FaceMeshOptions;
  edge?: EdgeMeshOptions;
};

// ---------------------------------------------------------------------------
// Scene object data transferred from the backend
// ---------------------------------------------------------------------------

export type SceneObjectMesh = {
  label?: string;
  vertices: number[];
  normals: number[];
  indices: number[];
  color?: string;
  faceMapping?: number[];
  edgeIndex?: number;
};

export type SubSelection =
  | { type: 'face'; index: number }
  | { type: 'edge'; index: number }
  | null;

export type SceneObjectPart = {
  shapeId?: string;
  meshes: SceneObjectMesh[];
  shapeType?: ShapeType;
  isMetaShape?: boolean;
  isGuide?: boolean;
  metaType?: string;
  metaData?: Record<string, any>;
};

export type SceneObjectRender = {
  id?: string;
  name?: string;
  parentId?: string | null;
  isContainer?: boolean;
  object?: any;
  sceneShapes: SceneObjectPart[];
  ownShapes: SceneObjectPart[];
  visible?: boolean;
  type?: ObjectType;
  uniqueType?: string;
  fromCache?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  sourceLocation?: { filePath: string; line: number; column: number };
  buildDurationMs?: number;
};

// ---------------------------------------------------------------------------
// Application state types (unrelated to 3D rendering)
// ---------------------------------------------------------------------------

export interface Viewer3dState {
  content: string;
  loading: boolean;
  error: string | null;
}

export interface CodeEditorState {
  currentFile: string | null;
  content: string;
  loading: boolean;
  error: string | null;
  isDirty: boolean;
}

export interface FileItem {
  name: string;
  isDirectory: boolean;
  path: string;
  children?: FileItem[];
  expanded?: boolean;
}
