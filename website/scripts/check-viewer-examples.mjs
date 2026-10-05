// Run tutorial examples through the browser viewer, not the desktop engine.
// Start a local FluidCAD-Viewer first, then:
// VIEWER_URL=http://localhost:8790 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   npm run check:viewer -- handwheel
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateRawSync} from 'node:zlib';

const viewer = new URL(process.env.VIEWER_URL || 'http://localhost:8790');
assert(['localhost', '127.0.0.1', '[::1]'].includes(viewer.hostname),
  'Use a local viewer: this check keeps example source on your machine.');
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const examples = process.argv.slice(2);
if (!examples.length) examples.push('handwheel');

try {
  for (const name of examples) {
    const file = name.endsWith('.js') ? name : `${name}-final.js`;
    const source = await readFile(new URL(`../docs/tutorials/_examples/${file}`, import.meta.url), 'utf8');
    const page = await browser.newPage();
    try {
      // Subscribe when the viewer creates its client, before the first render.
      await page.addInitScript(() => {
        let client;
        Object.defineProperty(window, '__viewerClient', {
          configurable: true,
          get: () => client,
          set: value => {
            client = value;
            value.onScene(({outcome}) => {
              const shapes = (outcome.result ?? [])
                .filter(object => object.visible)
                .flatMap(object => object.sceneShapes ?? [])
                .filter(shape => (shape.meshes ?? []).some(mesh => mesh.vertices?.length));
              window.__exampleCheck = {
                compileError: outcome.compileError?.message ?? null,
                objectErrors: outcome.objectErrors ?? [],
                shapeIds: [...new Set(shapes.map(shape => shape.shapeId))],
                unit: outcome.unit,
              };
            });
          },
        });
      });
      const params = new URLSearchParams({
        entry: file.replace(/(?:-final)?\.js$/, '.fluid.js'),
        code: deflateRawSync(source).toString('base64url'),
      });
      if (process.env.FLUIDCAD_ENGINE_VERSION) params.set('v', process.env.FLUIDCAD_ENGINE_VERSION);
      await page.goto(`${viewer.origin}/#${params}`);
      await page.waitForFunction(() => window.__exampleCheck !== undefined, null, {timeout: 60000});
      const result = await page.evaluate(() => window.__exampleCheck);
      assert.equal(result.compileError, null, `${file}: ${result.compileError}`);
      assert.deepEqual(result.objectErrors, [], `${file}: failed modeling features`);
      assert(result.shapeIds.length > 0, `${file}: rendered no model geometry`);
      console.log(`${file}: rendered ${result.shapeIds.length} shape(s), ${result.unit}, no errors`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
