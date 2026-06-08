import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// `fluidcad.json` at the workspace root holds the stable, hub-minted model
// identity (and room to grow: default visibility, name, …). It's meant to be
// committed — like `fly.toml`, it ties a workspace to the model it publishes
// to, so re-publishing creates a new VERSION rather than an unrelated model.
const FILENAME = 'fluidcad.json';

export function modelConfigPath(workspace) {
  return join(workspace, FILENAME);
}

/** Read `fluidcad.json`, or an empty object if missing/unreadable. */
export function readModelConfig(workspace) {
  try {
    const cfg = JSON.parse(readFileSync(modelConfigPath(workspace), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/** The persisted hub model id for this workspace, or null on first publish. */
export function readModelId(workspace) {
  const cfg = readModelConfig(workspace);
  return typeof cfg.modelId === 'string' && cfg.modelId ? cfg.modelId : null;
}

/**
 * The persisted identity for this workspace: the hub model `id` and its
 * last-known `name`. Both come back null when absent — first publish, or a
 * `fluidcad.json` the user deleted. The name is shown in the publish prompt so
 * we can name the model offline without a round-trip.
 */
export function readModelIdentity(workspace) {
  const cfg = readModelConfig(workspace);
  return {
    modelId: typeof cfg.modelId === 'string' && cfg.modelId ? cfg.modelId : null,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name : null,
  };
}

/**
 * Shallow-merge `patch` into `fluidcad.json`, preserving any other fields, and
 * write it back (creating the file if needed). `undefined`/`null` values in the
 * patch are skipped, so callers can pass a partial identity without clobbering
 * what's already there.
 */
export function writeModelConfig(workspace, patch) {
  const cfg = readModelConfig(workspace);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) cfg[key] = value;
  }
  writeFileSync(modelConfigPath(workspace), JSON.stringify(cfg, null, 2) + '\n');
}

/** Persist just the hub-minted model id (thin wrapper over `writeModelConfig`). */
export function writeModelId(workspace, modelId) {
  writeModelConfig(workspace, { modelId });
}
