import { isExpressionText } from './code-editor/index.ts';
import {
  findChainAt,
  getBaseCallName,
  getChainCalls,
  getInsertChainParser,
  type TSNode,
} from './insert-chain-edit.ts';
import {
  DEFAULT_CONFIGURATION_NAME,
  findInvalidParam,
  literalValueOf,
  renderKey,
  renderString,
  renderValue,
  stringLiteralText,
  type InsertParamValue,
} from './part-catalog/insert-edit.ts';

/**
 * The Edit-parameters dialog's payload — rides `ApplyFeatureEditSpec` as the
 * `insertParams` side-channel (like `instancePose`).
 */
export type InsertParamsEditSpec = {
  /** 1-based line of the insert() chain's base call (the record's sourceLocation). */
  line: number;
  /**
   * Labels the user CHANGED, merged into the insert()'s second argument.
   * Untouched entries are preserved byte-for-byte — an existing expression
   * like `Length: width - 160` survives unless that exact label was edited.
   */
  set: Record<string, InsertParamValue>;
  /**
   * Labels to REMOVE from the second argument — "reset to default": with the
   * entry gone, the `param()` declaration's own default applies again. The
   * whole argument drops when its last entry goes. Absent labels no-op.
   */
  unset?: string[];
};

/**
 * Merge parameter values into an `insert()` statement's second argument,
 * creating it when absent:
 *
 *     insert(extrusion)                        + {Length: 300}
 *       → insert(extrusion, { Length: 300 })
 *     insert(extrusion, { Size: '80x80' })     + {Length: 300}
 *       → insert(extrusion, { Size: '80x80', Length: 300 })
 *     insert(extrusion, { Length: w - 160 })   + {Length: 300}
 *       → insert(extrusion, { Length: 300 })
 *     insert(frame, 'Wide')                    + {Depth: 1000}
 *       → insert(frame, 'Wide', { Depth: 1000 })
 *
 * A string second argument names a `configurations()` row; the override
 * object is then the third argument and is edited in place there.
 * All-or-nothing: any refusal returns the original code untouched.
 */
export async function applyInsertParamsEdit(
  code: string,
  spec: InsertParamsEditSpec,
): Promise<{ newCode: string; error?: string }> {
  const entries = Object.entries(spec.set ?? {});
  const unset = spec.unset ?? [];
  if (entries.length === 0 && unset.length === 0) {
    return { newCode: code, error: 'No parameter changes in the request.' };
  }
  const bad = findInvalidParam(spec.set);
  if (bad) {
    return { newCode: code, error: `Parameter '${bad}' has an unsupported value.` };
  }
  const both = unset.find(label => label in (spec.set ?? {}));
  if (both !== undefined) {
    return { newCode: code, error: `Parameter '${both}' is both set and reset.` };
  }

  let out = code;
  for (const label of unset) {
    const result = await removeOne(out, spec.line, label);
    if (result.error) {
      return { newCode: code, error: result.error };
    }
    out = result.newCode;
  }
  for (const [label, value] of entries) {
    const result = await applyOne(out, spec.line, label, value);
    if (result.error) {
      return { newCode: code, error: result.error };
    }
    out = result.newCode;
  }
  return { newCode: out };
}

/** Remove `label`'s entry from the second argument; drop the argument when it empties. */
async function removeOne(
  code: string,
  line: number,
  label: string,
): Promise<{ newCode: string; error?: string }> {
  const located = await locateInsertArgs(code, line);
  if ('error' in located) {
    return { newCode: code, error: located.error };
  }
  const { anchor, overrides } = located;
  if (!overrides) {
    return { newCode: code };
  }
  if (overrides.type !== 'object') {
    return { newCode: code, error: nonLiteralOverrides(located, line) };
  }
  const props = overrides.namedChildren.filter(c => c.type !== 'comment');
  const index = props.findIndex(prop =>
    (prop.type === 'pair' && pairLabel(prop) === label)
    || (prop.type === 'shorthand_property_identifier' && prop.text === label));
  if (index === -1) {
    return { newCode: code };
  }
  if (props.length === 1) {
    // Last entry — the whole `, { … }` argument goes with it.
    return { newCode: splice(code, anchor.endIndex, overrides.endIndex, '') };
  }
  if (index === 0) {
    return { newCode: splice(code, props[0].startIndex, props[1].startIndex, '') };
  }
  return { newCode: splice(code, props[index - 1].endIndex, props[index].endIndex, '') };
}

/**
 * The insert() call's arguments at `line`, read by role: the definition,
 * the configuration name when the second argument is a string literal, and
 * the override object (second argument, or third behind a name). `anchor`
 * is the argument a created override object goes after. Or a refusal.
 */
type InsertArgs = {
  named: TSNode[];
  definition: TSNode;
  configuration: TSNode | null;
  overrides: TSNode | null;
  anchor: TSNode;
};

async function locateInsertArgs(code: string, line: number): Promise<InsertArgs | { error: string }> {
  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, line);
  if (!tail) {
    return { error: `no statement found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return { error: `the statement on line ${line} is not an insert().` };
  }
  const args = chain[0].childForFieldName('arguments');
  const named = args?.namedChildren.filter(c => c.type !== 'comment') ?? [];
  if (!args || named.length === 0) {
    return { error: `the insert() on line ${line} has no arguments.` };
  }
  const definition = named[0];
  const configuration = named[1]?.type === 'string' ? named[1] : null;
  const overrides = (configuration ? named[2] : named[1]) ?? null;
  return { named, definition, configuration, overrides, anchor: configuration ?? definition };
}

/** The refusal for an override argument that is no object literal. */
function nonLiteralOverrides(args: InsertArgs, line: number): string {
  const position = args.configuration ? 'third' : 'second';
  return `the insert() on line ${line} passes a non-literal ${position} argument — edit its parameters in code.`;
}

async function applyOne(
  code: string,
  line: number,
  label: string,
  value: InsertParamValue,
): Promise<{ newCode: string; error?: string }> {
  const located = await locateInsertArgs(code, line);
  if ('error' in located) {
    return { newCode: code, error: located.error };
  }
  const { anchor, overrides } = located;

  const rendered = `${renderKey(label)}: ${renderValue(value)}`;

  if (!overrides) {
    return { newCode: splice(code, anchor.endIndex, anchor.endIndex, `, { ${rendered} }`) };
  }

  if (overrides.type !== 'object') {
    return { newCode: code, error: nonLiteralOverrides(located, line) };
  }

  // Replace the matching property's VALUE only (`Length: w - 160` → the
  // value span), or the whole shorthand (`{ Length }` can't keep its form
  // once it stops referring to the variable).
  for (const prop of overrides.namedChildren) {
    if (prop.type === 'pair' && pairLabel(prop) === label) {
      const valueNode = prop.childForFieldName('value');
      if (!valueNode) {
        return { newCode: code, error: `could not read the existing '${label}' entry on line ${line}.` };
      }
      return { newCode: splice(code, valueNode.startIndex, valueNode.endIndex, renderValue(value)) };
    }
    if (prop.type === 'shorthand_property_identifier' && prop.text === label) {
      return { newCode: splice(code, prop.startIndex, prop.endIndex, rendered) };
    }
  }

  // Not present — append after the last property, or splice an empty {} open.
  const props = overrides.namedChildren.filter(c => c.type !== 'comment');
  const last = props[props.length - 1];
  if (last) {
    return { newCode: splice(code, last.endIndex, last.endIndex, `, ${rendered}`) };
  }
  return { newCode: splice(code, overrides.startIndex + 1, overrides.endIndex - 1, ` ${rendered} `) };
}

/**
 * The configuration an `insert()` statement names: `name` is the string
 * second argument's value, null when the statement inserts the literals.
 * A second argument that is neither a string nor an override object (a
 * variable holding the name, say) comes back as `expression` — the dialog
 * shows it read-only. Null when no insert() sits at `line`.
 */
export async function readInsertConfiguration(
  code: string,
  line: number,
): Promise<{ name: string | null; expression?: string } | null> {
  const located = await locateInsertArgs(code, line);
  if ('error' in located) {
    return null;
  }
  const { named, configuration } = located;
  if (configuration) {
    return { name: stringLiteralText(configuration) };
  }
  const second = named[1];
  if (second && second.type !== 'object') {
    return { name: null, expression: second.text };
  }
  return { name: null };
}

/**
 * Set, replace or clear the configuration name of the `insert()` at `line`:
 *
 *     insert(frame)                    + 'Wide'   → insert(frame, 'Wide')
 *     insert(frame, { Depth: 1000 })   + 'Wide'   → insert(frame, 'Wide', { Depth: 1000 })
 *     insert(frame, 'Wide', { … })     + 'Narrow' → insert(frame, 'Narrow', { … })
 *     insert(frame, 'Wide', { … })     + null     → insert(frame, { … })
 *
 * `null` and `'Default'` both clear the name — the literals need none. A
 * second argument that is neither a string nor an object literal cannot be
 * rewritten and is refused.
 */
export async function setInsertConfiguration(
  code: string,
  line: number,
  name: string | null,
): Promise<{ newCode: string; error?: string }> {
  if (name !== null && (typeof name !== 'string' || name.trim() === '')) {
    return { newCode: code, error: 'a configuration needs a name.' };
  }
  const wanted = name === null || name === DEFAULT_CONFIGURATION_NAME ? null : name;
  const located = await locateInsertArgs(code, line);
  if ('error' in located) {
    return { newCode: code, error: located.error };
  }
  const { named, definition, configuration } = located;
  if (configuration) {
    if (wanted === null) {
      return { newCode: splice(code, definition.endIndex, configuration.endIndex, '') };
    }
    return { newCode: splice(code, configuration.startIndex, configuration.endIndex, renderString(wanted)) };
  }
  const second = named[1];
  if (second && second.type !== 'object') {
    return {
      newCode: code,
      error: `the insert() on line ${line} passes a non-literal second argument — edit its configuration in code.`,
    };
  }
  if (wanted === null) {
    return { newCode: code };
  }
  return { newCode: splice(code, definition.endIndex, definition.endIndex, `, ${renderString(wanted)}`) };
}

/**
 * The exact source text of an `insert()` second argument's NON-LITERAL
 * entries — what the Edit-parameters dialog seeds its expression fields
 * with. Literal values (numbers, strings, booleans, arrays of those) are
 * omitted: the record's resolved values already cover them. Null when the
 * statement can't be addressed (no insert() at `line`, or a non-literal
 * second argument) — the dialog falls back to plain resolved values.
 */
export async function getInsertParamExpressions(
  code: string,
  line: number,
): Promise<Record<string, string> | null> {
  const located = await locateInsertArgs(code, line);
  if ('error' in located) {
    return null;
  }
  const { overrides } = located;
  if (!overrides) {
    return {};
  }
  if (overrides.type !== 'object') {
    return null;
  }
  const out: Record<string, string> = {};
  for (const prop of overrides.namedChildren) {
    if (prop.type === 'shorthand_property_identifier') {
      out[prop.text] = prop.text;
      continue;
    }
    if (prop.type !== 'pair') {
      continue;
    }
    const label = pairLabel(prop);
    const valueNode = prop.childForFieldName('value');
    if (label === null || !valueNode || literalValueOf(valueNode) !== undefined) {
      continue;
    }
    if (isExpressionText(valueNode.text)) {
      out[label] = valueNode.text;
    }
  }
  return out;
}

/** The label a `key: value` pair addresses — identifier text or unquoted string. */
function pairLabel(pair: TSNode): string | null {
  const key = pair.childForFieldName('key');
  if (!key) {
    return null;
  }
  if (key.type === 'property_identifier') {
    return key.text;
  }
  if (key.type === 'string') {
    return key.text.slice(1, -1).replace(/\\(['"\\])/g, '$1');
  }
  return null;
}

function splice(code: string, startIndex: number, endIndex: number, replacement: string): string {
  return code.slice(0, startIndex) + replacement + code.slice(endIndex);
}
