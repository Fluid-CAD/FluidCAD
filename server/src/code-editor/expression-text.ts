// Whether dialog text is a safe standalone expression (a number, an identifier, arithmetic over them).

/**
 * Whether `text` is safe to embed as a single call argument: one line, no
 * statement separators or comments, balanced brackets, and no top-level
 * comma or assignment that would change the argument list's shape.
 */
export function isExpressionText(text: unknown): text is string {
  if (typeof text !== 'string') {
    return false;
  }
  const t = text.trim();
  if (!t || t.length > 200 || /[;\r\n`]/.test(t) || t.includes('//') || t.includes('/*')) {
    return false;
  }
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if ((ch === ')' && open !== '(') || (ch === ']' && open !== '[') || (ch === '}' && open !== '{')) {
        return false;
      }
    } else if (stack.length === 0) {
      if (ch === ',') {
        return false;
      }
      // A top-level assignment would leak a statement into the argument;
      // comparison (`==`, `<=`, `>=`, `!=`) and arrows are fine.
      if (ch === '=' && t[i + 1] !== '=' && t[i + 1] !== '>' && !/[=!<>]/.test(t[i - 1] ?? '')) {
        return false;
      }
    }
  }
  return quote === null && stack.length === 0;
}
