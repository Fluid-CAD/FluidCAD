import { describe, it, expect } from "vitest";
import { SceneObject, SourceLocation } from "../../../common/scene-object.js";
import { SketchStatementKeys } from "../../../features/2d/regions/statement-keys.js";

// The statement keys read binding names out of the sketch callback's text,
// addressed by each statement's stamped line and column. This exercises the
// reader on its own, with hand-made statements, so the two column
// conventions a stack trace may report are both covered: V8's own frames
// point at the callee's first character, Node's source-map-aware frames at
// the opening parenthesis.

const FILE = '/ws/model.fluid.js';

class Statement extends SceneObject {
  constructor(private readonly type: string, location: SourceLocation | null) {
    super();
    if (location) {
      this.setSourceLocation(location);
    }
  }
  getType(): string {
    return this.type;
  }
  serialize() {
    return {};
  }
  build(): void {}
}

const at = (line: number, column: number): SourceLocation => ({ filePath: FILE, line, column });

const CALLBACK = [
  '() => {',
  '    const b = line([0, 0], [100, 0]);',
  '    const h1 = circle([30, 30], 16);',
  '    circle([70, 30], 16);',
  '    const a = arc([0, 0], [10, 0], [5, 5]), c = arc([1, 1], [2, 2], [3, 3]);',
  '}',
].join('\n');

const SKETCH_LINE = 10;

function keysFor(columns: { line: number; column: number; type: string }[]): string[] {
  const statements = columns.map(c => new Statement(c.type, at(SKETCH_LINE + c.line, c.column)));
  const keys = new SketchStatementKeys(statements, {
    sketchLocation: at(SKETCH_LINE, 1),
    callbackSource: CALLBACK,
  });
  return statements.map(s => keys.keyOf(s)!);
}

describe("SketchStatementKeys", () => {
  it("reads the binding when the column is the callee's first character", () => {
    expect(keysFor([
      { line: 1, column: 15, type: 'line' },
      { line: 2, column: 16, type: 'circle' },
      { line: 3, column: 5, type: 'circle' },
      { line: 4, column: 15, type: 'arc' },
      { line: 4, column: 49, type: 'arc' },
    ])).toEqual(['b', 'h1', 'circle#2', 'a', 'c']);
  });

  it("reads the binding when the column is the call's opening parenthesis", () => {
    expect(keysFor([
      { line: 1, column: 19, type: 'line' },
      { line: 2, column: 22, type: 'circle' },
      { line: 3, column: 11, type: 'circle' },
      { line: 4, column: 18, type: 'arc' },
      { line: 4, column: 52, type: 'arc' },
    ])).toEqual(['b', 'h1', 'circle#2', 'a', 'c']);
  });

  it("sees through Vite's SSR import rewrite to the file's own text", () => {
    const transformed = [
      '() => {',
      '    const b = (0,__vite_ssr_import_0__.line)([0, 0], [100, 0]);',
      '    const h1 = __vite_ssr_import_0__.circle([30, 30], 16);',
      '    (0,__vite_ssr_import_0__.circle)([70, 30], 16);',
      '}',
    ].join('\n');
    const statements = [
      new Statement('line', at(SKETCH_LINE + 1, 19)),
      new Statement('circle', at(SKETCH_LINE + 2, 22)),
      new Statement('circle', at(SKETCH_LINE + 3, 11)),
    ];
    const keys = new SketchStatementKeys(statements, {
      sketchLocation: at(SKETCH_LINE, 7),
      callbackSource: transformed,
    });
    expect(statements.map(s => keys.keyOf(s))).toEqual(['b', 'h1', 'circle#2']);
  });

  it("falls back to ordinals when a statement's callee is not where its column says", () => {
    expect(keysFor([
      { line: 1, column: 30, type: 'line' },
      { line: 2, column: 16, type: 'circle' },
    ])).toEqual(['line#1', 'h1']);
  });

  it("gives every statement an ordinal without source information", () => {
    const statements = [new Statement('line', null), new Statement('line', null), new Statement('circle', null)];
    const keys = new SketchStatementKeys(statements, { sketchLocation: null, callbackSource: null });
    expect(statements.map(s => keys.keyOf(s))).toEqual(['line#1', 'line#2', 'circle#1']);
    expect(keys.statementOf('line#2')).toBe(statements[1]);
    expect(keys.orderOf(statements[2])).toBe(2);
  });
});
