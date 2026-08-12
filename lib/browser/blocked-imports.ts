/**
 * Node built-in modules that user `.fluid.js` code must not import. The same
 * set is enforced by LocalSceneHost (at SSR transform time), the model packer
 * (at bundle time), and the browser viewer's in-browser bundler, so a packed
 * or shared model can't smuggle in capabilities a live workspace would have
 * rejected. Lives in lib (not server) so browser bundles can enforce it
 * without pulling in the server.
 */
export const BLOCKED_NODE_MODULES = new Set([
  'fs',
  'child_process',
  'net',
  'dgram',
  'tls',
  'http',
  'https',
  'http2',
  'os',
  'worker_threads',
  'vm',
  'cluster',
  'dns',
  'module',
]);

export function getBlockedNodeModule(id: string): string | null {
  let name = id;
  if (name.startsWith('node:')) {
    name = name.slice(5);
  }
  const baseName = name.split('/')[0];
  return BLOCKED_NODE_MODULES.has(baseName) ? baseName : null;
}
