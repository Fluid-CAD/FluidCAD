import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server.ts';

// A workspace with no `init.js` has no engine, so every render path returns
// null. That null used to reach the UI as *nothing at all* — no
// `scene-rendered`, no error — leaving the page on "Loading model…" forever
// with nothing to act on. The server has to be able to say why instead.

describe('a workspace with no engine', () => {
  it('explains itself instead of failing silently', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-no-init-'));
    try {
      const server = new FluidCadServer();
      await server.init(workspace);

      const reason = server.describeMissingEngine();
      expect(reason).toBeTruthy();
      expect(reason).toContain('init.js');
      // Actionable, not just descriptive: it names the command and the place.
      expect(reason).toContain('fluidcad init');
      expect(reason).toContain(workspace);

      // And the render that follows still answers null, which is what the
      // caller turns into the visible error.
      const file = path.join(workspace, 'part.fluid.js');
      fs.writeFileSync(file, '// nothing to build\n');
      expect(await server.processFile(file)).toBeNull();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
