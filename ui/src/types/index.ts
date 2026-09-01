// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

import type { ContactEntity } from '../solver/types';

export type SourceLocation = {
  filePath: string;
  line: number;
  column: number;
  /** 0-based execution index of this object among all objects produced by
   * the same call site — present only when a looped statement produced more
   * than one, so instances can be told apart despite sharing a line. */
  occurrence?: number;
};

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
  /** The identifier registered by `connector('name', …)` — absent only on
   *  a connector whose build failed before its frame was derived. */
  name?: string;
  origin: Vec3Data;
  xDirection: Vec3Data;
  yDirection: Vec3Data;
  normal: Vec3Data;
};

/**
 * Serialized `expose('name', …)` payload: the exposure name plus the
 * canonical contact geometry a tangent mate solves against (part-local
 * frame, classified lib-side). `seed`/`chain` are absent on engines
 * predating the tangent mate.
 */
export type ExposedData = {
  name: string;
  seed?: ContactEntity | null;
  chain?: ContactEntity[];
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
  | 'fillet2d'
  | 'offset'
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
  | 'connector'
  // Named geometry publications (`expose('name', …)`) — shapeless pass-throughs
  | 'exposed';

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
  /**
   * False draws the faces through whatever is in front of them — for the
   * translucent overlays that have to stay visible inside solid material
   * (a cut tool's ghost, an extrusion sweeping back into the model).
   */
  depthTest?: boolean;
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
  /**
   * A sketch wire hit — only produced while a create dialog has enabled
   * `viewer.pickSketchWires`; the pick identifies the owning sketch, so the
   * index carries no meaning (always 0).
   */
  | { type: 'sketch'; index: number }
  /**
   * An axis line hit — only produced while a dialog has enabled
   * `viewer.pickAxes`; the pick identifies the owning axis object, so the
   * index carries no meaning (always 0).
   */
  | { type: 'axis'; index: number }
  /**
   * A construction-plane quad hit — only produced while a dialog has enabled
   * `viewer.pickPlanes`; the pick identifies the owning plane object, so the
   * index carries no meaning (always 0).
   */
  | { type: 'plane'; index: number }
  /**
   * A mate-connector gizmo hit — only produced while a mate dialog has
   * enabled `viewer.pickConnectors`; the shapeId is the connector scene
   * object's id and the pick carries the owning assembly instance, so the
   * index carries no meaning (always 0).
   */
  | { type: 'connector'; index: number }
  | null;

export type SceneObjectPart = {
  shapeId?: string;
  meshes: SceneObjectMesh[];
  shapeType?: ShapeType;
  isMetaShape?: boolean;
  isGuide?: boolean;
  metaType?: string;
  metaData?: Record<string, any>;
  role?: string;
  roleIndex?: number;
  provenance?: string;
};

export type SketchInteractivity = 'draggable' | 'selectable' | 'construction';

export type CompileError = {
  message: string;
  filePath?: string;
  sourceLocation?: SourceLocation;
};

export type SceneObjectRender = {
  id?: string;
  name?: string;
  /** True when `name` comes from a user's `.name('…')` chain, not the type. */
  hasCustomName?: boolean;
  parentId?: string | null;
  isContainer?: boolean;
  hideChildren?: boolean;
  object?: any;
  sceneShapes: SceneObjectPart[];
  /**
   * Shapes the object publishes but never puts on screen (an `expose(…)`
   * row's source selection) — shown on demand as a highlight.
   */
  referencedShapes?: SceneObjectPart[];
  ownShapes: SceneObjectPart[];
  visible?: boolean;
  /** The object carries a `.reusable()` chain — kept visible when consumed. */
  reusable?: boolean;
  /**
   * The object serves another statement's build (a sketch's own plane) rather
   * than being a feature the code wrote — the timeline leaves it out. Absent
   * on renders from a workspace kernel that predates the flag.
   */
  internal?: boolean;
  type?: ObjectType;
  uniqueType?: string;
  /** Server-driven viewport classification for sketch geometry children. */
  interactivity?: SketchInteractivity;
  fromCache?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  sourceLocation?: SourceLocation;
  buildDurationMs?: number;
  profileCategories?: { category: string; durationMs: number }[];
  /**
   * Sketches only, tip sketch only: invisible plane-local 2D snap targets
   * for the interactive sketcher — where the sketch plane slices the scene's
   * bodies (the vertices an intersect() would produce) plus every prior
   * shape's topological vertices projected onto the plane.
   */
  snapVertices?: [number, number][];
};

// ---------------------------------------------------------------------------
// Parameter definitions for the Parameters panel
// ---------------------------------------------------------------------------

export type UIParamDefinition = {
  label: string;
  defaultValue: string | number | boolean | (string | number)[];
  currentValue: string | number | boolean | (string | number)[];
  controlType: 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox' | 'color';
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  multi?: boolean;
  multiControlType?: 'select' | 'checkboxes' | 'chips';
  /**
   * Where the `param()` call was authored. The panel's editor addresses a
   * declaration by label and only needs this to disambiguate a label declared
   * twice; absent for a param whose call the engine could not attribute.
   */
  sourceLocation?: SourceLocation;
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

/** A parameter's resolved value — what `param()` returns. */
export type InstanceParamValue = string | number | boolean | (string | number)[];

/**
 * Control metadata of one definition parameter, as serialized on part
 * templates (`object.params`) and occurrences — everything the edit form
 * needs (the declaring file's sourceLocation is deliberately absent).
 */
export type InstanceParamDef = {
  label: string;
  defaultValue: InstanceParamValue;
  currentValue: InstanceParamValue;
  controlType: string;
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  multi?: boolean;
  multiControlType?: string;
};

export type SerializedAssemblyInstance = {
  instanceId: string;
  partId: string;
  partName: string;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  /** EFFECTIVE grounding — the engine already applied the scoped-grounding rule. */
  grounded: boolean;
  /**
   * Owning scope: "" (or absent, on older engines) for instances inserted by
   * the open file itself; an occurrence path ("asm-0", "asm-0/asm-1") for
   * instances a sub-assembly body inserted. Occurrence-owned instances'
   * sourceLocations point into the SUB-ASSEMBLY's file, so statement edits
   * (translate/ground/rename/delete) must not target them from this view.
   */
  owner?: string;
  name: string;
  /** Resolved parameter values of the instance's template variant. */
  paramValues?: Record<string, InstanceParamValue>;
  sourceLocation?: { filePath: string; line: number; column: number };
};

/** One inserted sub-assembly: `insert(assembly('name', cb))` in the open file or nested. */
export type SerializedAssemblyOccurrence = {
  occurrenceId: string;
  assemblyName: string;
  name: string;
  parentPath: string;
  /** Local to the parent scope's frame (== world for root-scope occurrences). */
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  /** Declared `.grounded()` on the occurrence handle. */
  grounded: boolean;
  /** Whether the grounded-frame chain reaches the root from here. */
  groundConnected: boolean;
  /** The definition's `param()` interface — the occurrence edit form's rows. */
  params?: InstanceParamDef[];
  /** Resolved parameter values of this occurrence's run. */
  paramValues?: Record<string, InstanceParamValue>;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SerializedAssemblyMate = {
  mateId: string;
  /** Scope the mate() statement ran in: "" (or absent) for the open file. */
  owner?: string;
  type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot' | 'tangent';
  /** Connector sides — every mate type except tangent. */
  connectorA?: { instanceId: string; connectorId: string };
  connectorB?: { instanceId: string; connectorId: string };
  /** Geometry sides — tangent mates only (exposure resolved per instance). */
  geometryA?: { instanceId: string; exposeName: string };
  geometryB?: { instanceId: string; exposeName: string };
  /** Origin-frame sides (`origin(axis?)`) — lower-pair mates only, at most one. */
  frameA?: { axis: 'x' | 'y' | 'z' };
  frameB?: { axis: 'x' | 'y' | 'z' };
  status: 'satisfied' | 'redundant' | 'inconsistent';
  options?: { rotate?: number; flip?: boolean; offset?: [number, number, number]; limits?: [number, number]; propagate?: boolean };
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SerializedAssembly = {
  instances: SerializedAssemblyInstance[];
  mates: SerializedAssemblyMate[];
  /** Absent on engines predating assembly() definitions. */
  occurrences?: SerializedAssemblyOccurrence[];
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
