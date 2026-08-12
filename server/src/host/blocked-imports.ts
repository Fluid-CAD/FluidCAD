/**
 * Moved to lib/browser so the browser viewer's in-browser bundler can enforce
 * the same deny list without pulling in the server. Re-exported here to keep
 * LocalSceneHost and the model packer import paths unchanged.
 */
export { BLOCKED_NODE_MODULES, getBlockedNodeModule } from '../../../lib/dist/browser/blocked-imports.js';
