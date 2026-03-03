import { randomUUID } from "crypto";
import { Shape } from "./shape.js";
import { MergeScope } from "../features/extrude-options.js";
import { Matrix4 } from "../math/matrix4.js";

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
    return this._guide === other._guide;
  }

  clone(): SceneObject[] {
    throw new Error("Clone method not implemented.");
  }

  setTransform(matrix: Matrix4): void {
    this._transform = matrix;
  }

  getTransform(): Matrix4 | null {
    return this._transform;
  }

  getFusionScope(): MergeScope {
    return 'none';
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
    const keep = this.getState('keep');
    if (keep) {
      return;
    }

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
    const keep = this.getState('keep');
    if (keep) {
      return;
    }

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

  keep() {
    this.setState('keep', true)
    return this;
  }

  getOwnShapes(exludeMetaShapes = true, scope?: Set<SceneObject>): Shape[] {
    const shapes = this.addedShapes.filter(s =>
      !this.removedShapes.find(r => r.shape === s && (!scope || scope.has(r.removedBy)))
    );

    if (exludeMetaShapes) {
      return shapes.filter(s => !s.isMetaShape() && !s.isGuideShape());
    }

    return shapes;
  }

  getChildShapes(excludeMeta?: boolean, type?: string): Shape[] {
    let shapes: Shape[] = [];

    for (const child of this.children) {
      shapes = shapes.concat(child.getShapes(excludeMeta, type));
    }

    return shapes;
  }

  getShapes(excludeMeta: boolean = true, type?: string): Shape[] {
    if (this.isContainer()) {
      return this.getChildShapes(excludeMeta, type);
    }

    const ownShapes = this.getOwnShapes(excludeMeta);

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

  isTransformable() {
    return false;
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

  protected generateUniqueName(suffix: string) {
    return `${this.getOrder()}-${this.getUniqueType()}-${suffix}`;
  }
}
