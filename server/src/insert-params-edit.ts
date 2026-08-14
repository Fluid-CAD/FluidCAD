import {
  findChainAt,
  getBaseCallName,
  getChainCalls,
  getInsertChainParser,
  type TSNode,
} from './insert-chain-edit.ts';
import {
  findInvalidParam,
  renderKey,
  renderValue,
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
 *
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
  const { named } = located;
  if (named.length < 2) {
    return { newCode: code };
  }
  const second = named[1];
  if (second.type !== 'object') {
    return {
      newCode: code,
      error: `the insert() on line ${line} passes a non-literal second argument — edit its parameters in code.`,
    };
  }
  const props = second.namedChildren.filter(c => c.type !== 'comment');
  const index = props.findIndex(prop =>
    (prop.type === 'pair' && pairLabel(prop) === label)
    || (prop.type === 'shorthand_property_identifier' && prop.text === label));
  if (index === -1) {
    return { newCode: code };
  }
  if (props.length === 1) {
    // Last entry — the whole `, { … }` argument goes with it.
    return { newCode: splice(code, named[0].endIndex, second.endIndex, '') };
  }
  if (index === 0) {
    return { newCode: splice(code, props[0].startIndex, props[1].startIndex, '') };
  }
  return { newCode: splice(code, props[index - 1].endIndex, props[index].endIndex, '') };
}

/** The insert() call's named arguments at `line`, or a refusal. */
async function locateInsertArgs(
  code: string,
  line: number,
): Promise<{ named: TSNode[] } | { error: string }> {
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
  return { named };
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
  const { named } = located;

  const rendered = `${renderKey(label)}: ${renderValue(value)}`;

  if (named.length === 1) {
    const first = named[0];
    return { newCode: splice(code, first.endIndex, first.endIndex, `, { ${rendered} }`) };
  }

  const second = named[1];
  if (second.type !== 'object') {
    return {
      newCode: code,
      error: `the insert() on line ${line} passes a non-literal second argument — edit its parameters in code.`,
    };
  }

  // Replace the matching property's VALUE only (`Length: w - 160` → the
  // value span), or the whole shorthand (`{ Length }` can't keep its form
  // once it stops referring to the variable).
  for (const prop of second.namedChildren) {
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
  const props = second.namedChildren.filter(c => c.type !== 'comment');
  const last = props[props.length - 1];
  if (last) {
    return { newCode: splice(code, last.endIndex, last.endIndex, `, ${rendered}`) };
  }
  return { newCode: splice(code, second.startIndex + 1, second.endIndex - 1, ` ${rendered} `) };
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
