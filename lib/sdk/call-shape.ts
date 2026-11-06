/**
 * A feature's call shape: how the arguments of its builder's call map to the
 * feature's named values. The editor writes and reads statements through it,
 * and a builder parses its arguments with it, so a statement the dialog
 * wrote is exactly one the builder reads back.
 *
 * The grammar is small on purpose. In order:
 *
 * - **positional** values: `'angle'`;
 * - at most one **object of options**, mapping each option key to a value:
 *   `{ height: 'height', outer: 'outer' }`;
 * - at most one trailing **rest** value, a list spread over the remaining
 *   arguments: `'...faces'`.
 *
 * `draft(angle, ...faces)` is `['angle', '...faces']`;
 * `standoff(face, { height, outer, hole })` is
 * `['face', { height: 'height', outer: 'outer', hole: 'hole' }]`.
 *
 * A call may go straight to its object of options, leaving out the
 * positional values before it: an object written as `{ … }` in a
 * positional slot is the options (a positional value never is one), so
 * `gear({ teeth: 24 })` reads for `['at', { teeth: 'teeth' }]`. Whether the
 * values it skips may be left out is the feature's declaration to say.
 *
 * A feature that declares operations also owns the operation chains on its
 * statement: `.add()`, `.new()`, `.remove()` and `.scope(…)`. A statement
 * without an operation chain applies the feature's **default operation**:
 * `add` when the feature offers it, else the first operation it declares —
 * `boltCircle('z')` cuts when the bolt circle offers only `remove`.
 */

/** One slot of a call shape: a positional value, a `'...rest'` value, or the object of options. */
export type CallShapeSlot = string | { readonly [option: string]: string };

/** A feature's call shape (see the module comment). */
export type CallShape = readonly CallShapeSlot[];

/** What a tool feature does with its solids: fuse them in (the default), keep them apart, or cut them. */
export type FeatureOperation = 'add' | 'new' | 'remove';

/** One argument of a laid-out call, carrying the value the writer renders for it. */
export type CallArgument<T> =
  /** A positional value; `undefined` holds the place of a value left out before a later one. */
  | { kind: 'positional'; param: string; value: T | T[] | undefined }
  /** The object of options, its entries in the shape's key order. */
  | { kind: 'options'; entries: { key: string; param: string; value: T | T[] }[] }
  /** One element of the rest value, spread as an argument of its own. */
  | { kind: 'rest'; param: string; value: T };

/** One operation chain on a statement: `.new()`, `.remove()`, `.scope(a, b)`. */
export type CallChain<T> = { method: 'add' | 'new' | 'remove' | 'scope'; args: T[] };

/** A statement's arguments and the operation chains after them. */
export type CallLayout<T> = { args: CallArgument<T>[]; chains: CallChain<T>[] };

/** How {@link FeatureCall.layout} writes what the values leave out. */
export type CallLayoutOptions<T> = {
  /**
   * What a positional value left out writes when a later argument is
   * written — its default, typically: `draft(5, e.sideFaces())` reads
   * better than `draft(undefined, e.sideFaces())`. Undefined writes the
   * `undefined` placeholder.
   */
  placeholder?: (param: string) => T | undefined;
};

/** The operation a statement applies, as the dialog sets it. */
export type CallOperation<T> = {
  operation: FeatureOperation;
  scope?: T[] | null;
  /**
   * Write the operation's chain even when it is the default: an edit keeps
   * a statement that spells its operation out (`.remove()` on a feature
   * that removes anyway) as it is written.
   */
  explicit?: boolean;
};

/**
 * How one kind of argument reads: run-time values for a builder, syntax
 * nodes for the editor. The shape's grammar is the same for both.
 */
export type CallReader<A> = {
  /** An argument standing for a value left out (`undefined`). */
  isAbsent(arg: A): boolean;
  /** The entries of an object of options, or null when the argument is not one. */
  optionEntries(arg: A): [string, A][] | null;
};

/** The chains a statement carries, read by the feature's operations. */
export type ChainReading<A> = {
  operation: FeatureOperation;
  /** Whether an operation chain spells the operation out; false when the statement leaves it to the default. */
  explicit: boolean;
  /** The solids a `.scope(…)` named, or null for the operation's own default. */
  scope: A[] | null;
  /** The indices of the chains the operations don't own, which an edit keeps as they are. */
  foreign: number[];
};

/** A call whose arguments don't fit the shape: the builder throws it, the editor refuses the statement. */
export class CallShapeMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallShapeMismatch';
  }
}

/**
 * A call shape, checked, with its two directions: {@link parse} reads a
 * call's arguments into named values, {@link layout} lays named values out
 * as a call's arguments. Both handle the operation chains when the feature
 * declares operations.
 */
export class FeatureCall {

  private static readonly IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

  private static readonly OPERATION_METHODS = new Set<string>(['add', 'new', 'remove', 'scope']);

  /** The run-time reader: a plain object is the object of options. */
  static readonly VALUES: CallReader<unknown> = {
    isAbsent: arg => arg === undefined,
    optionEntries: arg => FeatureCall.isPlainObject(arg) ? Object.entries(arg) : null,
  };

  /** The positional values, in order. */
  readonly positional: readonly string[];

  /** The object of options: option key → value name, in the shape's order; null without one. */
  readonly options: ReadonlyMap<string, string> | null;

  /** The rest value's name, or null without one. */
  readonly rest: string | null;

  /**
   * The operation a statement without an operation chain applies (see
   * {@link FeatureCall.defaultOperationOf}), or null for a feature that
   * declares no operations.
   */
  readonly defaultOperation: FeatureOperation | null;

  /**
   * @param shape the declared call shape.
   * @param operations the operations the feature offers; empty, the statement's chains are none of its business.
   * @param callee the builder's name, for messages.
   */
  constructor(
    readonly shape: CallShape,
    readonly operations: readonly FeatureOperation[] = [],
    readonly callee = 'feature',
  ) {
    if (!Array.isArray(shape)) {
      throw new Error(`the call shape must be a list of slots, such as ['face', { height: 'height' }]`);
    }
    const positional: string[] = [];
    let options: Map<string, string> | null = null;
    let rest: string | null = null;
    const seen = new Set<string>();
    const claim = (name: string, where: string) => {
      if (!FeatureCall.IDENTIFIER.test(name)) {
        throw new Error(`the call shape's ${where} '${name}' is not a value name`);
      }
      if (seen.has(name)) {
        throw new Error(`the call shape names '${name}' twice`);
      }
      seen.add(name);
    };

    for (const slot of shape) {
      if (rest !== null) {
        throw new Error(`the rest value '...${rest}' must come last in the call shape`);
      }
      if (typeof slot === 'string') {
        if (slot.startsWith('...')) {
          claim(slot.slice(3), 'rest value');
          rest = slot.slice(3);
        } else if (options !== null) {
          throw new Error(`the positional value '${slot}' must come before the object of options`);
        } else {
          claim(slot, 'positional value');
          positional.push(slot);
        }
        continue;
      }
      if (!FeatureCall.isPlainObject(slot)) {
        throw new Error(`a call shape slot is a value name, '...name', or an object of options; got ${FeatureCall.describe(slot)}`);
      }
      if (options !== null) {
        throw new Error('a call shape has at most one object of options');
      }
      const entries = Object.entries(slot);
      if (entries.length === 0) {
        throw new Error('the object of options in the call shape is empty');
      }
      options = new Map();
      for (const [key, name] of entries) {
        if (!FeatureCall.IDENTIFIER.test(key)) {
          throw new Error(`the option key '${key}' is not an identifier`);
        }
        if (typeof name !== 'string') {
          throw new Error(`the option '${key}' must name a value, got ${FeatureCall.describe(name)}`);
        }
        claim(name, `option '${key}' value`);
        options.set(key, name);
      }
    }

    for (const operation of operations) {
      if (operation !== 'add' && operation !== 'new' && operation !== 'remove') {
        throw new Error(`unknown operation '${operation}' — the operations are 'add', 'new' and 'remove'`);
      }
    }

    this.positional = positional;
    this.options = options;
    this.rest = rest;
    this.defaultOperation = FeatureCall.defaultOperationOf(operations);
  }

  /**
   * The operation a feature applies when its statement names none: `add`
   * when it offers `add`, else the first operation it declares — a feature
   * that only cuts cuts without a `.remove()`. Null for a feature that
   * declares no operations: its statements carry no operation chains.
   */
  static defaultOperationOf(operations: readonly FeatureOperation[]): FeatureOperation | null {
    if (operations.length === 0) {
      return null;
    }
    return operations.includes('add') ? 'add' : operations[0];
  }

  /** Every value the shape names, in call order. */
  params(): string[] {
    return [...this.positional, ...(this.options?.values() ?? []), ...(this.rest !== null ? [this.rest] : [])];
  }

  /**
   * A builder's arguments, by value name. A value left out is left out of
   * the result; the rest value is always a list.
   */
  parse(args: ArrayLike<unknown>): Record<string, unknown> {
    return this.read(args, FeatureCall.VALUES);
  }

  /**
   * Arguments of any kind by value name, `reader` telling the object of
   * options apart: each value is its argument (an option's entry for one in
   * the object), and the rest value the list of what remains.
   */
  read<A>(args: ArrayLike<A>, reader: CallReader<A>): Record<string, A | A[]> {
    const list = Array.from(args);
    const out: Record<string, A | A[]> = {};
    let at = 0;

    for (const name of this.positional) {
      if (at >= list.length || this.opensOptions(list[at], reader)) {
        break;
      }
      if (!reader.isAbsent(list[at])) {
        out[name] = list[at];
      }
      at++;
    }

    if (this.options !== null && at < list.length) {
      const arg = list[at];
      const entries = reader.isAbsent(arg) ? [] : reader.optionEntries(arg);
      if (entries !== null) {
        for (const [key, value] of entries) {
          const name = this.options.get(key);
          if (name === undefined) {
            throw new CallShapeMismatch(`${this.callee}(): unknown option '${key}' — the options are ${FeatureCall.listed([...this.options.keys()])}`);
          }
          if (!reader.isAbsent(value)) {
            out[name] = value;
          }
        }
        at++;
      } else if (this.rest === null) {
        throw new CallShapeMismatch(`${this.callee}(): argument ${at + 1} must be an object of options { ${[...this.options.keys()].join(', ')} }`);
      }
    }

    if (this.rest !== null) {
      out[this.rest] = list.slice(at).filter(arg => !reader.isAbsent(arg));
      at = list.length;
    }

    if (at < list.length) {
      throw new CallShapeMismatch(`${this.callee}(): takes at most ${at} argument${at === 1 ? '' : 's'}, got ${list.length}`);
    }
    return out;
  }

  /**
   * The positional values a call leaves out by going straight to its object
   * of options — `gear({ teeth: 24 })` skips `at` — in order. Whether each
   * may be left out is the caller's to check: the shape knows only names.
   */
  skipped<A>(args: ArrayLike<A>, reader: CallReader<A>): string[] {
    const list = Array.from(args);
    for (let at = 0; at < this.positional.length && at < list.length; at++) {
      if (this.opensOptions(list[at], reader)) {
        return this.positional.slice(at);
      }
    }
    return [];
  }

  /**
   * Whether an argument in a positional slot is the object of options
   * instead: a positional value is never an object written as `{ … }` (a
   * scene object, an axis or a plane is a class instance), so one there
   * means the positionals from that slot on are left out.
   */
  private opensOptions<A>(arg: A, reader: CallReader<A>): boolean {
    return this.options !== null && !reader.isAbsent(arg) && reader.optionEntries(arg) !== null;
  }

  /**
   * Named values laid out as arguments, and the operation as chains — none
   * for the default operation unless `explicit` asks for it. A value that
   * is `undefined` is left out: a trailing one is dropped, an option loses
   * its entry, and an object left with none is dropped. Positional ones
   * right before the object of options go too: the object reads as the
   * options from their slot on. A positional one that a later positional
   * or a rest element follows keeps its place: it writes what `placeholder`
   * gives for it, else `undefined`.
   */
  layout<T>(
    values: Readonly<Record<string, T | T[] | undefined>>,
    operation?: CallOperation<T>,
    options: CallLayoutOptions<T> = {},
  ): CallLayout<T> {
    const args: CallArgument<T>[] = [];
    for (const param of this.positional) {
      args.push({ kind: 'positional', param, value: values[param] });
    }
    if (this.options !== null) {
      const entries: { key: string; param: string; value: T | T[] }[] = [];
      for (const [key, param] of this.options) {
        if (values[param] !== undefined) {
          entries.push({ key, param, value: values[param]! });
        }
      }
      if (entries.length > 0) {
        args.push({ kind: 'options', entries });
      }
    }
    const restValue = this.rest === null ? undefined : values[this.rest];
    const rest = restValue === undefined ? [] : Array.isArray(restValue) ? restValue : [restValue];
    // Positionals left out right before the object of options go: the
    // object reads as the options from their slot on — `gear({ teeth: 24 })`,
    // not `gear(undefined, { teeth: 24 })`.
    const last = args[args.length - 1];
    if (last?.kind === 'options') {
      let first = args.length - 1;
      while (first > 0 && args[first - 1].kind === 'positional' && (args[first - 1] as { value: unknown }).value === undefined) {
        first--;
      }
      args.splice(first, args.length - 1 - first);
    }
    // Trailing positionals left out go, unless a rest element follows them:
    // dropping their places would hand the rest to the positionals.
    while (rest.length === 0 && args.length > 0) {
      const last = args[args.length - 1];
      if (last.kind !== 'positional' || last.value !== undefined) {
        break;
      }
      args.pop();
    }
    for (const arg of args) {
      if (arg.kind === 'positional' && arg.value === undefined) {
        arg.value = options.placeholder?.(arg.param);
      }
    }
    for (const element of rest) {
      args.push({ kind: 'rest', param: this.rest!, value: element });
    }
    return { args, chains: operation ? this.chainsFor(operation) : [] };
  }

  /**
   * Read a statement's chains, in order. The operation chains decide the
   * operation the way the statement runs them — the last one wins, and
   * resets any scope named before it; a statement without one applies the
   * default operation. A statement whose operation the feature doesn't
   * offer is refused.
   */
  readChains<A>(chains: readonly { method: string; args: readonly A[] }[]): ChainReading<A> {
    let operation: FeatureOperation = this.defaultOperation ?? 'add';
    let explicit = false;
    let scope: A[] | null = null;
    const foreign: number[] = [];
    for (let index = 0; index < chains.length; index++) {
      const chain = chains[index];
      if (this.operations.length === 0 || !FeatureCall.OPERATION_METHODS.has(chain.method)) {
        foreign.push(index);
      } else if (chain.method === 'scope') {
        scope = [...chain.args];
      } else {
        operation = chain.method as FeatureOperation;
        explicit = true;
        scope = null;
      }
    }
    if (this.operations.length > 0 && !this.operations.includes(operation)) {
      throw new CallShapeMismatch(`${this.callee}(): the statement uses .${operation}(), which its dialog doesn't offer — it offers ${FeatureCall.listed(this.operations)}`);
    }
    return { operation, explicit, scope, foreign };
  }

  /**
   * The chains that write `operation`: none for the default operation
   * (unless `explicit`), then `.scope(…)` when it names solids.
   */
  private chainsFor<T>(operation: CallOperation<T>): CallChain<T>[] {
    if (this.operations.length === 0) {
      throw new Error(`${this.callee}(): the feature declares no operations`);
    }
    if (!this.operations.includes(operation.operation)) {
      throw new Error(`${this.callee}(): the operation '${operation.operation}' is not one of ${FeatureCall.listed(this.operations)}`);
    }
    const chains: CallChain<T>[] = [];
    if (operation.operation !== this.defaultOperation || operation.explicit) {
      chains.push({ method: operation.operation, args: [] });
    }
    if (operation.scope && operation.scope.length > 0) {
      if (operation.operation === 'new') {
        throw new Error(`${this.callee}(): a new solid fuses with nothing, so it takes no scope`);
      }
      chains.push({ method: 'scope', args: [...operation.scope] });
    }
    return chains;
  }

  /** An object written as `{ … }`: neither a class instance (a scene object) nor a list. */
  static isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  private static describe(value: unknown): string {
    if (Array.isArray(value)) {
      return 'a list';
    }
    return value === null ? 'null' : `a ${typeof value}`;
  }

  /** `'add'`, `'add' and 'new'`, `'add', 'new' and 'remove'`. */
  static listed(names: readonly string[]): string {
    const quoted = names.map(name => `'${name}'`);
    return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted.join('');
  }
}
