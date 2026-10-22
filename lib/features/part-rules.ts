/**
 * The two rules every `part()` follows, and the words both checks use: the
 * render refuses an offending definition with these messages (a build error
 * on its row, at its `part()` call), and the editor lint reports the same
 * text before the file is written.
 *
 * 1. **A part is exported.** `export const plate = part('Plate', …)` at the
 *    top level of its file — the binding is how an assembly imports it and
 *    how the part catalog lists it. A part nothing exports, a part exported
 *    only as `default`, and a `part()` declared inside another part's or
 *    assembly's body (which no export can reach) are refused. An exported
 *    function returning the definition (a factory) counts as exported.
 * 2. **A part's name is unique within its file.** The name is the part's
 *    identity: its parameters, session values and `configurations()` table
 *    are filed under it. The first `part()` of a name builds; a later one of
 *    the same name, from another call site of that file, is refused.
 */
export class PartRules {

  /** Rule 2: a later `part()` of a name another `part()` of the file already took. */
  static duplicateMessage(name: string): string {
    return `part '${name}': another part in this file is already named '${name}' — give each part its own name.`;
  }

  /** Rule 1: a `part()` its module does not export. `binding` defaults to {@link bindingFor}. */
  static unexportedMessage(name: string, binding: string = PartRules.bindingFor(name)): string {
    return `part '${name}': a part must be exported — write it as export const ${binding} = part('${name}', …) at the top level of the file.`;
  }

  /** Rule 1, for a `part()` that runs inside another body of its own file. */
  static nestedMessage(name: string, binding: string = PartRules.bindingFor(name)): string {
    return `part '${name}': a part must be exported, so it cannot be declared inside another part's or assembly's body — `
      + `move it to the top level of the file as export const ${binding} = part('${name}', …).`;
  }

  /**
   * The variable a part named `name` is suggested to be exported by: its
   * words camel-cased (`Backing plate` → `backingPlate`, `Part 2` →
   * `part2`). A name with no usable word, or one that would be a reserved
   * word or shadow the `part` import, gives `mainPart`.
   */
  static bindingFor(name: string): string {
    const words = name.split(/[^A-Za-z0-9_$]+/).filter(word => word.length > 0);
    const binding = words
      .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
      .join('');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding) || PartRules.RESERVED.has(binding)) {
      return 'mainPart';
    }
    return binding;
  }

  /** Words a binding cannot take: the language's reserved words and the wrappers a part file imports. */
  private static readonly RESERVED = new Set([
    'part', 'assembly',
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
    'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  ]);
}
