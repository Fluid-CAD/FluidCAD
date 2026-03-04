import { SceneObject } from "../common/scene-object.js";

export type FusionScope = 'all' | 'none' | SceneObject | SceneObject[];
export type ExtrudeOptions = {
    draft?: number | [number, number];
    endOffset?: number;
    mergeScope?: FusionScope;
};

