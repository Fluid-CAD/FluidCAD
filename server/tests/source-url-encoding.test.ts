import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodeSourceUrl } from '../src/host/source-url-encoding.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { extractSourceLocation } from '../../lib/index.js';

/**
 * V8 drops a `//# sourceURL=` whose value holds whitespace, so a workspace
 * under a directory with a space in its name evaluated every script as
 * `<anonymous>`: no feature got a source location and the UI could map
 * nothing back to code.
 */
describe('encodeSourceUrl', () => {
  it('encodes whitespace and percent signs, and nothing else', () => {
    expect(encodeSourceUrl('/home/user/My Projects/100%/a b.part.js')).toBe(
      '/home/user/My%20Projects/100%25/a%20b.part.js',
    );
    expect(encodeSourceUrl('virtual:live-render:C:/proj/test.fluid.js')).toBe(
      'virtual:live-render:C:/proj/test.fluid.js',
    );
  });
});

describe('a workspace whose path holds a space', () => {
  it('still names the script in its stack frames', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-spaced-'));
    const workspace = path.join(parent, 'My Projects');
    fs.mkdirSync(workspace);
    const script = path.join(workspace, 'box.part.js');
    fs.writeFileSync(
      script,
      "export const where = () => new Error().stack;\n",
    );

    const host = new LocalSceneHost();
    try {
      await host.init(workspace);
      const mod = await host.loadModuleRaw(script);
      expect(extractSourceLocation(mod.where())?.filePath).toBe(script.replace(/\\/g, '/'));
    } finally {
      await host.server.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
