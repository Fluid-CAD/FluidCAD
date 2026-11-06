import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * A select's open list (`::picker(select)`) is daisyUI's
 * `background-color: inherit`, so a select on a tinted, ghost or panel-bg
 * field opened a see-through list over the panel. styles.css gives every
 * picker the popups' solid surface once; these checks keep that rule in
 * place and keep call sites from styling pickers on their own again.
 */

const SRC = resolve(__dirname, '../src');
const STYLES = join(SRC, 'styles.css');
const css = readFileSync(STYLES, 'utf8');

/** The CSS with comments blanked, so a comment's braces or selectors never count. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));

/** Every top-level rule: its prelude and its body, outside any @layer, @utility or other block. */
function topLevelRules(source: string): { prelude: string; body: string }[] {
  const rules: { prelude: string; body: string }[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) {
        prelude = source.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules.push({ prelude, body: source.slice(bodyStart, i) });
        preludeStart = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      preludeStart = i + 1;
    }
  }
  return rules;
}

/** Every .ts and .css file under the UI source. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(ts|css)$/.test(name)) {
      files.push(path);
    }
  }
  return files;
}

describe('select picker surface', () => {
  it('gives every select picker the solid base surface from an unlayered rule', () => {
    const rule = topLevelRules(code).find(r => r.prelude === '::picker(select)');
    expect(rule, 'styles.css needs a top-level ::picker(select) rule').toBeDefined();
    expect(rule!.body).toMatch(/background-color:\s*var\(--color-base-100\)\s*;/);
  });

  it('keeps the base surface opaque in every theme', () => {
    const themes = topLevelRules(code).filter(r => r.prelude.startsWith('@plugin "daisyui/theme"'));
    expect(themes.length).toBeGreaterThanOrEqual(2);
    for (const theme of themes) {
      const name = theme.body.match(/name:\s*"([^"]+)"/)?.[1];
      const base = theme.body.match(/--color-base-100:\s*([^;]+);/)?.[1].trim();
      expect(base, `${name} --color-base-100`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('leaves picker styling to styles.css alone', () => {
    const offenders = sourceFiles(SRC)
      .filter(path => path !== STYLES)
      .filter(path => readFileSync(path, 'utf8').includes('picker(select)'))
      .map(path => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
