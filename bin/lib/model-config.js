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
 * Persist the hub-minted model id, preserving any other fields already in
 * `fluidcad.json`. Called after the first publish writes back the new id.
 */
export function writeModelId(workspace, modelId) {
  const cfg = readModelConfig(workspace);
  cfg.modelId = modelId;
  writeFileSync(modelConfigPath(workspace), JSON.stringify(cfg, null, 2) + '\n');
}
