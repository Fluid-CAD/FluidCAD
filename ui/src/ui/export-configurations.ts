import type { UIConfigurations } from '../types';
import { DEFAULT_CONFIGURATION } from './configurations-grid-model';

/**
 * What the export dialog's Configuration select picks: one `configurations()`
 * row (Default included), or every row into one archive.
 */
export type ConfigurationPick = { kind: 'one'; name: string } | { kind: 'all' };

/** One file of an "All configurations" archive: the row it renders and its name inside the zip. */
export type ConfigurationEntry = { configuration: string; fileName: string };

/** The select value of the "All configurations" option; a row's value is prefixed, so no row name can collide with it. */
const ALL_VALUE = 'all';
const ROW_VALUE_PREFIX = 'row:';

/**
 * The export dialog's view of a `configurations()` table, kept free of the
 * DOM: the rows it offers, the select's option values, and the files of an
 * "All configurations" export — named the way `fluidcad export
 * --all-configurations` names them — packed into one zip.
 */
export class ConfigurationExport {
  /** Every row an export can render: Default (the literals) first, then the table's rows in declaration order. */
  static rows(table: UIConfigurations): string[] {
    return [DEFAULT_CONFIGURATION, ...table.names.filter(name => name !== DEFAULT_CONFIGURATION)];
  }

  /** Whether `pick` still names something `table` offers — a renamed or removed row does not. */
  static offers(table: UIConfigurations, pick: ConfigurationPick): boolean {
    return pick.kind === 'all' || ConfigurationExport.rows(table).includes(pick.name);
  }

  static optionValue(pick: ConfigurationPick): string {
    return pick.kind === 'all' ? ALL_VALUE : `${ROW_VALUE_PREFIX}${pick.name}`;
  }

  /** The pick a select value stands for; null for a value no option of this dialog carries. */
  static parseOptionValue(value: string): ConfigurationPick | null {
    if (value === ALL_VALUE) {
      return { kind: 'all' };
    }
    if (value.startsWith(ROW_VALUE_PREFIX)) {
      return { kind: 'one', name: value.slice(ROW_VALUE_PREFIX.length) };
    }
    return null;
  }

  /**
   * The archive's files, one per row in {@link rows} order: Default as
   * `<base><ext>`, each row as `<base>-<Row><ext>` with the name made
   * file-safe. Two rows that sanitise alike get `-2`, `-3`, … (compared
   * case-insensitively, as a Windows or macOS unzip would), so no entry
   * overwrites another.
   */
  static entries(table: UIConfigurations, base: string, extension: string): ConfigurationEntry[] {
    const taken = new Set<string>();
    return ConfigurationExport.rows(table).map((configuration) => {
      const stem = configuration === DEFAULT_CONFIGURATION
        ? base
        : `${base}-${ConfigurationExport.fileSegment(configuration)}`;
      let fileName = `${stem}${extension}`;
      for (let n = 2; taken.has(fileName.toLowerCase()); n++) {
        fileName = `${stem}-${n}${extension}`;
      }
      taken.add(fileName.toLowerCase());
      return { configuration, fileName };
    });
  }

  /** The download name of an "All configurations" export. */
  static archiveName(base: string): string {
    return `${base}-configurations.zip`;
  }

  /**
   * One zip holding every exported file. JSZip loads on the first archive,
   * so a session that never exports every configuration never fetches it.
   */
  static async archive(files: { fileName: string; blob: Blob }[]): Promise<Blob> {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const { fileName, blob } of files) {
      zip.file(fileName, new Uint8Array(await blob.arrayBuffer()));
    }
    const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
    return new Blob([bytes], { type: 'application/zip' });
  }

  /**
   * A row name as a file-name segment: anything outside letters, digits,
   * `.`, `_` and `-` becomes `-`, runs collapse, and leading/trailing
   * separators go — the CLI's `sanitizeConfigurationName`.
   */
  private static fileSegment(name: string): string {
    const cleaned = name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    return cleaned || 'configuration';
  }
}
