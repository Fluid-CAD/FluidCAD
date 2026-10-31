import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InProcessEngine } from '../../src/packages/in-process-engine.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';

// An engine booted in process (`fluidcad pack`, `publish`) reads a load()'s
// imported asset under the workspace it was booted over, never the
// process's working directory (here the repository, where vitest runs) —
// and the engine is one per process (init() hands back the manager that
// exists), so a second engine over another workspace reads that one's, and
// the first reads its own again on its next render.

const FIXTURE = path.resolve(__dirname, '../fixtures/imported-step');

let scratch: string;

/** A workspace whose `<name>.part.js` load()s `<name>.step`, imported as `imports/<name>.*`. */
function workspace(dir: string, name: string): string {
  const ws = path.join(scratch, dir);
  fs.mkdirSync(path.join(ws, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  fs.writeFileSync(
    path.join(ws, `${name}.part.js`),
    `import { part, load } from 'fluidcad/core';\n\nexport const ${name} = part('${name}', () => {\n  load('${name}.step');\n});\n`,
  );
  for (const suffix of ['.brep', '.colors.json', '.import.json']) {
    fs.copyFileSync(path.join(FIXTURE, `spacer${suffix}`), path.join(ws, 'imports', `${name}${suffix}`));
  }
  return ws;
}

/** The build errors of `file`'s render in `engine`, one `<type>: <message>` each. */
async function errorsOf(engine: InProcessEngine, file: string): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const data = await engine.server.processFile(file);
    expect(data).not.toBeNull();
    return FluidCadServer.collectObjectErrors(data!.result).map((e) => `${e.uniqueKind}: ${e.message}`);
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-engine-root-'));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('an engine booted in process', () => {
  it('reads a load()\'s imported asset under its workspace, wherever the process runs', async () => {
    const ws = workspace('kit', 'spacer');
    expect(process.cwd()).not.toBe(ws);

    const errors = await InProcessEngine.run(ws, (engine) => errorsOf(engine, path.join(ws, 'spacer.part.js')), { linkEngine: false });

    expect(errors).toEqual([]);
  });

  it('reads each workspace\'s assets when two engines share the process', async () => {
    const first = workspace('first', 'spacer');
    const second = workspace('second', 'washer');
    const a = await InProcessEngine.boot(first, { linkEngine: false });
    try {
      const b = await InProcessEngine.boot(second, { linkEngine: false });
      try {
        // The second engine is the first one's manager, rooted at its own workspace…
        expect(await errorsOf(b, path.join(second, 'washer.part.js'))).toEqual([]);
        // …and the first reads its own again, though the second has no spacer import.
        expect(await errorsOf(a, path.join(first, 'spacer.part.js'))).toEqual([]);
        expect(fs.existsSync(path.join(second, 'imports', 'spacer.brep'))).toBe(false);
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  });
});
