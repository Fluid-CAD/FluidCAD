import { expandBucket, expandLoop, type ApplyFeatureEntity, type SelectionBoundaryRef } from '../api';
import type { SelectedEntity } from '../viewer';

/**
 * What a double-click on a picked edge or face takes: `loop`, the rim loop
 * of a surface edge; `bucket`, the classified bucket of any other pick.
 */
export type PickExpansion = { kind: 'loop' | 'bucket'; members: SelectedEntity[] };

/**
 * The double-click rule every pick dialog shares. An edge on a surface's
 * open rim takes the rim loop it belongs to — a loaded surface too, which
 * has no bucket to expand to; any other edge, and a face, takes its
 * classified bucket ("the whole top rim"). The gesture's own two single
 * clicks have already toggled the pick; the caller takes the members, the
 * seed among them, so the seed ends up picked either way: a dialog that
 * keeps chains keeps a loop whole, as the menu's Boundary Loop, so it is
 * written as the loop it is and not as its edges one by one; a bucket, and
 * a loop in a dialog that writes no chains, merge as plain picks.
 *
 * A rim question the server cannot answer falls through to the bucket, so
 * the gesture is never worse than it was before loops.
 */
export async function expandDoubleClick(
  entity: SelectedEntity,
  before?: SelectionBoundaryRef,
): Promise<PickExpansion | { error: string }> {
  const pick: ApplyFeatureEntity = { shapeId: entity.shapeId, sub: entity.sub };
  if (pick.sub.type === 'edge') {
    const loop = await expandLoop(pick, before);
    if (!('error' in loop) && loop.rim && loop.members.length > 0) {
      return { kind: 'loop', members: plain(loop.members) };
    }
  }
  const bucket = await expandBucket(pick, before);
  return 'error' in bucket ? bucket : { kind: 'bucket', members: plain(bucket.members) };
}

/** The members as picks: the server's refs carry no more than an id and a sub-shape. */
function plain(members: ApplyFeatureEntity[]): SelectedEntity[] {
  return members.map(m => ({ shapeId: m.shapeId, sub: m.sub }));
}
