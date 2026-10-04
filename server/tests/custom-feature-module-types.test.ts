import { describe, it, expect } from 'vitest';
import path from 'path';
import { CheckJs } from '../../lib/tests/helpers/check-js.js';

// The JavaScript standoff is the file a project keeps as standoff.feature.js:
// under the checkJs jsconfig `fluidcad init` writes, it and a model that uses
// it must show no red underlines, with every type inferred.

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/custom-features/standoff.feature.js');

describe('the JavaScript standoff fixture, type-checked as a project checks it', () => {
  it('has no errors, its values and its builder typed by inference alone', () => {
    const check = CheckJs.check({}, [FIXTURE]);

    expect(check.diagnostics()).toEqual([]);
    expect(['height', 'outer', 'hole'].map(name => check.typeOf('standoff.feature.js', name))).toEqual(['number', 'number', 'number']);
    expect(check.typeOf('standoff.feature.js', 'standoff')).toBe(
      '(args_0: ISelection, args_1?: { height?: number | undefined; outer?: number | undefined; hole?: number | undefined; } | undefined) => Standoff',
    );
  });

  it('types a model that places, fillets and repeats it, and marks a misspelled option', () => {
    const fixture = path.relative(path.resolve(import.meta.dirname, '../../lib/tests/.check-js'), FIXTURE);
    const check = CheckJs.check({
      'plate.part.js': `
import { extrude, fillet, repeat } from 'fluidcad/core';
import { standoff } from '${fixture}';

const pad = extrude(4);
const post = standoff(pad.endFaces(), { outer: 6, hole: 3.2 });
const rim = fillet(0.5, post.endEdges());
repeat('linear', 'x', { count: 2, offset: 20 }, pad, post.new(), rim);
standoff(pad.endFaces(), { hieght: 8 });
`,
    }, [FIXTURE]);

    expect(check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`)).toEqual([
      expect.stringContaining("plate.part.js:9: Object literal may only specify known properties, but 'hieght' does not exist in type"),
    ]);
  });
});
