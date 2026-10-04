import { describe, it, expect } from "vitest";
import { CallShapeMismatch, FeatureCall, type CallLayout, type CallReader, type CallShape } from "../../sdk/call-shape.js";

/** A stand-in for a scene object: a class instance, never an object of options. */
class Ref {
  constructor(readonly name: string) {}
}

const DRAFT: CallShape = ['angle', '...faces'];
const STANDOFF: CallShape = ['face', { height: 'height', outer: 'outer', hole: 'hole' }];

/** A laid-out call as the run-time arguments it stands for. */
function argsOf<T>(layout: CallLayout<T>): unknown[] {
  return layout.args.map(arg => arg.kind === 'options'
    ? Object.fromEntries(arg.entries.map(entry => [entry.key, entry.value]))
    : arg.value);
}

describe("a call shape", () => {
  it("reads draft(angle, ...faces) and lays it out again", () => {
    const call = new FeatureCall(DRAFT, [], 'draft');
    const [a, b] = [new Ref('a'), new Ref('b')];

    expect(call.params()).toEqual(['angle', 'faces']);
    expect(call.parse([5, a, b])).toEqual({ angle: 5, faces: [a, b] });
    expect(call.parse([5])).toEqual({ angle: 5, faces: [] });
    expect(call.parse([])).toEqual({ faces: [] });

    for (const args of [[5, a, b], [5, a], [5]]) {
      expect(argsOf(call.layout(call.parse(args)))).toEqual(args);
    }
    expect(call.layout({ angle: '2 * taper', faces: ['e.sideFaces()', 'f'] }).args).toEqual([
      { kind: 'positional', param: 'angle', value: '2 * taper' },
      { kind: 'rest', param: 'faces', value: 'e.sideFaces()' },
      { kind: 'rest', param: 'faces', value: 'f' },
    ]);
  });

  it("reads standoff(face, { height, outer, hole }) and lays it out again", () => {
    const call = new FeatureCall(STANDOFF, ['add', 'new'], 'standoff');
    const face = new Ref('top');

    expect(call.params()).toEqual(['face', 'height', 'outer', 'hole']);
    expect(call.parse([face, { height: 8, hole: 2 }])).toEqual({ face, height: 8, hole: 2 });
    expect(call.parse([face])).toEqual({ face });
    expect(call.parse([face, {}])).toEqual({ face });

    for (const args of [[face, { height: 8, outer: 6, hole: 2 }], [face, { outer: 5 }], [face]]) {
      expect(argsOf(call.layout(call.parse(args)))).toEqual(args);
    }
    const values = { face: 'e.endFaces()', height: 'h', outer: 6, hole: 3 };
    expect(call.parse(argsOf(call.layout(values)))).toEqual(values);
    expect(call.layout(values).args).toEqual([
      { kind: 'positional', param: 'face', value: 'e.endFaces()' },
      { kind: 'options', entries: [
        { key: 'height', param: 'height', value: 'h' },
        { key: 'outer', param: 'outer', value: 6 },
        { key: 'hole', param: 'hole', value: 3 },
      ] },
    ]);
  });

  it("leaves out what is undefined: trailing slots, option entries and an empty object", () => {
    const call = new FeatureCall(['a', 'b', { size: 'size' }]);
    expect(argsOf(call.layout({ a: 1 }))).toEqual([1]);
    expect(argsOf(call.layout({ a: 1, b: undefined, size: undefined }))).toEqual([1]);
    expect(argsOf(call.layout({ b: 2 }))).toEqual([undefined, 2]);
    expect(argsOf(call.layout({ size: 3 }))).toEqual([undefined, undefined, { size: 3 }]);
    expect(argsOf(call.layout({}))).toEqual([]);
    expect(call.parse([undefined, 2, { size: undefined }])).toEqual({ b: 2 });
  });

  it("keeps a positional value's place when a rest element follows it, writing its placeholder there", () => {
    const call = new FeatureCall(DRAFT, [], 'draft');
    const [a, b] = [new Ref('a'), new Ref('b')];

    // Dropping the angle's place would hand the first face to the angle.
    expect(argsOf(call.layout<unknown>({ faces: [a, b] }))).toEqual([undefined, a, b]);
    expect(call.parse(argsOf(call.layout<unknown>({ faces: [a, b] })))).toEqual({ faces: [a, b] });
    // A trailing one still goes when nothing follows it.
    expect(argsOf(call.layout<unknown>({ faces: [] }))).toEqual([]);

    const placeholder = (param: string) => (param === 'angle' ? '5' : undefined);
    expect(argsOf(call.layout({ faces: ['e.sideFaces()'] }, undefined, { placeholder }))).toEqual(['5', 'e.sideFaces()']);
    expect(argsOf(call.layout({ angle: '8', faces: ['f'] }, undefined, { placeholder }))).toEqual(['8', 'f']);
    expect(argsOf(call.layout({}, undefined, { placeholder }))).toEqual([]);

    const options = new FeatureCall(['a', 'b', { size: 'size' }]);
    const fill = (param: string) => (param === 'a' ? 'A' : undefined);
    expect(argsOf(options.layout<unknown>({ size: 3 }, undefined, { placeholder: fill }))).toEqual(['A', undefined, { size: 3 }]);
    expect(argsOf(options.layout<unknown>({ b: 2 }, undefined, { placeholder: fill }))).toEqual(['A', 2]);
  });

  it("tells an object of options from a rest value's scene objects", () => {
    const call = new FeatureCall(['angle', { neutral: 'neutral' }, '...faces']);
    const [a, b] = [new Ref('a'), new Ref('b')];

    expect(call.parse([5, a, b])).toEqual({ angle: 5, faces: [a, b] });
    expect(call.parse([5, { neutral: 'xy' }, a])).toEqual({ angle: 5, neutral: 'xy', faces: [a] });
    expect(call.parse([5, undefined, a])).toEqual({ angle: 5, faces: [a] });
    expect(argsOf(call.layout<unknown>({ angle: 5, faces: [a, b] }))).toEqual([5, a, b]);
    expect(argsOf(call.layout<unknown>({ angle: 5, neutral: 'xy', faces: [a] }))).toEqual([5, { neutral: 'xy' }, a]);
    // One scene object for the rest value is a list of one.
    expect(argsOf(call.layout({ angle: 5, faces: a as never }))).toEqual([5, a]);
  });

  it("lays a list value out in its own slot", () => {
    const call = new FeatureCall(['targets', { along: 'along' }]);
    const [a, b] = [new Ref('a'), new Ref('b')];
    expect(call.layout({ targets: [a, b], along: [b] }).args).toEqual([
      { kind: 'positional', param: 'targets', value: [a, b] },
      { kind: 'options', entries: [{ key: 'along', param: 'along', value: [b] }] },
    ]);
  });

  it("refuses a call that doesn't fit", () => {
    const standoff = new FeatureCall(STANDOFF, [], 'standoff');
    const face = new Ref('top');
    expect(() => standoff.parse([face, { heigth: 3 }]))
      .toThrow("standoff(): unknown option 'heigth' — the options are 'height', 'outer' and 'hole'");
    expect(() => standoff.parse([face, 5])).toThrow("standoff(): argument 2 must be an object of options { height, outer, hole }");
    expect(() => standoff.parse([face, face])).toThrow(CallShapeMismatch);
    expect(() => standoff.parse([face, {}, 3])).toThrow("standoff(): takes at most 2 arguments, got 3");
    expect(() => new FeatureCall(['angle'], [], 'tilt').parse([1, 2])).toThrow("tilt(): takes at most 1 argument, got 2");
  });

  it("refuses a shape outside the grammar", () => {
    expect(() => new FeatureCall('face' as never)).toThrow(/must be a list of slots/);
    expect(() => new FeatureCall(['...faces', 'angle'])).toThrow("the rest value '...faces' must come last in the call shape");
    expect(() => new FeatureCall([{ a: 'a' }, 'b'])).toThrow("the positional value 'b' must come before the object of options");
    expect(() => new FeatureCall([{ a: 'a' }, { b: 'b' }])).toThrow("a call shape has at most one object of options");
    expect(() => new FeatureCall(['a', { b: 'a' }])).toThrow("the call shape names 'a' twice");
    expect(() => new FeatureCall(['a', '...a'])).toThrow("the call shape names 'a' twice");
    expect(() => new FeatureCall([{}])).toThrow("the object of options in the call shape is empty");
    expect(() => new FeatureCall(['two words'])).toThrow("the call shape's positional value 'two words' is not a value name");
    expect(() => new FeatureCall([{ 'my-key': 'a' }])).toThrow("the option key 'my-key' is not an identifier");
    expect(() => new FeatureCall([{ a: 3 } as never])).toThrow("the option 'a' must name a value, got a number");
    expect(() => new FeatureCall([3 as never])).toThrow(/a call shape slot is a value name, '...name', or an object of options; got a number/);
    expect(() => new FeatureCall(['a'], ['cut' as never])).toThrow("unknown operation 'cut'");
  });

  it("reads arguments of any kind through a reader, as the editor reads syntax", () => {
    type Node = { text: string } | { object: [string, Node][] };
    const reader: CallReader<Node> = {
      isAbsent: node => 'text' in node && node.text === 'undefined',
      optionEntries: node => 'object' in node ? node.object : null,
    };
    const call = new FeatureCall(STANDOFF);
    const face = { text: 'e.endFaces()' };
    const height = { text: 'h * 2' };
    expect(call.read<Node>([face, { object: [['height', height]] }], reader)).toEqual({ face, height });
    expect(call.read<Node>([{ text: 'undefined' }, { object: [] }], reader)).toEqual({});
    expect(() => call.read<Node>([face, { object: [['size', height]] }], reader)).toThrow(/unknown option 'size'/);
  });
});

describe("a call shape's operation chains", () => {
  const call = new FeatureCall(STANDOFF, ['add', 'new', 'remove'], 'standoff');

  it("write nothing for an add, and the operation and its scope otherwise", () => {
    expect(call.layout({ face: 'f' }, { operation: 'add' }).chains).toEqual([]);
    expect(call.layout({ face: 'f' }, { operation: 'new' }).chains).toEqual([{ method: 'new', args: [] }]);
    expect(call.layout({ face: 'f' }, { operation: 'remove', scope: ['block'] }).chains)
      .toEqual([{ method: 'remove', args: [] }, { method: 'scope', args: ['block'] }]);
    expect(call.layout({ face: 'f' }, { operation: 'add', scope: ['a', 'b'] }).chains)
      .toEqual([{ method: 'scope', args: ['a', 'b'] }]);
    expect(call.layout({ face: 'f' }).chains).toEqual([]);
  });

  it("refuse an operation the feature doesn't offer, and a scope on a new solid", () => {
    expect(() => new FeatureCall(STANDOFF, ['add', 'new'], 'standoff').layout({}, { operation: 'remove' }))
      .toThrow("standoff(): the operation 'remove' is not one of 'add' and 'new'");
    expect(() => new FeatureCall(STANDOFF, [], 'standoff').layout({}, { operation: 'add' }))
      .toThrow("standoff(): the feature declares no operations");
    expect(() => call.layout({}, { operation: 'new', scope: ['a'] })).toThrow(/a new solid fuses with nothing/);
  });

  it("read back as the statement runs them: the last operation wins and resets the scope", () => {
    expect(call.readChains([])).toEqual({ operation: 'add', explicit: false, scope: null, foreign: [] });
    expect(call.readChains([{ method: 'remove', args: [] }, { method: 'scope', args: ['b'] }]))
      .toEqual({ operation: 'remove', explicit: true, scope: ['b'], foreign: [] });
    expect(call.readChains([{ method: 'scope', args: ['b'] }, { method: 'new', args: [] }]))
      .toEqual({ operation: 'new', explicit: true, scope: null, foreign: [] });
    expect(call.readChains([{ method: 'name', args: ["'boss'"] }, { method: 'new', args: [] }, { method: 'add', args: [] }]))
      .toEqual({ operation: 'add', explicit: true, scope: null, foreign: [0] });
    expect(call.readChains([{ method: 'scope', args: ['b'] }]))
      .toEqual({ operation: 'add', explicit: false, scope: ['b'], foreign: [] });
  });

  it("belong to the statement alone when the feature declares no operations", () => {
    const plain = new FeatureCall(STANDOFF, [], 'standoff');
    expect(plain.defaultOperation).toBeNull();
    expect(plain.readChains([{ method: 'remove', args: [] }, { method: 'scope', args: ['b'] }]))
      .toEqual({ operation: 'add', explicit: false, scope: null, foreign: [0, 1] });
  });

  it("refuse a statement whose operation the dialog doesn't offer", () => {
    expect(() => new FeatureCall(STANDOFF, ['add', 'new'], 'standoff').readChains([{ method: 'remove', args: [] }]))
      .toThrow("standoff(): the statement uses .remove(), which its dialog doesn't offer — it offers 'add' and 'new'");
    expect(() => new FeatureCall(STANDOFF, ['remove'], 'boltCircle').readChains([{ method: 'add', args: [] }]))
      .toThrow("boltCircle(): the statement uses .add(), which its dialog doesn't offer — it offers 'remove'");
  });
});

describe("a feature's default operation", () => {
  it("is add when the feature offers it, else the first operation it declares", () => {
    expect(FeatureCall.defaultOperationOf(['add', 'new'])).toBe('add');
    expect(FeatureCall.defaultOperationOf(['new', 'remove', 'add'])).toBe('add');
    expect(FeatureCall.defaultOperationOf(['remove'])).toBe('remove');
    expect(FeatureCall.defaultOperationOf(['remove', 'new'])).toBe('remove');
    expect(FeatureCall.defaultOperationOf(['new', 'remove'])).toBe('new');
    expect(FeatureCall.defaultOperationOf([])).toBeNull();
    expect(new FeatureCall(STANDOFF, ['remove'], 'boltCircle').defaultOperation).toBe('remove');
  });

  const cutOnly = new FeatureCall(STANDOFF, ['remove'], 'boltCircle');
  const cutOrNew = new FeatureCall(STANDOFF, ['remove', 'new'], 'boltCircle');

  it("is what a statement without an operation chain reads as, and an explicit chain the same operation", () => {
    expect(cutOnly.readChains([])).toEqual({ operation: 'remove', explicit: false, scope: null, foreign: [] });
    expect(cutOnly.readChains([{ method: 'remove', args: [] }]))
      .toEqual({ operation: 'remove', explicit: true, scope: null, foreign: [] });
    expect(cutOnly.readChains([{ method: 'scope', args: ['plate'] }]))
      .toEqual({ operation: 'remove', explicit: false, scope: ['plate'], foreign: [] });
    expect(cutOrNew.readChains([])).toMatchObject({ operation: 'remove', explicit: false });
    expect(cutOrNew.readChains([{ method: 'new', args: [] }])).toMatchObject({ operation: 'new', explicit: true });
  });

  it("writes no chain — only .scope(…) when it names solids — unless the edit keeps one the statement spelled out", () => {
    expect(cutOnly.layout({ face: 'f' }, { operation: 'remove' }).chains).toEqual([]);
    expect(cutOnly.layout({ face: 'f' }, { operation: 'remove', scope: ['plate'] }).chains)
      .toEqual([{ method: 'scope', args: ['plate'] }]);
    expect(cutOnly.layout({ face: 'f' }, { operation: 'remove', explicit: true }).chains)
      .toEqual([{ method: 'remove', args: [] }]);
    expect(cutOnly.layout({ face: 'f' }, { operation: 'remove', scope: ['plate'], explicit: true }).chains)
      .toEqual([{ method: 'remove', args: [] }, { method: 'scope', args: ['plate'] }]);
    expect(cutOrNew.layout({ face: 'f' }, { operation: 'new' }).chains).toEqual([{ method: 'new', args: [] }]);
    // The standoff's default is add: an explicit .add() is kept the same way.
    expect(new FeatureCall(STANDOFF, ['add', 'new'], 'standoff').layout({}, { operation: 'add', explicit: true }).chains)
      .toEqual([{ method: 'add', args: [] }]);
  });

  it("round trips a statement with and without the default's chain", () => {
    for (const chains of [[], [{ method: 'remove', args: [] }], [{ method: 'scope', args: ['plate'] }], [{ method: 'new', args: [] }]]) {
      const read = cutOrNew.readChains(chains);
      const written = cutOrNew.layout({}, { operation: read.operation, scope: read.scope, explicit: read.explicit }).chains;
      expect(written).toEqual(chains);
      expect(cutOrNew.readChains(written)).toEqual(read);
    }
  });
});
