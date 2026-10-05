import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import { readEngineTypes, readOcctTypes, createEngineTypesRouter } from '../src/routes/engine-types.ts';

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
    expect(shim('sdk/occt')?.content).toBe("export * from '../lib/dist/sdk/occt';\n");
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

/**
 * Raw OpenCascade's declarations — the binding's whole API, about 2 MB —
 * stay out of the engine's payload: the page fetches them on their own
 * route once a file reaches `fluidcad/sdk/occt`.
 */
describe('the OpenCascade binding\'s declarations', () => {
  it('stay out of the engine payload, which names the binding but doesn\'t carry it', () => {
    const { files, bytes } = readEngineTypes();
    expect(files.some(file => file.uri.includes('ocjs-fluidcad'))).toBe(false);
    expect(bytes).toBeLessThan(1_500_000);
    const occt = files.find(file => file.uri === 'file:///node_modules/fluidcad/lib/dist/sdk/occt.d.ts');
    expect(occt?.content).toContain('from "ocjs-fluidcad"');
  });

  it('are published where node resolution from the engine\'s declarations finds them', () => {
    const payload = readOcctTypes();
    expect(payload).not.toBeNull();
    const uris = payload!.files.map(file => file.uri);
    expect(uris).toEqual([
      'file:///node_modules/ocjs-fluidcad/package.json',
      'file:///node_modules/ocjs-fluidcad/dist/index.d.ts',
      'file:///node_modules/ocjs-fluidcad/dist/opencascade.fluidcad.multi-threaded.d.ts',
    ]);
    expect(JSON.parse(payload!.files[0].content)).toEqual({ name: 'ocjs-fluidcad', types: './dist/index.d.ts' });
    expect(payload!.files[1].content).toContain('export * from "./opencascade.fluidcad.multi-threaded.js"');
    expect(payload!.files[2].content).toContain('export declare class BRepOffsetAPI_ThruSections');
    expect(payload!.bytes).toBeGreaterThan(1_500_000);
  });

  it('are served on their own route', async () => {
    const app = express();
    app.use('/api', createEngineTypesRouter('9.9.9'));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/engine/types/occt`);
      const body = await res.json() as { version: string; files: { uri: string }[] };
      expect(res.status).toBe(200);
      expect(body.version).toBe('9.9.9');
      expect(body.files).toHaveLength(3);
    } finally {
      server.close();
    }
  });
});
