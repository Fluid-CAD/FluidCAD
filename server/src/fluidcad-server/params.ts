// Sanitizing parameter values before they cross into the engine.

const MAX_PARAM_DEPTH = 6;

export function sanitizeParams(value: unknown, depth = 0): any {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_PARAM_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeParams(v, depth + 1));
  }
  if (typeof value === 'object') {
    // A scene-object reference. Render as { ref: id } so the agent can chase
    // it through other tools without us shipping the whole subtree.
    const maybeId = (value as any).id;
    const isSceneObjectRef =
      typeof maybeId === 'string' &&
      typeof (value as any).getType === 'function';
    if (isSceneObjectRef) {
      return { ref: maybeId };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'function') {
        continue;
      }
      out[k] = sanitizeParams(v, depth + 1);
    }
    return out;
  }
  return null;
}
