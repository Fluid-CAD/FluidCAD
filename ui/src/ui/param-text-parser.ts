import type { CatalogParamValue } from '../api';
import type { UIParamDefinition } from '../types';
import { effectiveControlType } from './param-controls';

/** A cell's text read as a parameter value: null clears the cell (it inherits), or why the text is no value. */
export type ParsedParamText = { value: CatalogParamValue | null } | { error: string };

/**
 * Reads the text of a pasted cell as a value of a parameter's own type —
 * the same vocabulary its control writes: a number inside the declared
 * bounds, yes/no, an option by its label or value (several, comma
 * separated, for a multi-select), a `#rrggbb` colour or free text. A blank
 * cell is no value: the cell inherits the parameter's literal.
 */
export class ParamTextParser {
  private static readonly TRUE = new Set(['true', 'yes', 'y', 'on', '1', 'x', '✓']);
  private static readonly FALSE = new Set(['false', 'no', 'n', 'off', '0']);

  static parse(param: UIParamDefinition, text: string): ParsedParamText {
    const trimmed = text.trim();
    if (trimmed === '') {
      return { value: null };
    }
    switch (effectiveControlType(param)) {
      case 'number':
      case 'slider':
        return ParamTextParser.number(param, trimmed);
      case 'checkbox':
        return ParamTextParser.boolean(trimmed);
      case 'select':
        return param.multi ? ParamTextParser.options(param, trimmed) : ParamTextParser.option(param, trimmed);
      case 'color':
        return ParamTextParser.color(trimmed);
      default:
        return { value: text };
    }
  }

  private static number(param: UIParamDefinition, text: string): ParsedParamText {
    const value = Number(text.replace(/\s/g, ''));
    if (!Number.isFinite(value)) {
      return { error: `“${text}” is not a number` };
    }
    if ((param.min != null && value < param.min) || (param.max != null && value > param.max)) {
      return { error: `${text} is outside ${ParamTextParser.bounds(param)}` };
    }
    return { value };
  }

  private static bounds(param: UIParamDefinition): string {
    if (param.min != null && param.max != null) {
      return `${param.min}–${param.max}`;
    }
    return param.min != null ? `the minimum ${param.min}` : `the maximum ${param.max}`;
  }

  private static boolean(text: string): ParsedParamText {
    const key = text.toLowerCase();
    if (ParamTextParser.TRUE.has(key)) {
      return { value: true };
    }
    if (ParamTextParser.FALSE.has(key)) {
      return { value: false };
    }
    return { error: `“${text}” is not yes or no` };
  }

  private static option(param: UIParamDefinition, text: string): ParsedParamText {
    const value = ParamTextParser.matchOption(param, text);
    if (value === undefined) {
      return { error: `“${text}” is not one of ${ParamTextParser.optionList(param)}` };
    }
    return { value };
  }

  private static options(param: UIParamDefinition, text: string): ParsedParamText {
    const values: (string | number)[] = [];
    for (const part of text.split(/[,;]/).map((p) => p.trim()).filter((p) => p !== '')) {
      const value = ParamTextParser.matchOption(param, part);
      if (value === undefined) {
        return { error: `“${part}” is not one of ${ParamTextParser.optionList(param)}` };
      }
      if (!values.includes(value)) {
        values.push(value);
      }
    }
    return { value: values };
  }

  /** An option by its value, else by its label — exact first, then ignoring case. */
  private static matchOption(param: UIParamDefinition, text: string): string | number | undefined {
    const options = param.options ?? [];
    const lower = text.toLowerCase();
    const match = options.find((o) => String(o.value) === text)
      ?? options.find((o) => o.label === text)
      ?? options.find((o) => String(o.value).toLowerCase() === lower || o.label.toLowerCase() === lower);
    return match?.value;
  }

  private static optionList(param: UIParamDefinition): string {
    return (param.options ?? []).map((o) => o.label).join(', ');
  }

  private static color(text: string): ParsedParamText {
    const hex = text.replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return { value: `#${hex.toLowerCase()}` };
    }
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return { value: `#${Array.from(hex.toLowerCase(), (c) => c + c).join('')}` };
    }
    return { error: `“${text}” is not a #rrggbb colour` };
  }
}
