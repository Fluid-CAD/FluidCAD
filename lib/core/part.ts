import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Part } from "../features/part.js";
import { ISceneObject } from "./interfaces.js";

function part(name: string, callback: () => void): ISceneObject {
  const scene = getCurrentScene();
  if (!scene) {
    throw new Error("part() must be called within a scene context");
  }

  const sourceLocation = captureSourceLocation();
  const partObj = new Part(name);
  if (sourceLocation) {
    partObj.setSourceLocation(sourceLocation);
  }
  scene.startProgressiveContainer(partObj);
  callback();
  scene.endProgressiveContainer();

  return partObj;
}

export default part;
