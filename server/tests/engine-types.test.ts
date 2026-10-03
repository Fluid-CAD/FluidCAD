import { describe, it, expect } from 'vitest';
import { readEngineTypes } from '../src/routes/engine-types.ts';

/**
 * The in-page editor resolves `import … from 'fluidcad/<subpath>'` through
 * one shim per engine namespace, each re-exporting the declaration its
 * `exports` target names. A shim that points nowhere leaves every import of
 * that subpath typed `any`, silently.
 */
describe('engine type shims', () => {
  const { files } = readEngineTypes();
  const uris = new Set(files.map(file => file.uri));
  const shim = (name: string) => files.find(file => file.uri === `file:///node_modules/fluidcad/${name}.d.ts`);

  it('re-exports each namespace from the declaration its exports target names', () => {
    expect(shim('index')?.content).toBe("export * from './lib/dist/index';\n");
    expect(shim('core')?.content).toBe("export * from './lib/dist/core/index';\n");
    expect(shim('sdk')?.content).toBe("export * from './lib/dist/sdk/index';\n");
  });

  it('climbs back to the package root from a nested subpath', () => {
    expect(shim('sdk/kernel')?.content).toBe("export * from '../lib/dist/sdk/kernel';\n");
  });

  it('points every shim at a declaration the payload carries', () => {
    const shims = files.filter(file => /^export \* from '[^']+';\n$/.test(file.content));
    expect(shims.length).toBeGreaterThanOrEqual(9);
    for (const file of shims) {
      const target = file.content.match(/'([^']+)'/)![1];
      expect(uris.has(new URL(`${target}.d.ts`, file.uri).href), `${file.uri} → ${target}`).toBe(true);
    }
  });
});
