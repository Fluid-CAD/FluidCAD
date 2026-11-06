import { Color } from 'three';

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_PATTERN = /^rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*(?:,|\s)\s*\d{1,3}(?:\.\d+)?%?\s*(?:,|\s)\s*\d{1,3}(?:\.\d+)?%?\s*(?:(?:,|\/)\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i;

/**
 * The colour values the Color dialog accepts and writes — the server's
 * `ColorValues` rules, mirrored so the field validates as it is typed: a
 * `#rgb` / `#rrggbb` hex value (normalized to lowercase), a CSS colour name
 * (`steelblue`, lowercased) or an `rgb(…)` / `rgba(…)` string (kept as
 * spelled). The colour well needs a hex value: a name converts, an `rgb()`
 * string shows the well's last colour instead.
 */
export class ColorValues {
  /** The value as the statement writes it, or null when the text is no colour. */
  static normalize(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      return null;
    }
    if (HEX_PATTERN.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (RGB_PATTERN.test(trimmed)) {
      return trimmed;
    }
    const name = trimmed.toLowerCase();
    return Object.prototype.hasOwnProperty.call(Color.NAMES, name) ? name : null;
  }

  /** Lowercase `#rrggbb` for a hex value or a colour name; null for an `rgb()` string or no colour. */
  static toHex(text: string): string | null {
    const normalized = ColorValues.normalize(text);
    if (normalized === null) {
      return null;
    }
    if (normalized.startsWith('#')) {
      return normalized.length === 4
        ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
        : normalized;
    }
    if (normalized.startsWith('rgb')) {
      return null;
    }
    return `#${(Color.NAMES as Record<string, number>)[normalized].toString(16).padStart(6, '0')}`;
  }

  /** What the viewport can tint with: any accepted value — three parses names, hex and `rgb()` alike. */
  static tint(text: string): string | null {
    return ColorValues.normalize(text);
  }
}
