import type { SceneObjectRender } from '../../src/types';

export type HeavySceneOptions = {
  /** part() rows in the scene. */
  parts: number;
  /** Points of each part's constrained polygon: 3 rows per point (line + fix + coincident). */
  polygonPoints: number;
  /**
   * Emit each part's rows in two runs with the next part's first run between
   * them — the order a lazily materialized part produces. Membership of a
   * part is its parentId chain, never an index range.
   */
  interleave?: boolean;
};

const FILE = '/ws/heavy.assembly.js';

/**
 * The shape of scene an LLM-authored assembly produces: few visible solids,
 * thousands of sketch-internal rows (a sampled polygon is a line, a fix and a
 * coincident per point). Every part holds a consumed sketch with that
 * polygon, an unconsumed sketch, an extrude carrying a solid, a connector
 * and an exposure.
 */
export function buildHeavyScene(options: HeavySceneOptions): SceneObjectRender[] {
  const heads: SceneObjectRender[][] = [];
  const tails: SceneObjectRender[][] = [];
  let line = 1;
  const row = (over: Partial<SceneObjectRender>): SceneObjectRender => ({
    sceneShapes: [],
    ownShapes: [],
    visible: true,
    fromCache: true,
    sourceLocation: { filePath: FILE, line: line++, column: 0 },
    ...over,
  });
  const edgeShape = (id: string) => ({
    shapeId: id,
    shapeType: 'edge',
    meshes: [{}],
  }) as unknown as SceneObjectRender['sceneShapes'][number];

  for (let p = 0; p < options.parts; p++) {
    const partId = `part-${p}`;
    const head: SceneObjectRender[] = [];
    const tail: SceneObjectRender[] = [];
    head.push(row({ id: partId, type: 'part', name: `Part ${p}`, isContainer: true }));

    const consumedId = `${partId}/sketch-consumed`;
    head.push(row({ id: consumedId, parentId: partId, type: 'sketch', visible: false }));
    for (let k = 0; k < options.polygonPoints; k++) {
      head.push(row({ id: `${consumedId}/line-${k}`, parentId: consumedId, type: 'line' as SceneObjectRender['type'] }));
      head.push(row({ id: `${consumedId}/fix-${k}`, parentId: consumedId, uniqueType: 'solved-constraint' }));
      head.push(row({ id: `${consumedId}/coincident-${k}`, parentId: consumedId, uniqueType: 'solved-constraint' }));
    }

    tail.push(row({
      id: `${partId}/extrude`,
      parentId: partId,
      type: 'extrude',
      name: 'Extrude',
      // One rebuilt row in every third part — the rest came from the cache.
      fromCache: p % 3 !== 0,
      sceneShapes: [{ shapeId: `${partId}/solid`, shapeType: 'solid', meshes: [{}] } as unknown as SceneObjectRender['sceneShapes'][number]],
    }));
    tail.push(row({ id: `${partId}/connector`, parentId: partId, type: 'connector', name: 'mount' }));
    tail.push(row({ id: `${partId}/exposed`, parentId: partId, type: 'exposed' as SceneObjectRender['type'] }));

    const openId = `${partId}/sketch-open`;
    tail.push(row({ id: openId, parentId: partId, type: 'sketch' }));
    tail.push(row({
      id: `${openId}/circle`,
      parentId: openId,
      type: 'circle' as SceneObjectRender['type'],
      sceneShapes: [edgeShape(`${openId}/circle/edge`)],
    }));

    heads.push(head);
    tails.push(tail);
  }

  const scene: SceneObjectRender[] = [];
  for (let p = 0; p < options.parts; p++) {
    scene.push(...heads[p]);
    if (options.interleave && p + 1 < options.parts) {
      // The next part's rows land before this part finishes.
      scene.push(...heads[p + 1].splice(0));
    }
    scene.push(...tails[p]);
  }
  // A loose top-level feature after the parts, and a row whose parent is gone.
  scene.push(row({ id: 'loose-extrude', type: 'extrude', sceneShapes: [{ shapeId: 'loose/solid', shapeType: 'solid', meshes: [{}] } as unknown as SceneObjectRender['sceneShapes'][number]] }));
  scene.push(row({ id: 'orphan', parentId: 'no-such-row', type: 'line' as SceneObjectRender['type'] }));
  return scene;
}
