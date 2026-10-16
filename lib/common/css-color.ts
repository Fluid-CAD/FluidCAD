import cssColorNames from "color-name";

/**
 * The one place a colour value is normalised. Colours reach the lib as CSS
 * names (`"red"`) or hex (`"#FF0000"`, `"#f00"`); everything that stores or
 * compares one — the `color()` statement, the face-colour records, export —
 * goes through `toHex` so that two spellings of one colour never read as two
 * colours.
 */
export class CssColor {
  /**
   * Lowercase `#rrggbb` for a CSS colour name or a hex value (short `#rgb`
   * is expanded). Anything else is returned as given — the caller decides
   * whether an unknown spelling is an error.
   */
  static toHex(color: string): string {
    const trimmed = color.trim();
    if (trimmed.startsWith('#')) {
      return CssColor.expandHex(trimmed.toLowerCase());
    }
    const rgb = cssColorNames[trimmed.toLowerCase() as keyof typeof cssColorNames];
    if (rgb) {
      return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
    }
    return color;
  }

  private static expandHex(hex: string): string {
    if (hex.length === 4) {
      return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    return hex;
  }
}
