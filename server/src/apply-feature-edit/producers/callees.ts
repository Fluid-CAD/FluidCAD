// Which callees can produce each kind of feature input (sketches, wires, planes, axes, repeat targets).

/**
 * Chain-root callees this transform will bind a variable to. Guards against a
 * stale or clone-inherited source line pointing at some unrelated call (e.g.
 * `repeat(...)`): binding `const e = repeat(...)` and emitting `e.endEdges()`
 * would produce broken code, so we refuse instead.
 */
const PRODUCER_CALLEES = new Set([
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell',
]);

/**
 * Chain-root callees a repeat target may reference — any builder returning a
 * repeatable scene feature. Broader than {@link PRODUCER_CALLEES}: a repeat
 * only binds the call to a variable and passes it along (`repeat(…, f)`), it
 * never chains selector accessors onto it, so modifier and primitive calls
 * qualify too.
 */
const REPEAT_TARGET_CALLEES = new Set([
  ...PRODUCER_CALLEES,
  'fillet', 'chamfer', 'draft', 'cylinder', 'sphere', 'helix',
  'fuse', 'subtract', 'common', 'mirror', 'translate', 'rotate',
  'repeat', 'copy', 'load', 'part', 'select',
]);

/**
 * Chain-root callees per 2D sketch-geometry feature type (getType values of
 * sketch primitives and derived ops). A sketch-scoped spec's producers are
 * statements inside a sketch body; binding one to a variable and chaining
 * `.edge(...)` on it is valid for exactly these callees. The derived ops
 * (fillet2d & co.) take ownership of the edges they emit, so a pick on one of
 * their edges attributes to their statement.
 */
export const SKETCH_PRODUCER_CALLEES: Record<string, string[]> = {
  line: ['line'],
  circle: ['circle'],
  ellipse: ['ellipse'],
  arc: ['arc'],
  bezier: ['bezier'],
  offset: ['offset'],
  projection: ['project'],
  intersect: ['intersect'],
  text: ['text'],
  fillet2d: ['fillet'],
  // The 2D copies take ownership of their operands' edges, so picks on them
  // attribute to the copy statement (the type collides with the 3D copies,
  // which never produce sketch edges, so the entry is unambiguous here).
  'copy-linear': ['copy'],
  'copy-circular': ['copy'],
};

/** The chain-root callees producers of `featureType` may bind. */
/**
 * Chain-root callees per repeat feature type: a clone's picks bind the
 * `repeat()` statement itself (`r.instance(k).endEdges()`). `mirror` is the
 * `getType()` of both `repeat('mirror', …)` and the `mirror()` builder.
 */
const REPEAT_PRODUCER_CALLEES: Record<string, string[]> = {
  'repeat-linear': ['repeat'],
  'repeat-circular': ['repeat'],
  'repeat-matrix': ['repeat'],
  'mirror': ['repeat', 'mirror'],
};

export function producerCallees(featureType: string): Set<string> {
  const sketchCallees = SKETCH_PRODUCER_CALLEES[featureType];
  if (sketchCallees) {
    return new Set(sketchCallees);
  }
  const repeatCallees = REPEAT_PRODUCER_CALLEES[featureType];
  if (repeatCallees) {
    return new Set(repeatCallees);
  }
  return featureType === 'feature' ? REPEAT_TARGET_CALLEES : PRODUCER_CALLEES;
}

/**
 * Producer feature types whose source line must hold exactly one of these
 * calls — sketch, plane, axis and wire inputs are referenced by identity, so
 * any other callee at the line means the file is out of sync. A 'wire' input
 * (a sweep path, a loft guide) is either a sketch or a helix. Null falls
 * back to the general `PRODUCER_CALLEES` allowlist.
 */
export function requiredChainRoots(featureType: string): string[] | null {
  if (featureType === 'sketch') {
    return ['sketch'];
  }
  if (featureType === 'plane') {
    return ['plane'];
  }
  if (featureType === 'axis') {
    return ['axis'];
  }
  if (featureType === 'wire') {
    return ['sketch', 'helix'];
  }
  return null;
}
