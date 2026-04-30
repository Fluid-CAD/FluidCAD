import { randomUUID } from "crypto";
import { Shape, ShapeFilter } from "./shape.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";
import { Matrix4 } from "../math/matrix4.js";
import { ISceneObject } from "../core/interfaces.js";
import { FusionScope, OperationMode } from "../features/extrude-options.js";
import { ShapeType } from "./shape-type.js";
import { Profiler } from "./profiler.js";

export type SourceLocation = {
  filePath: string;
  line: number;
  column: number;
};

export type AdditionRecord<T> = {
  shape: T;
  addedBy: SceneObject;
};

export type RemovalRecord<T> = {
  shape: T;
  removedBy: SceneObject;
};

export type ModificationRecord<T> = {
  sources: T[];
  results: T[];
  modifiedBy: SceneObject;
};

export interface Comparable<T> {
  compareTo(other: T): boolean;
}

export interface Serializable {
  serialize(scope?: Set<SceneObject>): any;
}

export type BuildSceneObjectContext = {
  getSceneObjects(): SceneObject[];
  getActiveSceneObjects(): SceneObject[];
  getSceneObjectsFromTo(obj: SceneObject, to: SceneObject, type?: string): SceneObject[];
  getTransform(): Matrix4 | null;
  getLastObject(): SceneObject | null;
  getProfiler(): Profiler;
}

export abstract class SceneObject implements Comparable<SceneObject>, Serializable, ISceneObject {

  private state: Map<string, any>;
  private children: SceneObject[] = [];

  private _id: string;
  private _order: number = 0;
  private _transform: Matrix4 | null = null;
  private _appliedTransform: Matrix4 | null = null;
  private _cloneSource: SceneObject | null = null;
  private _parent: SceneObject | null = null;
  private _alwaysVisible: boolean = false;
  private _name: string | null = null;
  private _guide: boolean = false;
  private _reusable: boolean = false;
  private _sourceLocation: SourceLocation | null = null;
  private _error: string | null = null;
  protected _fusionScope?: FusionScope = 'all';
  protected _operationMode: OperationMode = 'add';
  protected _symmetric: boolean = false;

  constructor() {
    this.state = new Map();
    this.state.set('addedShapes', [])
    this.state.set('removedShapes', [])

    this.state.set('addedFaces', [])
    this.state.set('modifiedFaces', [])
    this.state.set('removedFaces', [])
    this.state.set('addedEdges', [])
    this.state.set('modifiedEdges', [])
    this.state.set('removedEdges', [])
    this.state.set('finalShapes', [])

    this._id = randomUUID().toString();
  }

  get id(): string {
    return this._id;
  }

  get parentId(): string | null {
    return this._parent?.id || null;
  }

  inheritIdentityFrom(other: SceneObject): void {
    this._id = other._id;
  }

  private setParent(parent: SceneObject) {
    this._parent = parent;
  }

  protected setAlwaysVisible() {
    this._alwaysVisible = true;
  }

  isAlwaysVisible(): boolean {
    return this._alwaysVisible;
  }

  hasShapes(): boolean {
    if (this.isContainer()) {
      for (const child of this.children) {
        const ownShapes = child.getOwnShapes();
        if (ownShapes.length > 0) {
          return true;
        }
      }
    }

    return this.getOwnShapes().length > 0;
  }

  addChildObject(child: SceneObject) {
    this.children.push(child);
    child.setParent(this);
  }

  getChildren(): SceneObject[] {
    return this.children;
  }

  getParent(): SceneObject | null {
    return this._parent;
  }

  getPreviousSibling(obj: SceneObject): SceneObject | null {
    const children = this.getChildren() as SceneObject[];
    const index = children.indexOf(obj);
    if (index > 0) {
      return children[index - 1] as SceneObject;
    }
    return null;
  }

  getPreviousSiblings(obj: SceneObject): SceneObject[] {
    const children = this.getChildren() as SceneObject[];
    const index = children.indexOf(obj);
    if (index > 0) {
      return children.slice(0, index) as SceneObject[];
    }
    return [];
  }

  isContainer(): boolean {
    return false;
  }

  isLazy(): boolean {
    return false;
  }

  // called by containers to save the shapes state up to this object
  saveShapesSnapshot(context: BuildSceneObjectContext) {
    const upToHere = context.getSceneObjects()

    const map: Map<SceneObject, Shape[]> = new Map();

    for (const obj of upToHere) {
      map.set(obj, obj.getShapes());
    }

    this.setState('snapshot', map)
  }

  getSnapshot(): Map<SceneObject, Shape[]> {
    return this.getState('snapshot') || [];
  }

  abstract serialize(scope?: Set<SceneObject>): any;
  abstract getType(): string;
  abstract build(context?: BuildSceneObjectContext): void;

  /**
   * Pre-build validation hook. The renderer calls this before `build()` so
   * features can fail fast with a clear diagnostic (typically a `BuildError`)
   * before any OC work runs. Default is a no-op; overrides should not mutate
   * state. Existing per-feature checks inside `build()` are intentionally not
   * removed — this hook is additive.
   */
  validate(): void {
    // Override in subclasses to add operand checks via `requireShapes` etc.
  }

  getAppliedTransform(): Matrix4 | null {
    return this._appliedTransform;
  }

  protected composeAppliedTransform(matrix: Matrix4): void {
    this._appliedTransform = this._appliedTransform
      ? matrix.multiply(this._appliedTransform)
      : matrix;
  }

  compareTo(other: SceneObject): boolean {
    const match = this._guide === other._guide && this._reusable === other._reusable;

    if (!match) {
      return false;
    }

    if (this._operationMode !== other._operationMode) {
      return false;
    }

    if (this._symmetric !== other._symmetric) {
      return false;
    }

    if (!this._appliedTransform !== !other._appliedTransform) {
      return false;
    }
    if (this._appliedTransform && other._appliedTransform
        && !this._appliedTransform.equals(other._appliedTransform)) {
      return false;
    }

    if (typeof(this._fusionScope) !== typeof(other._fusionScope)) {
      return false;
    }

    if (typeof (this._fusionScope) === 'string' && typeof (other._fusionScope) === 'string') {
      return this._fusionScope === other._fusionScope;
    }

    if (this._fusionScope instanceof SceneObject && other._fusionScope instanceof SceneObject) {
      return this._fusionScope.compareTo(other._fusionScope);
    }

    const thisScope = this._fusionScope as SceneObject[];
    const otherScope = other._fusionScope as SceneObject[];

    if (thisScope.length !== otherScope.length) {
      return false;
    }

    for (let i = 0; i < thisScope.length; i++) {
      if (!thisScope[i].compareTo(otherScope[i])) {
        return false;
      }
    }

    return true;
  }

  getDependencies(): SceneObject[] {
    return [];
  }

  createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    throw new Error("createCopy() not implemented for " + this.getType());
  }

  clone(): SceneObject[] {
    const visited = new Set<SceneObject>();
    const ordered: SceneObject[] = [];

    const collect = (obj: SceneObject) => {
      if (visited.has(obj)) {
        return;
      }
      visited.add(obj);

      for (const dep of obj.getDependencies()) {
        collect(dep);
      }

      ordered.push(obj);

      for (const child of obj.getChildren()) {
        collect(child);
      }
    };

    collect(this);

    const remap = new Map<SceneObject, SceneObject>();
    const result: SceneObject[] = [];

    for (const obj of ordered) {
      const copy = obj.createCopy(remap);
      if (obj._appliedTransform) {
        copy._appliedTransform = obj._appliedTransform;
      }
      remap.set(obj, copy);
      result.push(copy);

      const parent = obj.getParent();
      if (parent && remap.has(parent)) {
        remap.get(parent)!.addChildObject(copy);
      }
    }

    return result;
  }

  setTransform(matrix: Matrix4): void {
    this._transform = matrix;
  }

  getTransform(): Matrix4 | null {
    return this._transform;
  }

  setCloneSource(source: SceneObject): void {
    this._cloneSource = source;
  }

  getCloneSource(): SceneObject | null {
    return this._cloneSource;
  }

  getTransformMatrix(): Matrix4 | null {
    return null;
  }

  isExtrudable(): boolean {
    return false;
  }

  init() {
  }

  private get addedShapes() {
    return this.state.get('addedShapes') as Shape[];
  }

  private set addedShapes(shapes: Shape[]) {
    this.state.set('addedShapes', shapes);
  }

  private get removedShapes() {
    return this.state.get('removedShapes') as { shape: Shape, removedBy: SceneObject }[];
  }

  private set removedShapes(shapes: { shape: Shape, removedBy: SceneObject }[]) {
    this.state.set('removedShapes', shapes);
  }

  private get addedFaces() {
    return this.state.get('addedFaces') as AdditionRecord<Face>[];
  }

  private set addedFaces(records: AdditionRecord<Face>[]) {
    this.state.set('addedFaces', records);
  }

  private get modifiedFaces() {
    return this.state.get('modifiedFaces') as ModificationRecord<Face>[];
  }

  private set modifiedFaces(records: ModificationRecord<Face>[]) {
    this.state.set('modifiedFaces', records);
  }

  private get removedFaces() {
    return this.state.get('removedFaces') as RemovalRecord<Face>[];
  }

  private set removedFaces(records: RemovalRecord<Face>[]) {
    this.state.set('removedFaces', records);
  }

  private get addedEdges() {
    return this.state.get('addedEdges') as AdditionRecord<Edge>[];
  }

  private set addedEdges(records: AdditionRecord<Edge>[]) {
    this.state.set('addedEdges', records);
  }

  private get modifiedEdges() {
    return this.state.get('modifiedEdges') as ModificationRecord<Edge>[];
  }

  private set modifiedEdges(records: ModificationRecord<Edge>[]) {
    this.state.set('modifiedEdges', records);
  }

  private get removedEdges() {
    return this.state.get('removedEdges') as RemovalRecord<Edge>[];
  }

  private set removedEdges(records: RemovalRecord<Edge>[]) {
    this.state.set('removedEdges', records);
  }

  private get finalShapes() {
    return this.state.get('finalShapes') as Shape[];
  }

  private set finalShapes(shapes: Shape[]) {
    this.state.set('finalShapes', shapes);
  }

  getUniqueType() {
    return this.getType() as string;
  }

  addShape(shape: Shape) {
    if (this._guide) {
      shape.markAsGuide();
    }

    this.addedShapes.push(shape);
  }

  addShapes(shapes: Shape[]) {
    for (const shape of shapes) {
      this.addShape(shape);
    }
  }

  removeShape(shape: Shape, removedBy: SceneObject) {
    if (this.isContainer()) {
      for (const child of this.children) {
        const childShapes = child.getShapes();
        if (childShapes.some(s => s === shape)) {
          child.removeShape(shape, removedBy);
        }
      }
      return;
    }

    this.removedShapes.push({
      shape,
      removedBy
    })
  }

  removeShapes(removedBy: SceneObject, force?: boolean) {
    if (this._reusable && !force) {
      return;
    }

    if (this.isContainer()) {
      for (const child of this.children) {
        child.removeShapes(removedBy, force);
      }
      return;
    }

    for (const shape of this.addedShapes) {
      this.removeShape(shape, removedBy);
    }
  }

  recordAddedFace(face: Face, addedBy: SceneObject) {
    this.addedFaces.push({ shape: face, addedBy });
  }

  recordAddedEdge(edge: Edge, addedBy: SceneObject) {
    this.addedEdges.push({ shape: edge, addedBy });
  }

  recordModifiedFaces(sources: Face[], results: Face[], modifiedBy: SceneObject) {
    this.modifiedFaces.push({ sources, results, modifiedBy });
  }

  recordModifiedEdges(sources: Edge[], results: Edge[], modifiedBy: SceneObject) {
    this.modifiedEdges.push({ sources, results, modifiedBy });
  }

  recordRemovedFace(face: Face, removedBy: SceneObject) {
    if (this.isContainer()) {
      for (const child of this.children) {
        if (child.ownsFace(face)) {
          child.recordRemovedFace(face, removedBy);
        }
      }
      return;
    }

    this.removedFaces.push({ shape: face, removedBy });
  }

  recordRemovedEdge(edge: Edge, removedBy: SceneObject) {
    if (this.isContainer()) {
      for (const child of this.children) {
        if (child.ownsEdge(edge)) {
          child.recordRemovedEdge(edge, removedBy);
        }
      }
      return;
    }

    this.removedEdges.push({ shape: edge, removedBy });
  }

  private ownsFace(face: Face): boolean {
    return this.addedFaces.some(r => r.shape === face);
  }

  private ownsEdge(edge: Edge): boolean {
    return this.addedEdges.some(r => r.shape === edge);
  }

  getAddedFaces(scope?: Set<SceneObject>): Face[] {
    return this.addedFaces
      .filter(r => !scope || scope.has(r.addedBy))
      .map(r => r.shape);
  }

  getModifiedFaces(scope?: Set<SceneObject>): ModificationRecord<Face>[] {
    return this.modifiedFaces.filter(r => !scope || scope.has(r.modifiedBy));
  }

  getRemovedFaces(scope?: Set<SceneObject>): Face[] {
    return this.removedFaces
      .filter(r => !scope || scope.has(r.removedBy))
      .map(r => r.shape);
  }

  getAddedEdges(scope?: Set<SceneObject>): Edge[] {
    return this.addedEdges
      .filter(r => !scope || scope.has(r.addedBy))
      .map(r => r.shape);
  }

  getModifiedEdges(scope?: Set<SceneObject>): ModificationRecord<Edge>[] {
    return this.modifiedEdges.filter(r => !scope || scope.has(r.modifiedBy));
  }

  getRemovedEdges(scope?: Set<SceneObject>): Edge[] {
    return this.removedEdges
      .filter(r => !scope || scope.has(r.removedBy))
      .map(r => r.shape);
  }

  setFinalShapes(shapes: Shape[]) {
    this.finalShapes = shapes;
  }

  getFinalShapes(): Shape[] {
    return this.finalShapes;
  }

  getOwnShapes(filter?: ShapeFilter, scope?: Set<SceneObject>): Shape[] {
    filter = {
      excludeMeta: filter?.excludeMeta ?? true,
      excludeGuide: filter?.excludeGuide ?? true,
    }

    const shapes = this.addedShapes.filter(s =>
      !this.removedShapes.find(r => r.shape === s && (!scope || scope.has(r.removedBy)))
    );

    let filteredShapes = shapes;

    if (filter?.excludeMeta) {
      filteredShapes = filteredShapes.filter(s => !s.isMetaShape());
    }

    if (filter?.excludeGuide) {
      filteredShapes = filteredShapes.filter(s => !s.isGuideShape());
    }

    return filteredShapes;
  }

  getChildShapes(filter?: ShapeFilter, type?: ShapeType): Shape[] {
    let shapes: Shape[] = [];

    filter = {
      excludeMeta: filter?.excludeMeta ?? true,
      excludeGuide: filter?.excludeGuide ?? true,
    }

    for (const child of this.children) {
      shapes = shapes.concat(child.getShapes(filter, type));
    }

    return shapes;
  }

  getShapes(filter?: ShapeFilter, type?: ShapeType): Shape[] {
    filter = {
      excludeMeta: filter?.excludeMeta ?? true,
      excludeGuide: filter?.excludeGuide ?? true,
    }

    if (this.isContainer()) {
      return this.getChildShapes(filter, type);
    }

    const ownShapes = this.getOwnShapes(filter);

    if (type) {
      return ownShapes.filter(s => s.getType() === type);
    }

    return ownShapes;
  }

  getAddedShapes(): Shape[] {
    return this.addedShapes;
  }

  getRemovedShapes() {
    return this.removedShapes;
  }

  getFullState() {
    return this.state;
  }

  restoreState(state: Map<string, any>) {
    this.state = state;
  }

  setState(key: string, value: any) {
    this.state.set(key, value);
  }

  getState(key: string): any {
    return this.state.get(key);
  }

  setOrder(order: number) {
    this._order = order;
  }

  getOrder(): number {
    return this._order;
  }

  getName(): string {
    return this._name ?? this.getType();
  }

  name(value: string) {
    this._name = value;
    return this;
  }

  guide() {
    this._guide = true;
    return this;
  }

  reusable(): this {
    this._reusable = true;
    return this;
  }

  isReusable(): boolean {
    return this._reusable;
  }

  setSourceLocation(loc: SourceLocation) {
    this._sourceLocation = loc;
  }

  getSourceLocation(): SourceLocation | null {
    return this._sourceLocation;
  }

  setError(message: string) {
    this._error = message;
  }

  clearError() {
    this._error = null;
  }

  getError(): string | null {
    return this._error;
  }

  getFusionScope(): FusionScope | undefined {
    return this._fusionScope || 'all';
  }

  getOperationMode(): OperationMode {
    return this._operationMode;
  }

  isSymmetric(): boolean {
    return this._symmetric;
  }

  resolveFusionScope(sceneObjects: SceneObject[]): SceneObject[] {
    const scope = this.getFusionScope();
    if (scope === 'none') {
      return [];
    } else if (scope instanceof SceneObject) {
      return [scope];
    } else if (Array.isArray(scope)) {
      return scope;
    }
    return sceneObjects;
  }

  add(): this {
    this._operationMode = 'add';
    this._fusionScope = 'all';
    return this;
  }

  new(): this {
    this._operationMode = 'new';
    this._fusionScope = 'none';
    return this;
  }

  remove(): this {
    this._operationMode = 'remove';
    this._fusionScope = 'all';
    return this;
  }

  scope(...objects: ISceneObject[]): this {
    if (objects.length === 1) {
      this._fusionScope = objects[0] as SceneObject;
    } else if (objects.length > 1) {
      this._fusionScope = objects as SceneObject[];
    }
    return this;
  }

  symmetric(): this {
    this._symmetric = true;
    return this;
  }
  /**
   * Called after all objects have been built. Override to perform
   * cleanup that depends on knowing the final scene state.
   */
  clean(allObjects: SceneObject[]): void {}

  protected generateUniqueName(suffix: string) {
    return `${this.getOrder()}-${this.getUniqueType()}-${suffix}`;
  }
}
