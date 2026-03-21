import { randomUUID } from "crypto";
import { Shape, ShapeFilter } from "./shape.js";
import { Matrix4 } from "../math/matrix4.js";

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

export abstract class SceneObject implements Comparable<SceneObject>, Serializable {

  private state: Map<string, any>;
  private children: SceneObject[] = [];

  private _id: string;
  private _order: number = 0;
  private _transform: Matrix4 | null = null;
  private _parent: SceneObject | null = null;
  private _alwaysVisible: boolean = false;
  private _name: string = '';
  private _guide: boolean = false;
  private _keep: boolean = false;
  private _forceRemoveShapes: boolean = false;
  private _sourceLocation: SourceLocation | null = null;

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
    return this._guide === other._guide && this._keep === other._keep && this._forceRemoveShapes === other._forceRemoveShapes;
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

  forceRemove() {
    this._forceRemoveShapes = true;
    return this;
  }

  removeShape(shape: Shape, removedBy: SceneObject, force: boolean = false) {
    if (this._keep && !(force || removedBy._forceRemoveShapes)) {
      return;
    }

    if (this.isContainer()) {
      for (const child of this.children) {
        const childShapes = child.getShapes();
        if (childShapes.some(s => s === shape)) {
          child.removeShape(shape, removedBy, force);
        }
      }
      return;
    }

    this.removedShapes.push({
      shape,
      removedBy
    })
  }

  removeShapes(removedBy: SceneObject, force: boolean = false) {
    if (this._keep && !(force || removedBy._forceRemoveShapes)) {
      return;
    }

    if (this.isContainer()) {
      for (const child of this.children) {
        child.removeShapes(removedBy, force);
      }
      return;
    }

    for (const shape of this.addedShapes) {
      this.removeShape(shape, removedBy, force);
    }
  }

  keep() {
    this._keep = true;
    return this;
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

  protected generateUniqueName(suffix: string) {
    return `${this.getOrder()}-${this.getUniqueType()}-${suffix}`;
  }
}
