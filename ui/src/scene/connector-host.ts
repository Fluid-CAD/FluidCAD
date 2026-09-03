/**
 * Whether a connector's host body is hidden — every id in `hostShapeIds`
 * (the lib-resolved body ids the connector sits on, several after a split)
 * is in the viewer's hidden set. A connector with no host (plane- or
 * point-sourced, or a host that left the scene) is never host-hidden.
 */
export function connectorHostHidden(hostShapeIds: unknown, hiddenShapeIds: ReadonlySet<string>): boolean {
  if (!Array.isArray(hostShapeIds) || hostShapeIds.length === 0) {
    return false;
  }
  return hostShapeIds.every((id) => typeof id === 'string' && hiddenShapeIds.has(id));
}
