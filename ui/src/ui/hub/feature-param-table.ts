import type { HubParamSpec } from '../../api';
import { HubImage } from './hub-icons';

/** One option of a select or radio, as the manifest declares it (its image already on the engine's file proxy). */
type ChoiceOption = { label?: unknown; value?: unknown; image?: unknown };

/** A row of the table: the value's name and label, the control it gets, its default. */
export type FeatureParamRow = {
  name: string;
  label: string;
  control: string;
  /** Option images shown under the control (selects and radios that declare them). */
  images: { src: string; label: string }[];
  /** The default as the dialog shows it; `dim` when it's a placeholder (picked, empty, none). */
  value: string;
  dim: boolean;
  /** When the row shows, if it isn't always there. */
  shownWhen: string | null;
};

/**
 * A custom feature's values as a table (hub-plan H11, decision 4: the
 * mock's `detail-table` in place of a dialog preview): each value's name
 * and label, the control its dialog gives it, and its default, read from
 * the package's manifest as data. Nothing from the package runs, and every
 * value is set as text; option images come from the engine's file proxy.
 */
export class FeatureParamTable {
  private static readonly PICKERS: Readonly<Record<string, string>> = {
    sketch: 'sketch',
    face: 'face',
    edge: 'edge',
    axis: 'axis',
    plane: 'plane',
    solid: 'solid',
    feature: 'feature',
    connector: 'connector',
    point: 'point',
    anchor: 'anchor',
  };

  /**
   * The table's rows in the dialog's order: the order the feature's
   * `layout` places its values (the hub stores a manifest as `jsonb`, which
   * doesn't keep an object's key order), then any value the layout leaves out.
   */
  static rows(meta: { params?: Record<string, HubParamSpec>; layout?: unknown }, unit: string | null): FeatureParamRow[] {
    const params = meta.params ?? {};
    const order = FeatureParamTable.layoutOrder(meta.layout).filter((name) => Object.hasOwn(params, name));
    for (const name of Object.keys(params)) {
      if (!order.includes(name)) {
        order.push(name);
      }
    }
    return order.map((name) => FeatureParamTable.row(name, params[name] ?? {}, unit));
  }

  /** The value names a layout places, in order: strings among its items, rows, sections and tabs. */
  static layoutOrder(layout: unknown): string[] {
    const names: string[] = [];
    const walk = (items: unknown) => {
      if (!Array.isArray(items)) {
        return;
      }
      for (const item of items) {
        if (typeof item === 'string') {
          if (!names.includes(item)) {
            names.push(item);
          }
        } else if (item !== null && typeof item === 'object') {
          const entry = item as Record<string, unknown>;
          walk(entry.row);
          walk(entry.items);
          if (Array.isArray(entry.tabs)) {
            for (const tab of entry.tabs) {
              walk((tab as Record<string, unknown> | null)?.items);
            }
          }
        }
      }
    };
    walk(layout);
    return names;
  }

  static row(name: string, spec: HubParamSpec, unit: string | null): FeatureParamRow {
    const label = typeof spec.label === 'string' && spec.label !== '' ? spec.label : name;
    const shownWhen = FeatureParamTable.shownWhen(spec.visibleWhen);
    if (spec.picker !== undefined) {
      const { control, value } = FeatureParamTable.picker(spec);
      return { name, label, control, images: [], value, dim: true, shownWhen };
    }
    const type = typeof spec.type === 'string' ? spec.type : '';
    if (type === 'select' || type === 'radio') {
      return { name, label, ...FeatureParamTable.choices(spec, type), shownWhen };
    }
    if (type === 'boolean') {
      const on = spec.default === true;
      return { name, label, control: spec.display === 'checkbox' ? 'Checkbox' : 'Toggle', images: [], value: on ? 'on' : 'off', dim: false, shownWhen };
    }
    if (type === 'text') {
      const text = typeof spec.default === 'string' ? spec.default : '';
      const control = ['Text', spec.multiline === true ? 'several lines' : null, typeof spec.maxLength === 'number' ? `at most ${spec.maxLength} characters` : null]
        .filter(Boolean).join(', ');
      return { name, label, control, images: [], value: text === '' ? 'empty' : text, dim: text === '', shownWhen };
    }
    return { name, label, ...FeatureParamTable.number(spec, type, unit), images: [], shownWhen };
  }

  /** The table element, for a feature's metadata. */
  static create(meta: { params?: Record<string, HubParamSpec>; layout?: unknown }, unit: string | null): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.dataset.role = 'param-table';
    wrap.className = 'rounded-md border border-base-content/10 overflow-hidden';
    const rows = FeatureParamTable.rows(meta, unit);
    if (rows.length === 0) {
      const none = document.createElement('p');
      none.className = 'px-2 py-2 text-[11px] text-base-content/55';
      none.textContent = 'This feature takes no values: it builds from where it is placed.';
      wrap.appendChild(none);
      return wrap;
    }
    const table = document.createElement('table');
    table.className = 'w-full text-[11px]';
    const head = document.createElement('thead');
    head.className = 'bg-base-200 text-base-content/55';
    const headRow = document.createElement('tr');
    for (const title of ['Parameter', 'Control', 'Default']) {
      const th = document.createElement('th');
      th.className = 'text-left font-normal px-2 py-1.5';
      th.textContent = title;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    body.className = 'divide-y divide-base-content/[0.07]';
    for (const row of rows) {
      body.appendChild(FeatureParamTable.tableRow(row));
    }
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }

  private static tableRow(row: FeatureParamRow): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.param = row.name;
    const nameCell = document.createElement('td');
    nameCell.className = 'px-2 py-1.5 align-top';
    const name = document.createElement('span');
    name.className = 'font-mono text-base-content/85 break-all';
    name.textContent = row.name;
    const label = document.createElement('span');
    label.className = 'block text-base-content/50';
    label.textContent = row.label;
    nameCell.append(name, label);

    const controlCell = document.createElement('td');
    controlCell.className = 'px-2 py-1.5 align-top text-base-content/75';
    controlCell.append(row.control);
    if (row.images.length > 0) {
      const images = document.createElement('span');
      images.className = 'flex flex-wrap gap-1 mt-1';
      for (const image of row.images) {
        const chip = document.createElement('span');
        chip.className = 'inline-flex items-center gap-1 h-6 pl-0.5 pr-1.5 rounded border border-base-content/10 bg-base-100';
        const text = document.createElement('span');
        text.textContent = image.label;
        chip.append(HubImage.create(image.src, 'size-5 object-contain'), text);
        images.appendChild(chip);
      }
      controlCell.appendChild(images);
    }
    if (row.shownWhen) {
      const when = document.createElement('span');
      when.className = 'block text-base-content/45 mt-0.5';
      when.textContent = row.shownWhen;
      controlCell.appendChild(when);
    }

    const valueCell = document.createElement('td');
    valueCell.className = `px-2 py-1.5 align-top font-mono ${row.dim ? 'text-base-content/45' : 'text-base-content/85'}`;
    valueCell.textContent = row.value;
    tr.append(nameCell, controlCell, valueCell);
    return tr;
  }

  /** What a picker picks: `Pick a planar face`, `Pick a connector, point or anchor, several`. */
  private static picker(spec: HubParamSpec): { control: string; value: string } {
    const kinds = (Array.isArray(spec.picker) ? spec.picker : [spec.picker])
      .filter((kind): kind is string => typeof kind === 'string')
      .map((kind) => FeatureParamTable.PICKERS[kind] ?? kind);
    if (kinds.length > 0 && spec.surface && typeof spec.surface === 'string' && kinds[0] === 'face') {
      kinds[0] = `${spec.surface} face`;
    }
    if (kinds.length > 0 && spec.curve && typeof spec.curve === 'string' && kinds[0] === 'edge') {
      kinds[0] = `${spec.curve} edge`;
    }
    const what = FeatureParamTable.orList(kinds);
    const extra = [
      typeof spec.max === 'number' ? `up to ${spec.max}` : spec.multiple === true ? 'several' : null,
      spec.ordered === true ? 'in order' : null,
      spec.optional === true ? 'optional' : null,
    ].filter(Boolean);
    const control = `Pick ${FeatureParamTable.article(what)}${extra.length > 0 ? `, ${extra.join(', ')}` : ''}`;
    const value = spec.picker === 'sketch' && spec.implicitDefault === true ? 'the active sketch' : 'picked';
    return { control, value };
  }

  private static choices(spec: HubParamSpec, type: 'select' | 'radio'): Pick<FeatureParamRow, 'control' | 'images' | 'value' | 'dim'> {
    const options = (Array.isArray(spec.options) ? spec.options : []) as ChoiceOption[];
    const labelOf = (option: ChoiceOption) => (typeof option.label === 'string' ? option.label : String(option.value ?? ''));
    const withImages = options.some((option) => typeof option.image === 'string');
    let kind: string;
    if (type === 'select') {
      kind = spec.multiple === true ? 'Select, several' : spec.display === 'grid' ? 'Grid' : 'Select';
    } else {
      kind = ({ buttons: 'Buttons', cards: 'Cards', inline: 'Choices on one line' } as Record<string, string>)[String(spec.display)] ?? 'Choices';
    }
    const names = options.slice(0, 8).map(labelOf);
    const more = options.length > 8 ? `, +${options.length - 8}` : '';
    const control = `${kind}${withImages ? ' with images' : ''}${names.length > 0 ? `: ${names.join(', ')}${more}` : ''}`;
    const images = options
      .filter((option) => typeof option.image === 'string' && (option.image as string).startsWith('api/hub/files/'))
      .slice(0, 8)
      .map((option) => ({ src: option.image as string, label: labelOf(option) }));
    const byValue = (value: unknown) => {
      const option = options.find((o) => o.value === value);
      return option ? labelOf(option) : String(value);
    };
    if (spec.multiple === true) {
      const list = Array.isArray(spec.default) ? spec.default : [];
      return { control, images, value: list.length === 0 ? 'none' : list.map(byValue).join(', '), dim: list.length === 0 };
    }
    if (spec.default === undefined || spec.default === null) {
      const first = spec.optional === true ? null : options[0];
      return { control, images, value: first ? labelOf(first) : 'none', dim: !first };
    }
    return { control, images, value: byValue(spec.default), dim: false };
  }

  private static number(spec: HubParamSpec, type: string, unit: string | null): Pick<FeatureParamRow, 'control' | 'value' | 'dim'> {
    const kinds: Record<string, string> = { length: 'Length', angle: 'Angle', integer: 'Whole number', number: 'Number' };
    const min = typeof spec.min === 'number' ? spec.min : null;
    const max = typeof spec.max === 'number' ? spec.max : null;
    const parts = [kinds[type] ?? 'Number'];
    if (spec.display === 'slider' && min !== null && max !== null) {
      parts.push(`slider ${min} to ${max}`);
    } else if (spec.display === 'stepper') {
      parts.push('stepper');
    }
    if (spec.display !== 'slider') {
      if (min !== null && max !== null) {
        parts.push(`${min} to ${max}`);
      } else if (min !== null) {
        parts.push(`at least ${min}`);
      } else if (max !== null) {
        parts.push(`at most ${max}`);
      }
    }
    const suffix = typeof spec.suffix === 'string' ? spec.suffix : type === 'length' ? unit ?? 'mm' : type === 'angle' ? '°' : '';
    const fallback = spec.display === 'slider' ? min : null;
    const value = typeof spec.default === 'number' ? spec.default : fallback;
    if (value === null) {
      return { control: parts.join(', '), value: 'asked for', dim: true };
    }
    return { control: parts.join(', '), value: suffix === '°' ? `${value}°` : suffix ? `${value} ${suffix}` : String(value), dim: false };
  }

  /** `Shown when standard is iso`, `… head is counterbore or countersink`. */
  private static shownWhen(visibleWhen: unknown): string | null {
    if (visibleWhen === null || typeof visibleWhen !== 'object' || Array.isArray(visibleWhen)) {
      return null;
    }
    const clauses = Object.entries(visibleWhen as Record<string, unknown>).map(([param, value]) => {
      const values = (Array.isArray(value) ? value : [value]).map((v) => String(v));
      return `${param} is ${FeatureParamTable.orList(values)}`;
    });
    return clauses.length > 0 ? `Shown when ${clauses.join(' and ')}` : null;
  }

  private static orList(words: string[]): string {
    if (words.length <= 1) {
      return words[0] ?? '';
    }
    return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  }

  private static article(what: string): string {
    return /^[aeiou]/i.test(what) ? `an ${what}` : `a ${what}`;
  }
}
