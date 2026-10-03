import type { SceneObjectRender } from '../types';
import type { TimelineEntry } from '../../../lib/dist/common/timeline';
import { SceneIndex } from './scene-index';

/**
 * The rail's display list. Historical rows exist only here: the viewer,
 * Shapes panel, active sketch and every edit keep receiving the live scene.
 * Live rows retain their object identity and original runtime index.
 */
export class TimelineView {
  readonly rows: SceneObjectRender[];
  private readonly live: SceneIndex;

  constructor(scene: SceneObjectRender[], history?: TimelineEntry[]) {
    this.live = SceneIndex.of(scene);
    this.rows = history ? history.flatMap(entry => {
      if (entry.kind === 'evaluated') return scene[entry.index] ? [scene[entry.index]] : [];
      return [{ ...entry.row, sceneShapes: [], ownShapes: [], object: {} } as SceneObjectRender];
    }) : scene;
  }

  sceneIndex(row: SceneObjectRender): number {
    return this.live.position(row);
  }
}
