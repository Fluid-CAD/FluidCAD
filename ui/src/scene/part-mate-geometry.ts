import type { ConnectorFrame, ExposureContact, PartMateGeometry } from '../../../lib/assembly-solver/index.js';
import { SceneIndex } from '../helpers/scene-index';
import type { ConnectorData, ExposedData, SceneObjectRender } from '../types';

/**
 * What a part's rows give the mate solver: the frames of every connector
 * the part carries — its own and the copies `copy()` statements made of
 * them — and its `expose()` publications with their classified contact
 * geometry. Every instance of the part shares them.
 *
 * The one read of a render's rows for the solver: the assembly view and the
 * insert dialog's thumbnails both go through here, so a connector either
 * reaches every solve or none.
 */
export class PartMateGeometryReader {
  static of(sceneObjects: readonly SceneObjectRender[], partId: string): PartMateGeometry {
    const index = SceneIndex.of(sceneObjects);
    const connectors: ConnectorFrame[] = [];
    for (const row of index.connectorsOf(partId)) {
      const data = row.object as ConnectorData | undefined;
      // A connector whose build failed has no frame; the solve reports a
      // mate naming it as not enforced.
      if (!row.id || !data?.origin || !data.xDirection || !data.normal) {
        continue;
      }
      connectors.push({
        connectorId: row.id,
        origin: data.origin,
        xDirection: data.xDirection,
        normal: data.normal,
      });
    }
    const exposures: ExposureContact[] = [];
    for (const row of index.children(partId)) {
      if (row.type !== 'exposed' || !row.id) {
        continue;
      }
      const data = row.object as ExposedData | undefined;
      if (!data?.name) {
        continue;
      }
      exposures.push({ name: data.name, seed: data.seed ?? null, chain: data.chain ?? [] });
    }
    return { connectors, exposures };
  }
}
