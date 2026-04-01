import { randomUUID } from "crypto";
import { Shape, ShapeFilter } from "./shape.js";
import { Matrix4 } from "../math/matrix4.js";
import { ISceneObject } from "../core/interfaces.js";
import { FusionScope } from "../features/extrude-options.js";

export type SourceLocation = {
  filePath: string;
  line: number;
  column: number;
};

export interface Comparable<T> {
  compareTo(other: T): boolean;
}

export interface Serializable {
  serialize(): any;
}

export type BuildSceneObjectContext = {
  getSceneObjects(): SceneObject[];
  getActiveSceneObjects(): SceneObject[];
  getSceneObjectsFromTo(obj: SceneObject, to: SceneObject, type?: string): SceneObject[];
  getTransform(): Matrix4 | null;
  getLastObject(): SceneObject | null;
}

export abstract class SceneObject implements Comparable<SceneObject>, Serializable, ISceneObject {

  private state: Map<string, any>;
  private children: SceneObject[] = [];

  private _id: string;
  private _order: number = 0;
  private _transform: Matrix4 | null = null;
  private _parent: SceneObject | null = null;
  private _alwaysVisible: boolean = false;
  private _name: string = '';
  private _guide: boolean = false;
  private _sourceLocation: SourceLocation | null = null;
  private _error: string | null = null;
  protected _fusionScope?: FusionScope = 'all';

  constructor() {
    this.state = new Map();
    this.state.set('addedShapes', [])
    this.state.set('removedShapes', [])

    this._id = randomUUID().toString();
    this._name = this.getType();
  }

  get id(): string {
    return this._id;
  }

  get parentId(): string | null {
    return this._parent?.id || null;
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

  abstract serialize(): any;
  abstract getType(): string;
  abstract build(context?: BuildSceneObjectContext): void;

  compareTo(other: SceneObject): boolean {
    const match = this._guide === other._guide;

    if (!match) {
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

  removeShapes(removedBy: SceneObject) {

    if (this.isContainer()) {
      for (const child of this.children) {
        child.removeShapes(removedBy);
      }
      return;
    }

    for (const shape of this.addedShapes) {
      this.removeShape(shape, removedBy);
    }
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

  getChildShapes(filter?: ShapeFilter, type?: string): Shape[] {
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

  getShapes(filter?: ShapeFilter, type?: string): Shape[] {
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
    return this._name;
  }

  name(value: string) {
    this._name = value;
    return this;
  }

  guide() {
    this._guide = true;
    return this;
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

  fuse(value: 'all' | 'none'): this;
  fuse(object: ISceneObject): this;
  fuse(...objects: ISceneObject[]): this;
  fuse(): this {
    const arr = Array.from(arguments);
    if (arr.length === 0) {
      this._fusionScope = 'all';
      return this;
    }

    if (arr.length === 1) {
      this._fusionScope = arr[0];
      return this;
    }

    this._fusionScope = arr;
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
