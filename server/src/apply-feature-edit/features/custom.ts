// Custom features: the statement a feature's call shape lays out, written, read back and re-rendered.

import { dirname, resolve } from 'path';
import {
  ensureSymbolImport,
  getJavaScriptParser,
  importLocalName,
  namedImportBindings,
  type LexicalBindings,
  type TSNode,
} from '../../code-editor/index.ts';
import { relativeSpecifier } from '../../files/relative-specifier.ts';
import { normalizePath } from '../../normalize-path.ts';
import { CallShapeMismatch, FeatureCall } from '../../../../lib/dist/sdk/call-shape.js';
import type { CallArgument, CallOperation, CallReader, CallShape, FeatureOperation } from '../../../../lib/dist/sdk/call-shape.js';
import type { FeatureMetaSnapshot } from '../../../../lib/dist/index.js';
import { renderSolvedTarget, type SolvedEmissionTarget } from '../../../../lib/dist/selection/sketch-target.js';
import { connectorInstanceRead, resolveRepeatTargetRef, stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse, ParsedScopeChain } from '../parse/parsed-statement.ts';
import { isScopeTargetProducer, isSketchProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { validValueExpr, type ValueExpr } from '../value-expr.ts';
import type { RepeatEditTargetSource } from './repeat.ts';
import { TypedInKinds } from './typed-in-kinds.ts';

/**
 * One value of a custom feature, as its statement reads: typed in (its
 * type), or picked (its picker kind); a typed-in value's default is what a
 * call that leaves it out ahead of a later argument writes in its place.
 */
export type CustomParamKind = { type?: string; picker?: string | string[]; list: boolean; multiple?: boolean; default?: number | string | boolean | (string | number)[] };

/**
 * How a custom feature's statements are laid out — from the catalog's
 * snapshot of its metadata: the call shape, the operations its dialog
 * offers, and what kind each value is.
 */
export type CustomFeatureShape = {
  call: CallShape;
  operations: FeatureOperation[];
  params: Record<string, CustomParamKind>;
};

/** One element of a picked value, as the statement writes it. */
export type CustomPickSource =
  /**
   * A selector the picks synthesized, from the spec's `parts`
   * (`e.endFaces()`) — with the point taken on it for a location
   * (`e.endFaces().center()`, `e.endEdges(0).start()`).
   */
  | { kind: 'part'; part: number; suffix?: string }
  /** A picked edge as an axis: `axis(<selector>)`. */
  | { kind: 'axis'; part: number }
  /** A picked face or edge as a plane: `plane(<selector>)`. */
  | { kind: 'plane'; part: number }
  /**
   * A statement by its bound variable: a sketch, an axis or plane statement,
   * a solid, a feature, a connector — `instance` one of a connector's copies
   * (`bolt.instance(2)`).
   */
  | { kind: 'producer'; producer: number; instance?: number }
  /**
   * A point of a sketch, which the sketch must export before the statement
   * can name it: the sketch producer and the entity's point. The transform
   * authors the export first (see `CustomFeaturePoints`), turning it into an
   * `expression`.
   */
  | { kind: 'sketchPoint'; producer: number; target: SolvedEmissionTarget }
  /** A point expression an export just authored (`s.geometries.l1.start()`), written as it is. */
  | { kind: 'expression'; expression: string }
  /** A world axis or an origin plane, by name: `'z'`, `'xy'`. */
  | { kind: 'standard'; name: 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' }
  /** An edit's keep: one element of the statement's own value, as written. */
  | { kind: 'verbatim'; sourceIndex: number };

/**
 * What one value of the statement writes. A value with no entry is left
 * out of the call (the builder's default applies).
 */
export type CustomValueSource =
  /** A typed-in number, or an expression (`h * 2`), written as it reads. */
  | { kind: 'value'; value: ValueExpr }
  /** A string or a boolean, written as a literal. */
  | { kind: 'literal'; value: string | boolean }
  /** A multi-select's option values, written as one array literal — `['a']` for one, `[]` for none (never a pick list, which writes one element bare). */
  | { kind: 'list'; values: (string | number)[] }
  /** A picked value, one element per pick: a list takes several, a single value one. */
  | { kind: 'picks'; items: CustomPickSource[] }
  /** An edit's keep: the statement's own text for the value. */
  | { kind: 'keep' };

/**
 * A custom feature statement as a dialog writes it. A create carries where
 * the builder is imported from and its shape (the catalog's); an edit reads
 * both off the statement it rewrites.
 */
export type CustomFeatureOptions = {
  /** The feature's id — what the callee must build. */
  id: string;
  values: Record<string, CustomValueSource>;
  /**
   * The operation; absent applies the feature's default (an edit keeps the
   * statement's own). The default is written without a chain.
   */
  operation?: FeatureOperation;
  /**
   * The `.scope(…)` solids: bound feature producers, or (an edit) the
   * statement's own targets kept by position. Absent writes none (an edit
   * keeps the statement's chain); empty drops it.
   */
  scope?: RepeatEditTargetSource[];
  /** A create: the builder's export, and its module (absolute, or `fluidcad/core` for a built-in). */
  exportName?: string;
  modulePath?: string;
  /** A create: the catalog's shape of the feature's statements. */
  shape?: CustomFeatureShape;
};

/** One element of a picked value a statement writes: its text and where it sits. */
export type CustomPickText = {
  text: string;
  /** Character offsets of the text in the file. */
  start: number;
  end: number;
  /**
   * The statement a plain variable names (`s` bound to `sketch(…)`), as its
   * timeline row reports it — a connector copy's seed statement, with the
   * copy's `slot` (`bolt.instance(2)`).
   */
  ref?: { line: number; column: number; slot?: number };
};

/** A custom feature statement read back by its call shape. */
export type ParsedCustomFeature = ParsedScopeChain & {
  feature: 'custom';
  id: string;
  /** The callee as the statement writes it — an import alias included. */
  callee: string;
  /** The typed-in values the statement writes; one it leaves out is absent. */
  values: Record<string, ValueExpr | boolean | string | (string | number)[]>;
  /** The picked values it writes, element by element; one it leaves out is absent. */
  picks: Record<string, CustomPickText[]>;
  /** The operation the statement applies: its operation chain's, else the feature's default. */
  operation: FeatureOperation;
  /**
   * Whether an operation chain spells the operation out (`.remove()` on a
   * feature that removes anyway) rather than leaving it to the default; an
   * edit that leaves the operation alone keeps it spelled out.
   */
  operationWritten: boolean;
  /** Each value's own text, as written — a rest value's, argument by argument. */
  texts: Record<string, string | string[]>;
  shape: CustomFeatureShape;
};

/** The world axes and origin planes a picked axis or plane may name. */
const STANDARD_NAMES = new Set(['x', 'y', 'z', 'xy', 'xz', 'yz']);

/** The point a location takes on a selector: `.center()`, `.start()`, `.end()`, `.offset('relative', 0.5)`. */
const POINT_SUFFIX = /^\.(?:center|start|end)\(\)$|^\.offset\('(?:relative|absolute)', -?\d+(?:\.\d+)?(?:e-?\d+)?\)$/;

/** The methods a feature with operations owns on its statement. */
const OPERATION_METHODS = new Set(['add', 'new', 'remove', 'scope']);

/**
 * Reading a custom feature's statement as syntax: an argument left out is
 * `undefined` (or `null`, which the builder treats alike), and the object
 * of options is an object literal of plain keys — anything a dialog could
 * not write back (a spread, a computed key, a method) is not editable.
 */
const SYNTAX_READER: CallReader<TSNode> = {
  isAbsent: node => node.type === 'undefined' || node.type === 'null',
  optionEntries: node => {
    if (node.type !== 'object') {
      return null;
    }
    const entries: [string, TSNode][] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'comment') {
        continue;
      }
      if (child.type === 'shorthand_property_identifier') {
        entries.push([child.text, child]);
        continue;
      }
      const key = child.type === 'pair' ? child.childForFieldName('key') : null;
      const value = child.type === 'pair' ? child.childForFieldName('value') : null;
      const name = key?.type === 'property_identifier' ? key.text : key?.type === 'string' ? stringArgValue(key) : null;
      if (!value || name === null) {
        throw new CallShapeMismatch(`the object of options holds \`${child.text}\`, which the dialog cannot write back`);
      }
      entries.push([name, value]);
    }
    return entries;
  },
};

/**
 * A custom feature's statement: written from a dialog's values through the
 * feature's call shape, read back by the same shape, and re-rendered for an
 * edit with the values it keeps. The operation chains (`.new()`,
 * `.remove()`, `.scope(…)`) are the dialog's when the feature declares
 * operations — none for the feature's default operation, unless the
 * statement already spells it out; every other chain is the user's and
 * survives an edit as written.
 */
export class CustomFeatureStatement {

  /** The shape of a feature's statements, from its metadata snapshot. */
  static shapeOf(meta: Pick<FeatureMetaSnapshot, 'call' | 'operations' | 'params'>): CustomFeatureShape {
    const params: Record<string, CustomParamKind> = {};
    for (const [name, spec] of Object.entries(meta.params ?? {})) {
      const declared = spec as { type?: string; picker?: string | string[]; multiple?: boolean; max?: number; default?: unknown };
      if ('picker' in declared && declared.picker) {
        const picker = Array.isArray(declared.picker) ? [...declared.picker] : declared.picker;
        params[name] = { picker, list: declared.multiple === true || declared.max !== undefined };
        continue;
      }
      const fallback = TypedInKinds.defaultOf(declared.default);
      const multiple = declared.type === 'select' && declared.multiple === true ? { multiple: true } : {};
      params[name] = fallback !== undefined
        ? { type: declared.type, list: false, ...multiple, default: fallback }
        : { type: declared.type, list: false, ...multiple };
    }
    return { call: meta.call, operations: [...(meta.operations ?? [])], params };
  }

  /** The create spec's own refusal, or null when it can render. */
  static createError(spec: ApplyFeatureEditSpec): string | null {
    const custom = spec.custom;
    if (!custom || typeof custom.id !== 'string' || !custom.id
      || typeof custom.exportName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(custom.exportName)
      || typeof custom.modulePath !== 'string' || !custom.modulePath || !custom.shape) {
      return 'malformed custom feature spec';
    }
    const call = CustomFeatureStatement.callFor(custom.shape, custom.exportName);
    if (typeof call === 'string') {
      return call;
    }
    const sources = CustomFeatureStatement.sourcesError(spec, custom, call, null);
    if (sources) {
      return sources;
    }
    if ((custom.scope ?? []).some(target => target?.kind !== 'feature')) {
      return 'malformed custom feature spec: a new statement has no scope of its own to keep';
    }
    // Every selector part belongs to exactly one picked element.
    const owned = Object.values(custom.values).flatMap(source => source?.kind === 'picks'
      ? source.items.flatMap(item => item.kind === 'part' || item.kind === 'axis' || item.kind === 'plane' ? [item.part] : [])
      : []);
    if (owned.length !== spec.parts.length || new Set(owned).size !== owned.length) {
      return 'malformed custom feature spec: every selector part belongs to one picked value';
    }
    return null;
  }

  /** Every picked element of a spec's custom feature — a create's, or an edit's. */
  static picksOf(spec: Pick<ApplyFeatureEditSpec, 'custom' | 'edit'>): CustomPickSource[] {
    const custom = spec.edit ? spec.edit.custom : spec.custom;
    return Object.values(custom?.values ?? {}).flatMap(source => source?.kind === 'picks' && Array.isArray(source.items) ? source.items : []);
  }

  /**
   * Render the statement `options` describe. A create passes no `parsed`;
   * an edit passes the statement it rewrites, whose own texts the keeps
   * read and whose shape lays the call out.
   */
  static render(
    callee: string,
    options: CustomFeatureOptions,
    spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
    varFor: (producer: number) => string | null,
    parsed: ParsedCustomFeature | null = null,
  ): { statement: string } | { error: string } {
    const shape = parsed?.shape ?? options.shape;
    if (!shape) {
      return { error: 'malformed custom feature spec: no call shape' };
    }
    const call = CustomFeatureStatement.callFor(shape, callee);
    if (typeof call === 'string') {
      return { error: call };
    }
    const sources = CustomFeatureStatement.sourcesError(spec as ApplyFeatureEditSpec, options, call, parsed);
    if (sources) {
      return { error: sources };
    }

    const values: Record<string, string | string[] | undefined> = {};
    for (const param of call.params()) {
      const source = options.values[param];
      if (source === undefined) {
        continue;
      }
      if (source.kind === 'keep') {
        values[param] = parsed?.texts[param];
      } else if (source.kind === 'value' || source.kind === 'literal' || source.kind === 'list') {
        const type = shape.params[param]?.type;
        if (!TypedInKinds.of(type)) {
          return { error: `'${param}' ${TypedInKinds.unknown(type)}` };
        }
        values[param] = TypedInKinds.text(source);
      } else {
        const elements: string[] = [];
        for (const item of source.items) {
          const text = CustomFeatureStatement.renderPick(item, spec, varFor, parsed?.picks[param] ?? []);
          if (text === null) {
            return { error: `the statement's own '${param}' no longer holds the element the dialog kept — re-open it to edit the current code` };
          }
          elements.push(text);
        }
        const list = shape.params[param]?.list === true || param === call.rest;
        if (!list && elements.length > 1) {
          return { error: `'${param}' takes one pick, got ${elements.length}` };
        }
        if (elements.length > 0) {
          values[param] = list ? elements : elements[0];
        }
      }
    }

    let operation: CallOperation<string> | undefined;
    if (shape.operations.length > 0) {
      const scope = CustomFeatureStatement.scopeExprs(spec as ApplyFeatureEditSpec, options.scope, parsed, varFor);
      if ('error' in scope) {
        return scope;
      }
      // A statement with no operation chain applies the feature's default,
      // which is written without one; an edit that leaves the operation
      // alone keeps a chain the statement spelled it out with.
      const keepsOperation = parsed !== null && (options.operation === undefined || options.operation === parsed.operation);
      operation = {
        operation: options.operation ?? parsed?.operation ?? call.defaultOperation!,
        scope: scope.exprs,
        explicit: keepsOperation && parsed.operationWritten,
      };
    }

    let layout;
    try {
      // A value left out ahead of a later argument writes its default rather
      // than `undefined`: `draft(5, e.sideFaces())`.
      layout = call.layout<string>(values, operation, {
        placeholder: param => TypedInKinds.defaultText(shape.params[param]?.default),
      });
    } catch (error) {
      return { error: (error as Error).message };
    }
    const args = layout.args.map(arg => CustomFeatureStatement.renderArgument(arg));
    const chains = layout.chains.map(chain => `.${chain.method}(${chain.args.join(', ')})`).join('');
    return { statement: `${callee}(${args.join(', ')})${chains}` };
  }

  /**
   * Read a call to a custom feature (the chain decomposed) by its call
   * shape: the typed-in values, the picked ones as written, the operation
   * chains. A call the shape doesn't fit is not editable in the dialog.
   */
  static parse(
    chain: { root: ChainSegment; members: ChainSegment[] },
    call: TSNode,
    bindings: LexicalBindings,
    feature: { id: string; shape: CustomFeatureShape },
  ): ChainParse {
    const callee = chain.root.name;
    const shape = feature.shape;
    const featureCall = CustomFeatureStatement.callFor(shape, callee);
    if (typeof featureCall === 'string') {
      return { error: featureCall };
    }
    // The operation chains form a prefix of the member chain, as every
    // dialog's recognized options do: one hiding behind a call the dialog
    // doesn't write would leave the dialog lying about the statement.
    const owned: ChainSegment[] = [];
    let end = chain.root.endIndex;
    let stopped = false;
    for (const member of chain.members) {
      const isOperation = shape.operations.length > 0 && OPERATION_METHODS.has(member.name);
      if (!stopped && isOperation) {
        owned.push(member);
        end = member.endIndex;
        continue;
      }
      stopped = true;
      if (isOperation) {
        return { error: `a .${member.name}() chain follows other calls the dialog cannot edit — edit the statement in the source instead` };
      }
    }
    const notEditable = (reason: string) => ({ error: `${reason} — not editable in the dialog; edit the statement in the source` });
    const spread = chain.root.args.find(arg => arg.type === 'spread_element');
    if (spread) {
      return notEditable(`${callee}() spreads \`${spread.text}\` into its arguments`);
    }

    let read: Record<string, TSNode | TSNode[]>;
    let reading;
    try {
      read = featureCall.read(chain.root.args, SYNTAX_READER);
      reading = featureCall.readChains(owned.map(member => ({ method: member.name, args: member.args })));
    } catch (error) {
      if (error instanceof CallShapeMismatch) {
        return notEditable(error.message);
      }
      throw error;
    }

    const start = call.startIndex;
    const values: ParsedCustomFeature['values'] = {};
    const picks: ParsedCustomFeature['picks'] = {};
    const texts: ParsedCustomFeature['texts'] = {};
    for (const param of featureCall.params()) {
      const node = read[param];
      const kind = shape.params[param] ?? { list: false };
      if (node === undefined) {
        continue;
      }
      if (Array.isArray(node)) {
        // The rest value: each argument is one element.
        if (node.length > 0) {
          texts[param] = node.map(arg => arg.text);
          picks[param] = node.map(arg => CustomFeatureStatement.pickText(arg, start));
        }
        continue;
      }
      texts[param] = node.text;
      if (kind.picker) {
        const elements = kind.list && node.type === 'array'
          ? node.namedChildren.filter(child => child.type !== 'comment')
          : [node];
        if (elements.some(element => element.type === 'spread_element')) {
          return notEditable(`'${param}' spreads a list into its elements`);
        }
        picks[param] = elements.map(element => CustomFeatureStatement.pickText(element, start));
        continue;
      }
      const typedIn = TypedInKinds.of(kind.type, kind.multiple);
      if (!typedIn) {
        return notEditable(`${callee}()'s '${param}' ${TypedInKinds.unknown(kind.type)}`);
      }
      const value = typedIn.read(node, bindings);
      if (value === null) {
        return notEditable(`${callee}()'s '${param}' is not a plain ${typedIn.name}`);
      }
      values[param] = value;
    }

    const scopeNodes = reading.scope ?? [];
    return {
      parsed: {
        feature: 'custom',
        id: feature.id,
        callee,
        values,
        picks,
        operation: reading.operation,
        operationWritten: reading.explicit,
        scopeTexts: scopeNodes.map(node => node.text),
        scopeRefs: scopeNodes.map(node => resolveRepeatTargetRef(node, start)),
        texts,
        shape,
      },
      start,
      end,
    };
  }

  /** The feature's call, or the reason its shape can't lay one out. */
  private static callFor(shape: CustomFeatureShape, callee: string): FeatureCall | string {
    try {
      return new FeatureCall(shape.call, shape.operations, callee);
    } catch (error) {
      return `the feature's call shape is malformed: ${(error as Error).message}`;
    }
  }

  /** Whether every value source fits the feature and the spec, or what doesn't. */
  private static sourcesError(
    spec: ApplyFeatureEditSpec,
    options: CustomFeatureOptions,
    call: FeatureCall,
    parsed: ParsedCustomFeature | null,
  ): string | null {
    if (!options.values || typeof options.values !== 'object') {
      return 'malformed custom feature spec';
    }
    const params = new Set(call.params());
    for (const [param, source] of Object.entries(options.values)) {
      if (!params.has(param)) {
        return `malformed custom feature spec: '${param}' is not one of the feature's values`;
      }
      const valid = source?.kind === 'value' ? validValueExpr(source.value)
        : source?.kind === 'literal' ? typeof source.value === 'string' || typeof source.value === 'boolean'
        : source?.kind === 'list' ? Array.isArray(source.values)
          && source.values.every(value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
          : source?.kind === 'keep' ? parsed !== null
            : source?.kind === 'picks' && Array.isArray(source.items)
              && source.items.every(item => CustomFeatureStatement.validPick(item, spec, parsed !== null));
      if (!valid) {
        return `malformed custom feature spec: the value of '${param}'`;
      }
    }
    if (options.operation !== undefined && !call.operations.includes(options.operation)) {
      return `malformed custom feature spec: the operation '${options.operation}' is not one the feature offers`;
    }
    return null;
  }

  private static validPick(item: CustomPickSource, spec: ApplyFeatureEditSpec, editing: boolean): boolean {
    switch (item?.kind) {
      case 'part':
        return Number.isInteger(item.part) && item.part >= 0 && item.part < spec.parts.length
          && (item.suffix === undefined || (typeof item.suffix === 'string' && POINT_SUFFIX.test(item.suffix)));
      case 'axis':
      case 'plane':
        return Number.isInteger(item.part) && item.part >= 0 && item.part < spec.parts.length;
      case 'producer':
        return Number.isInteger(item.producer) && item.producer >= 0 && item.producer < spec.producers.length
          && spec.producers[item.producer].bind
          && (item.instance === undefined || (Number.isSafeInteger(item.instance) && item.instance >= 0
            && spec.producers[item.producer].featureType === 'connector'));
      case 'sketchPoint':
        return isSketchProducer(spec, item.producer) && !!item.target && typeof item.target === 'object';
      case 'expression':
        return typeof item.expression === 'string' && item.expression.length > 0 && item.expression.length <= 400;
      case 'standard':
        return STANDARD_NAMES.has(item.name);
      case 'verbatim':
        return editing && Number.isInteger(item.sourceIndex) && item.sourceIndex >= 0;
      default:
        return false;
    }
  }

  /** One picked element as written; null for a kept element the statement no longer holds. */
  private static renderPick(
    item: CustomPickSource,
    spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
    varFor: (producer: number) => string | null,
    own: CustomPickText[],
  ): string | null {
    if (item.kind === 'verbatim') {
      return own[item.sourceIndex]?.text ?? null;
    }
    if (item.kind === 'standard') {
      return `'${item.name}'`;
    }
    if (item.kind === 'producer') {
      const name = varFor(item.producer) ?? spec.producers[item.producer].nameHint ?? 'f';
      return item.instance === undefined ? name : `${name}.instance(${item.instance})`;
    }
    if (item.kind === 'expression') {
      return item.expression;
    }
    if (item.kind === 'sketchPoint') {
      // Authored by CustomFeaturePoints before the statement renders; a
      // preview that skipped the staging names the point the way it will.
      const sketch = varFor(item.producer) ?? spec.producers[item.producer].nameHint ?? 's';
      return renderSolvedTarget(item.target, () => `${sketch}.geometries.point`);
    }
    const part = spec.parts[item.part];
    const selector = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
    return item.kind === 'part' ? `${selector}${item.suffix ?? ''}` : `${item.kind}(${selector})`;
  }

  /** The `.scope(…)` expressions: absent keeps the statement's own, entries render by producer or position. */
  private static scopeExprs(
    spec: ApplyFeatureEditSpec,
    scope: RepeatEditTargetSource[] | undefined,
    parsed: ParsedCustomFeature | null,
    varFor: (producer: number) => string | null,
  ): { exprs: string[] } | { error: string } {
    if (scope === undefined) {
      return { exprs: parsed?.scopeTexts ?? [] };
    }
    if (!Array.isArray(scope)) {
      return { error: 'malformed custom feature spec: the scope' };
    }
    const exprs: string[] = [];
    for (const target of scope) {
      if (target?.kind === 'verbatim') {
        const text = parsed?.scopeTexts[target.sourceIndex];
        if (text === undefined) {
          return { error: 'malformed custom feature spec: a kept scope target no longer matches the statement' };
        }
        exprs.push(text);
      } else if (target?.kind === 'feature' && isScopeTargetProducer(spec, target.producer)) {
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed custom feature spec: a scope target is not a bound solid' };
      }
    }
    return { exprs };
  }

  private static renderArgument(arg: CallArgument<string>): string {
    if (arg.kind === 'options') {
      return `{ ${arg.entries.map(entry => `${entry.key}: ${CustomFeatureStatement.renderList(entry.value)}`).join(', ')} }`;
    }
    if (arg.kind === 'rest') {
      return arg.value;
    }
    return arg.value === undefined ? 'undefined' : CustomFeatureStatement.renderList(arg.value);
  }

  /** A value: as written, or a list of elements — one element bare (a builder takes it as a list of one). */
  private static renderList(value: string | string[]): string {
    if (!Array.isArray(value)) {
      return value;
    }
    return value.length === 1 ? value[0] : `[${value.join(', ')}]`;
  }

  private static pickText(node: TSNode, statementStart: number): CustomPickText {
    const copy = connectorInstanceRead(node);
    const seed = copy ? resolveRepeatTargetRef(copy.variable, statementStart) : null;
    const ref = seed ? { ...seed, slot: copy!.slot } : resolveRepeatTargetRef(node, statementStart);
    return { text: node.text, start: node.startIndex, end: node.endIndex, ...(ref ? { ref } : {}) };
  }
}

/**
 * The name a create calls a custom feature's builder by, and the import
 * that brings it in: an import of the file that already reads the
 * builder's module wins whatever it spells the path or the name, else the
 * builder is imported under its export name — or a fresh one when the file
 * already binds that.
 */
export class CustomFeatureImport {
  private constructor(
    /** The name the statement calls. */
    readonly local: string,
    private readonly specifier: string | null,
    private readonly exportName: string,
  ) {}

  static async plan(code: string, filePath: string, exportName: string, modulePath: string): Promise<CustomFeatureImport> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const target = CustomFeatureImport.isBuiltIn(modulePath) ? 'fluidcad/core' : normalizePath(modulePath);
    for (const [local, binding] of namedImportBindings(tree)) {
      if (binding.imported === exportName && CustomFeatureImport.moduleOf(binding.source, filePath) === target) {
        return new CustomFeatureImport(local, null, exportName);
      }
    }
    const specifier = CustomFeatureImport.isBuiltIn(modulePath) ? 'fluidcad/core' : relativeSpecifier(filePath, modulePath);
    return new CustomFeatureImport(await importLocalName(code, exportName, specifier), specifier, exportName);
  }

  /** `code` with the import the statement needs; unchanged when the file had it already. */
  async ensure(code: string): Promise<string> {
    if (this.specifier === null) {
      return code;
    }
    return ensureSymbolImport(code, this.exportName, this.specifier, this.local);
  }

  private static isBuiltIn(module: string): boolean {
    return module === 'fluidcad/core' || module === 'fluidcad';
  }

  /** The module an import specifier names from `filePath`: a relative one resolved, a built-in by its name. */
  private static moduleOf(source: string, filePath: string): string | null {
    if (CustomFeatureImport.isBuiltIn(source)) {
      return 'fluidcad/core';
    }
    if (!source.startsWith('./') && !source.startsWith('../')) {
      return null;
    }
    return normalizePath(resolve(dirname(normalizePath(filePath)), source));
  }
}
