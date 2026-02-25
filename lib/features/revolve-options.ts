import { SceneObject } from "../common/scene-object.js";

export type MergeScope = 'all' | 'none' | SceneObject | SceneObject[];
export type RevolveOptions = {
    mergeScope?: MergeScope;
    symmetric?: boolean;
};

