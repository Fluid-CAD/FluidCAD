/** The font a format code names. */
export type MTextFont = { family: string; bold: boolean; italic: boolean };

/** What an `MTEXT`'s content comes to: its lines, and the one way all of it is written. */
export type MTextContent = {
  lines: string[];
  /** The font a `\f` names for the whole text; absent when the text keeps its style's. */
  font?: MTextFont;
  /** The height a `\H` sets for the whole text; absent when it keeps the entity's. */
  height?: number;
  /** A multiple of the height (the entity's, or `height`) that a `\H…x` sets for the whole text; 1 when none does. */
  heightFactor: number;
  /** A width factor (`\W`) or a slant (`\Q`) is in force somewhere in the text. */
  distorted: boolean;
  /** The text is not written one way throughout, or uses what a line of plain text has no place for. */
  mixed: boolean;
};

/** How a run of the text is written: what a format code may change. */
type Format = { font: MTextFont | null; height: number | null; factor: number; tracking: number };

/** The characters `%%c`, `%%d` and `%%p` stand for. */
const PERCENT_CODES: Record<string, string> = { c: 'Ø', d: '°', p: '±' };

/**
 * The content of a DXF `MTEXT` — plain text with format codes in it — as
 * the lines it draws.
 *
 * A sketch text is written one way from its first letter to its last, so
 * that is what is read: `\P` and `^J` break a line, `\~` is a space that
 * does not break, `\\`, `\{` and `\}` are those characters, `%%c`, `%%d`
 * and `%%p` are Ø, ° and ±, `\U+00B5` is the character of that number.
 * A font (`\f…;`) or a height (`\H…;`) that every letter is under is the
 * whole text's. Underline, overline and strike-through (`\L`, `\O`, `\K`)
 * and colours (`\C`, `\c`) change no letter and are dropped.
 *
 * What a plain text cannot say is noted instead: a width factor or a slant
 * (`distorted`); a font, height or letter spacing that changes part-way, a
 * stacked fraction (`\S`), a tab, a column break, or a paragraph with its
 * own indent or alignment (`mixed`).
 */
export class DxfMText {
  static parse(content: string): MTextContent {
    const lines: string[] = [''];
    /** Each way a letter is written, by a key that is the same for the same way. */
    const used = new Map<string, Format>();
    const stack: Format[] = [];
    let format: Format = { font: null, height: null, factor: 1, tracking: 1 };
    let distorted = false;
    let mixed = false;

    const put = (text: string) => {
      lines[lines.length - 1] += text;
      if (text.trim() !== '') {
        const font = format.font ? `${format.font.family.toLowerCase()}/${format.font.bold}/${format.font.italic}` : '';
        used.set(`${font}|${format.height}|${format.factor}|${format.tracking}`, format);
      }
    };
    /** The argument of a code that runs to the next semicolon, and where the text goes on. */
    const argument = (from: number): [string, number] => {
      const end = content.indexOf(';', from);
      return end < 0 ? [content.slice(from), content.length] : [content.slice(from, end), end + 1];
    };
    /** A number that may end in `x`: a multiple. */
    const factor = (text: string): number => Number(text.trim().replace(/x$/i, ''));

    let i = 0;
    while (i < content.length) {
      const char = content[i];
      if (char === '{') {
        stack.push(format);
        i++;
        continue;
      }
      if (char === '}') {
        format = stack.pop() ?? format;
        i++;
        continue;
      }
      if (char === '^' && i + 1 < content.length) {
        // A caret and a letter is a control character: J a new line, I a tab, M nothing.
        const control = content[i + 1];
        if (control === 'J') {
          lines.push('');
        } else if (control === 'I') {
          mixed = true;
          put(' ');
        } else if (control === ' ') {
          put('^');
        } else if (control !== 'M') {
          put(`^${control}`);
        }
        i += 2;
        continue;
      }
      if (char === '%' && content[i + 1] === '%') {
        const read = DxfMText.percentCode(content, i);
        put(read.text);
        i = read.next;
        continue;
      }
      if (char !== '\\' || i + 1 >= content.length) {
        put(char);
        i++;
        continue;
      }
      const code = content[i + 1];
      i += 2;
      switch (code) {
        case '\\':
        case '{':
        case '}':
          put(code);
          break;
        case 'P':
          lines.push('');
          break;
        case '~':
          put(' ');
          break;
        case 'N':
        case 'X':
          // A column break, or the split of a dimension's text: no place in one run of lines.
          mixed = true;
          lines.push('');
          break;
        case 'L':
        case 'l':
        case 'O':
        case 'o':
        case 'K':
        case 'k':
          break;
        case 'U': {
          const hex = /^\+([0-9A-Fa-f]{4})/.exec(content.slice(i, i + 5));
          if (hex) {
            put(String.fromCharCode(parseInt(hex[1], 16)));
            i += 5;
          } else {
            put('\\U');
          }
          break;
        }
        case 'f':
        case 'F': {
          const [text, next] = argument(i);
          i = next;
          const parts = text.split('|').map((part) => part.trim());
          format = {
            ...format,
            font: { family: parts[0], bold: parts.some((part) => /^b1$/i.test(part)), italic: parts.some((part) => /^i1$/i.test(part)) },
          };
          break;
        }
        case 'H': {
          const [text, next] = argument(i);
          i = next;
          const value = factor(text);
          if (Number.isFinite(value) && value > 0) {
            // `2.5x` multiplies the height in force; a bare number is a height.
            format = /x$/i.test(text.trim())
              ? { ...format, factor: format.factor * value }
              : { ...format, height: value, factor: 1 };
          }
          break;
        }
        case 'W': {
          const [text, next] = argument(i);
          i = next;
          const value = factor(text);
          if (Number.isFinite(value) && Math.abs(value - 1) > 1e-9) {
            distorted = true;
          }
          break;
        }
        case 'Q': {
          const [text, next] = argument(i);
          i = next;
          if (Math.abs(Number(text.trim())) > 1e-9) {
            distorted = true;
          }
          break;
        }
        case 'T': {
          const [text, next] = argument(i);
          i = next;
          const value = factor(text);
          if (Number.isFinite(value)) {
            format = { ...format, tracking: value };
          }
          break;
        }
        case 'S': {
          const [, next] = argument(i);
          i = next;
          mixed = true;
          break;
        }
        case 'p': {
          const [text, next] = argument(i);
          i = next;
          // Indents (i, l, r), tab stops (t) and an alignment of its own (q…): `xq*` alone resets them.
          for (const setting of text.replace(/^x/i, '').split(',').map((part) => part.trim())) {
            const indent = /^[ilr](-?[\d.]+)$/i.exec(setting);
            if (setting !== '' && !(indent && Number(indent[1]) === 0) && !/^q[l*]$/i.test(setting)) {
              mixed = true;
            }
          }
          break;
        }
        case 'A':
        case 'C':
        case 'c': {
          const [, next] = argument(i);
          i = next;
          break;
        }
        default:
          // Not a code this knows: the characters themselves.
          put(`\\${code}`);
      }
    }

    // The one way the letters are written decides the font and the height.
    const [only] = [...used.values()];
    if (used.size > 1 || (only && only.tracking !== 1)) {
      mixed = true;
    }
    // Lines are drawn without the spaces a paragraph ends with.
    const trimmed = lines.map((line) => line.replace(/\s+$/, ''));
    while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') {
      trimmed.pop();
    }
    return {
      lines: trimmed,
      ...(only?.font ? { font: only.font } : {}),
      ...(only && only.height !== null ? { height: only.height } : {}),
      heightFactor: only?.factor ?? 1,
      distorted,
      mixed,
    };
  }

  /**
   * A string of a `TEXT`, which has `%%` codes and `\U+XXXX` and nothing
   * else: the characters it draws. `%%u`, `%%o` and `%%k` switch an
   * underline, an overline or a strike-through, which change no letter.
   */
  static plain(content: string): string {
    let out = '';
    let i = 0;
    while (i < content.length) {
      if (content[i] === '%' && content[i + 1] === '%') {
        const read = DxfMText.percentCode(content, i);
        out += read.text;
        i = read.next;
        continue;
      }
      const hex = /^\\U\+([0-9A-Fa-f]{4})/.exec(content.slice(i, i + 7));
      if (hex) {
        out += String.fromCharCode(parseInt(hex[1], 16));
        i += 7;
        continue;
      }
      out += content[i];
      i++;
    }
    return out;
  }

  /** The `%%` code at `at`: what it draws, and where the text goes on. */
  private static percentCode(content: string, at: number): { text: string; next: number } {
    const next = content[at + 2] ?? '';
    const special = PERCENT_CODES[next.toLowerCase()];
    if (special !== undefined) {
      return { text: special, next: at + 3 };
    }
    if (/[uok]/i.test(next)) {
      return { text: '', next: at + 3 };
    }
    if (next === '%') {
      return { text: '%', next: at + 3 };
    }
    const digits = /^\d{3}/.exec(content.slice(at + 2, at + 5));
    if (digits) {
      return { text: String.fromCharCode(Number(digits[0])), next: at + 5 };
    }
    return { text: '%%', next: at + 2 };
  }
}
