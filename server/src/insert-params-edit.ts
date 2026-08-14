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
  if (entries.length === 0) {
    return { newCode: code, error: 'No parameter changes in the request.' };
  }
  const bad = findInvalidParam(spec.set);
  if (bad) {
    return { newCode: code, error: `Parameter '${bad}' has an unsupported value.` };
  }

  let out = code;
  for (const [label, value] of entries) {
    const result = await applyOne(out, spec.line, label, value);
    if (result.error) {
      return { newCode: code, error: result.error };
    }
    out = result.newCode;
  }
  return { newCode: out };
}

async function applyOne(
  code: string,
  line: number,
  label: string,
  value: InsertParamValue,
): Promise<{ newCode: string; error?: string }> {
  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, line);
  if (!tail) {
    return { newCode: code, error: `no statement found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return { newCode: code, error: `the statement on line ${line} is not an insert().` };
  }
  const args = chain[0].childForFieldName('arguments');
  const named = args?.namedChildren.filter(c => c.type !== 'comment') ?? [];
  if (!args || named.length === 0) {
    return { newCode: code, error: `the insert() on line ${line} has no arguments.` };
  }

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
