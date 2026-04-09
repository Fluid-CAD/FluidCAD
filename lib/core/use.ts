import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Part } from "../features/part.js";
import { PartHandle } from "./part.js";
import { ISceneObject } from "./interfaces.js";

function use(handle: PartHandle): ISceneObject;
function use<T>(handle: PartHandle<T>, options: T): ISceneObject;
function use<T = any>(handle: PartHandle<T>, options?: T): ISceneObject {
  if (!handle || !handle.__fluidcad_part) {
    throw new Error("use() expects a PartHandle created by part()");
  }

  const scene = getCurrentScene();
  if (!scene) {
    throw new Error("use() must be called within a scene context");
  }

  const sourceLocation = captureSourceLocation();
  const partObj = new Part(handle.name);
  if (sourceLocation) {
    partObj.setSourceLocation(sourceLocation);
  }
  scene.startProgressiveContainer(partObj);
  handle._callback(options as T);
  scene.endProgressiveContainer();

  return partObj;
}

export default use;
