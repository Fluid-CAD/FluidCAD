// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type SourceLocation = { filePath: string; line: number; column: number };

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

export type ConnectorData = {
  origin: Vec3Data;
  xDirection: Vec3Data;
  yDirection: Vec3Data;
  normal: Vec3Data;
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
  | 'part'
  // Assembly mate connectors
  | 'connector';

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
  transparent?: boolean;
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

export type CompileError = {
  message: string;
  filePath?: string;
  sourceLocation?: SourceLocation;
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
  sourceLocation?: SourceLocation;
  buildDurationMs?: number;
  profileCategories?: { category: string; durationMs: number }[];
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

// ---------------------------------------------------------------------------
// Assembly payload (from server when sceneKind === 'assembly')
// ---------------------------------------------------------------------------

export type SerializedAssemblyInstance = {
  instanceId: string;
  partId: string;
  partName: string;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  grounded: boolean;
  name: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SerializedAssemblyMate = {
  mateId: string;
  type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot';
  connectorA: { instanceId: string; connectorId: string };
  connectorB: { instanceId: string; connectorId: string };
  status: 'satisfied' | 'redundant' | 'inconsistent';
  options?: { rotate?: number; flip?: boolean; offset?: [number, number, number] };
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SerializedAssembly = {
  instances: SerializedAssemblyInstance[];
  mates: SerializedAssemblyMate[];
};

/**
 * Per-row state used by the parts panel. Augments the server payload with
 * UI-only fields like in-memory visibility.
 */
export type RenderedInstance = SerializedAssemblyInstance & {
  visible: boolean;
};

export interface FileItem {
  name: string;
  isDirectory: boolean;
  path: string;
  children?: FileItem[];
  expanded?: boolean;
}
