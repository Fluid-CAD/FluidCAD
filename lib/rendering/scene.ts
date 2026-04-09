import { Sketch } from "../features/2d/sketch.js";
import { SelectSceneObject } from "../features/select.js";
import { SceneObject } from "../common/scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { Part } from "../features/part.js";

export type SceneObjectMesh = {
  label?: string;
  vertices: number[];
  normals: number[];
  indices: number[];
  color?: string;
  faceMapping?: number[];  // faceMapping[triangleIdx] = OCC face index (solid-faces meshes only)
  edgeIndex?: number;      // solid-edges meshes only
}

export type RenderedShape = {
  shapeId: string;
  meshes: SceneObjectMesh[];
  shapeType: string;
  isMetaShape?: boolean;
  isGuide?: boolean;
  metaType?: string;
  metaData?: Record<string, any>;
}

export type SceneObjectRender = {
  id: string;
  name: string;
  parentId: string | null;
  isContainer: boolean;
  object: any;
  sceneShapes: RenderedShape[];
  visible: boolean;
  type: string;
  uniqueType: string;
  fromCache: boolean;
  hasError: boolean;
  errorMessage?: string;
  sourceLocation?: { filePath: string; line: number; column: number };
}

export class Scene {

  private sceneObjects: SceneObject[] = [];
  private renderedObjects: Map<SceneObject, SceneObjectRender> = new Map();
  private cached: Set<SceneObject> = new Set();

  private progressiveContainers: SceneObject[] = [];

  private idMap: Map<string, SceneObject> = new Map();

  constructor() {
  }

  addSceneObject(obj: SceneObject): void {
    obj.setOrder(this.sceneObjects.length);

    const activeObj = this.getActiveContainer();
    if (activeObj && !obj.getParent()) {
      activeObj.addChildObject(obj);
    }

    if (!this.sceneObjects.includes(obj)) {
      this.sceneObjects.push(obj);
      this.idMap.set(obj.id, obj);
    }
  }

  startProgressiveContainer(obj: SceneObject): void {
    this.addSceneObject(obj);
    this.progressiveContainers.push(obj);
  }

  getActiveContainer(): SceneObject | null {
    if (this.progressiveContainers.length > 0) {
      return this.progressiveContainers[this.progressiveContainers.length - 1];
    }
    return null;
  }

  endProgressiveContainer() {
    const obj = this.progressiveContainers.pop();
    if (!obj) {
      throw new Error('No progressive container to end.');
    }
    return obj;
  }

  getActiveSketch(): Sketch | null {
    const activeObject = this.getActiveContainer();
    if (activeObject && activeObject instanceof Sketch) {
      return activeObject;
    }
    return null;
  }

  getActivePart(): Part | null {
    for (let i = this.progressiveContainers.length - 1; i >= 0; i--) {
      if (this.progressiveContainers[i] instanceof Part) {
        return this.progressiveContainers[i] as Part;
      }
    }
    return null;
  }

  findEnclosingPart(obj: SceneObject): Part | null {
    let current = obj.getParent();
    while (current) {
      if (current instanceof Part) {
        return current;
      }
      current = current.getParent();
    }
    // The object itself might be a Part
    if (obj instanceof Part) {
      return obj;
    }
    return null;
  }

  getPartScopedObjectsUpTo(obj: SceneObject): SceneObject[] {
    const allUpTo = this.getSceneObjectsUpTo(obj);
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return allUpTo;
    }
    return allUpTo.filter(o => this.findEnclosingPart(o) === part);
  }

  getPartScopedActiveObjectsUpTo(obj: SceneObject): SceneObject[] {
    const allUpTo = this.getActiveSceneObjectsUpTo(obj);
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return allUpTo;
    }
    return allUpTo.filter(o => this.findEnclosingPart(o) === part);
  }

  getSceneObjects(): SceneObject[] {
    const object = this.sceneObjects
    return object;
  }

  getPartScopedSceneObjects(): SceneObject[] {
    const activePart = this.getActivePart();
    if (!activePart) {
      return this.sceneObjects;
    }
    return this.sceneObjects.filter(o => this.findEnclosingPart(o) === activePart);
  }

  getPartScopedAllObjects(obj: SceneObject): SceneObject[] {
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return this.sceneObjects;
    }
    return this.sceneObjects.filter(o => this.findEnclosingPart(o) === part);
  }

  getActiveSceneObjectsUpTo(obj: SceneObject): SceneObject[] {
    const index = this.sceneObjects.findIndex(f => f === obj);
    return this.sceneObjects.slice(0, index).filter(f => f.hasShapes());
  }

  getSceneObjectsUpTo(obj: SceneObject): SceneObject[] {
    const index = this.sceneObjects.findIndex(f => f === obj);
    const objects = this.sceneObjects
      .slice(0, index)

    return objects;
  }

  getSceneObjectsFromTo(obj: SceneObject, to:SceneObject): SceneObject[] {
    const fromIndex = this.sceneObjects.findIndex(f => f === obj);
    const toIndex = this.sceneObjects.findIndex(f => f === to);
    const objects = this.sceneObjects
      .slice(fromIndex, toIndex)

    return objects;
  }

  getAllSceneObjects(): SceneObject[] {
    return this.sceneObjects;
  }

  getLastExtrudable(): Extrudable | null {
    const activePart = this.getActivePart();
    let count = this.sceneObjects.length;

    while (count--) {
      const object = this.sceneObjects[count];
      if (!object.isExtrudable()) {
        continue;
      }

      if (activePart) {
        // Inside a Part: find extrudables that are direct children of this Part
        if (object.getParent() === activePart) {
          return object as Extrudable;
        }
      } else {
        // Outside any Part: original behavior (top-level only)
        if (!object.parentId) {
          return object as Extrudable;
        }
      }
    }

    return null;
  }

  getLastSelections(): SelectSceneObject[] {
    let count = this.sceneObjects.length;
    const selections = [];

    while (count--) {
      const obj = this.sceneObjects[count];
      if (obj instanceof SelectSceneObject) {
        selections.push(obj);
      }
    }

    return selections;
  }

  getLastSelection(): SelectSceneObject | null {
    let count = this.sceneObjects.length;

    while (count--) {
      const obj = this.sceneObjects[count];
      if (obj instanceof SelectSceneObject) {
        return obj;
      }
    }

    return null;
  }

  replaceSceneObject(currentSceneObject: SceneObject, newSceneObject: SceneObject): void {
    const index = this.sceneObjects.findIndex(f => f === currentSceneObject);
    if (index !== -1) {
      this.sceneObjects[index] = newSceneObject;
    }
  }

  addRenderedObject(object: SceneObject, rendered: SceneObjectRender) {
    this.renderedObjects.set(object, rendered);
  }

  getRenderedObject(obj: SceneObject): SceneObjectRender | null {
    return this.renderedObjects.get(obj) || null;
  }

  getRenderedObjects() {
    return Array.from(this.renderedObjects.values());
  }

  clearRenderedObjects() {
    this.renderedObjects.clear();
  }

  removeRenderedObject(obj: SceneObject) {
    this.renderedObjects.delete(obj);
  }

  markCached(obj: SceneObject) {
    this.cached.add(obj);
  }

  isCached(obj: SceneObject) {
    return this.cached.has(obj);
  }

  indexOf(obj: SceneObject): number {
    return this.sceneObjects.indexOf(obj);
  }

  getSceneObjectAt(index: number): SceneObject {
    return this.sceneObjects[index];
  }

  getSceneObjectById(id: string): SceneObject | null {
    return this.idMap.get(id) || null;
  }

  getChildren(parent: SceneObject): SceneObject[] {
    return this.sceneObjects.filter(obj => obj.parentId === parent.id);
  }

}
