import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TreeHash } from '../../src/packages/tree-hash.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-tree-hash-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

const bytes = (text: string) => Buffer.from(text);

describe('TreeHash — the dirhash of a package tree', () => {
  it('is the sha256 of `<sha256-hex>  <path>` lines in path order, as sha256-<base64>', () => {
    const a = bytes('alpha\n');
    const b = bytes('beta\n');
    const hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    const expected = 'sha256-' + createHash('sha256')
      .update(`${hex(a)}  a.js\n${hex(b)}  dir/b.js\n`)
      .digest('base64');

    expect(TreeHash.ofFiles({ 'dir/b.js': b, 'a.js': a })).toBe(expected);
    expect(TreeHash.ofFiles([{ path: 'a.js', bytes: a }, { path: 'dir/b.js', bytes: b }])).toBe(expected);
  });

  it('orders paths by their bytes, so upper case sorts before lower case', () => {
    const files = { 'b.js': bytes('1'), 'B.js': bytes('2') };
    const hex = (text: string) => createHash('sha256').update(text).digest('hex');
    const expected = 'sha256-' + createHash('sha256').update(`${hex('2')}  B.js\n${hex('1')}  b.js\n`).digest('base64');
    expect(TreeHash.ofFiles(files)).toBe(expected);
  });

  it('changes with one byte of one file, and with a renamed file', () => {
    const base = TreeHash.ofFiles({ 'a.js': bytes('x'), 'b.js': bytes('y') });
    expect(TreeHash.ofFiles({ 'a.js': bytes('x'), 'b.js': bytes('z') })).not.toBe(base);
    expect(TreeHash.ofFiles({ 'a.js': bytes('x'), 'c.js': bytes('y') })).not.toBe(base);
  });

  it('hashes a directory the same as its files, empty directories ignored', async () => {
    write('index.js', 'export {};\n');
    write('parts/spacer.part.js', '// spacer\n');
    fs.mkdirSync(path.join(dir, 'empty'));
    expect(await TreeHash.ofDirectory(dir)).toBe(TreeHash.ofFiles({
      'index.js': bytes('export {};\n'),
      'parts/spacer.part.js': bytes('// spacer\n'),
    }));
  });

  it('refuses a symbolic link inside the tree', async () => {
    write('index.js', 'export {};\n');
    fs.symlinkSync(path.join(dir, 'index.js'), path.join(dir, 'link.js'));
    await expect(TreeHash.ofDirectory(dir)).rejects.toThrow('TreeHash: link.js is not a regular file');
  });

  it('refuses paths dirhash can\'t line up', () => {
    for (const bad of ['', '/abs.js', '../up.js', 'a\\b.js', 'new\nline.js']) {
      expect(() => TreeHash.ofFiles({ [bad]: bytes('x') })).toThrow('is not a relative POSIX path');
    }
  });
});
