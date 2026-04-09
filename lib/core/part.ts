import { captureSourceLocation } from "../index.js";
import { getCurrentScene, getCurrentFile } from "../scene-manager.js";
import { Part } from "../features/part.js";

export type PartHandle<T = any> = {
  __fluidcad_part: true;
  name: string;
  _callback: (options: T) => void;
};

function part<T = any>(name: string, callback: (options: T) => void): PartHandle<T> {
  const handle: PartHandle<T> = {
    __fluidcad_part: true,
    name,
    _callback: callback,
  };

  const sourceLocation = captureSourceLocation();
  const currentFile = getCurrentFile();

  const isDirectEdit = sourceLocation
    && currentFile
    && sourceLocation.filePath.replace('virtual:live-render:', '') === currentFile;

  if (isDirectEdit) {
    const scene = getCurrentScene();
    if (scene) {
      const partObj = new Part(name);
      if (sourceLocation) {
        partObj.setSourceLocation(sourceLocation);
      }
      scene.startProgressiveContainer(partObj);
      callback(undefined);
      scene.endProgressiveContainer();
    }
  }

  return handle;
}

export default part;
