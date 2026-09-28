import { fetchSketchNames, gotoSource } from '../../api';
import { SceneIndex } from '../../helpers/scene-index';
import { SceneObjectRender } from '../../types';
import { PickSlotChip } from '../pick-slot';

/**
 * A repeat a copy can follow — a linear or circular `repeat()` statement's
 * row — addressed by its call site, because scene ids change with every
 * render.
 */
export type PatternOption = {
  /** The repeat row's scene id in this render. */
  id: string;
  /** Its variable (`holes`) once the name lookup lands, else the row's own label. */
  label: string;
  filePath: string;
  line: number;
  column: number;
};

/** What a pick of a repeat — its row, or a shape it placed — comes to. */
export type PatternPick = { option: PatternOption } | { refusal: string };

/** Row types a `repeat()` statement renders as: the one the copy follows, and the kinds it refuses. */
const FOLLOWABLE_TYPES = new Set(['repeat-linear', 'repeat-circular']);

const NOT_A_REPEAT = 'That is not a repeat — pick a linear or circular repeat in the timeline, '
  + 'or a feature it repeated in the viewport.';

/**
 * The repeats a dialog can pick for a copy to follow (`copy(holes, bolt)` —
 * the Copy dialog's "Along a repeat"), the repeat side of the pick channel
 * the way {@link ConnectorOptions} is the connector side: a repeat's row in
 * the timeline, or any shape a repeat placed, resolves here to its
 * statement. Only a linear or circular repeat is followed; a mirror, rotate
 * or matrix repeat is refused at the pick, in the words the kernel would
 * use on the written row.
 */
export class PatternOptions {
  /** Every linear or circular repeat the scene holds, one per statement, outside sketches. */
  static collect(sceneObjects: SceneObjectRender[]): PatternOption[] {
    const index = SceneIndex.of(sceneObjects);
    const options: PatternOption[] = [];
    const seen = new Set<string>();
    for (const row of sceneObjects) {
      if (!row.type || !FOLLOWABLE_TYPES.has(row.type) || !row.sourceLocation || row.id == null) {
        continue;
      }
      if (index.enclosing(row, 'sketch')) {
        continue;
      }
      const loc = row.sourceLocation;
      const key = `${loc.filePath}:${loc.line}`;
      // A repeat of a repeat clones the inner one at the outer's call site:
      // the first row at a line is the statement's own.
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push({
        id: row.id,
        label: row.name || 'Repeat',
        filePath: loc.filePath,
        line: loc.line,
        column: loc.column,
      });
    }
    return options;
  }

  /** Whether a row is a `repeat()` of any kind — followable or not. */
  static isRepeatRow(row: SceneObjectRender): boolean {
    return (row.type != null && FOLLOWABLE_TYPES.has(row.type))
      || row.type === 'repeat-matrix'
      || row.uniqueType === 'mirror-feature';
  }

  /**
   * Why a repeat row can't be followed, or null when it can: a mirror
   * repeat reflects its instance — a copied connector is never reflected —
   * and a rotate or matrix repeat is no pattern of slots to follow.
   */
  static refusal(row: SceneObjectRender): string | null {
    if (row.uniqueType === 'mirror-feature') {
      return 'A mirror repeat can\'t be followed — a copied connector is never reflected. '
        + 'Pick a linear or circular repeat.';
    }
    if (row.type === 'repeat-matrix') {
      return 'A rotate or matrix repeat can\'t be followed — pick a linear or circular repeat.';
    }
    return row.type != null && FOLLOWABLE_TYPES.has(row.type) ? null : NOT_A_REPEAT;
  }

  /** A timeline row picked for the Pattern slot. */
  static forRow(row: SceneObjectRender, options: readonly PatternOption[]): PatternPick {
    const refusal = PatternOptions.refusal(row);
    if (refusal) {
      return { refusal };
    }
    const loc = row.sourceLocation;
    const option = loc ? PatternOptions.forLocation(loc, options) : undefined;
    return option ? { option } : { refusal: 'That repeat is not available to follow.' };
  }

  /**
   * A shape picked in the viewport for the Pattern slot: the repeat that
   * placed it — the row owning the shape, or the nearest repeat above it
   * (a repeat's clones sit under its row, and the last one owns the body a
   * repeated cut leaves behind).
   */
  static forShape(
    shapeId: string,
    sceneObjects: SceneObjectRender[],
    options: readonly PatternOption[],
  ): PatternPick {
    const owner = sceneObjects.find(row => row.sceneShapes?.some(shape => shape.shapeId === shapeId));
    if (!owner) {
      return { refusal: NOT_A_REPEAT };
    }
    const repeat = [owner, ...SceneIndex.of(sceneObjects).ancestors(owner)]
      .find(row => PatternOptions.isRepeatRow(row));
    if (!repeat) {
      return {
        refusal: 'That shape was not placed by a repeat — pick a linear or circular repeat in the timeline, '
          + 'or a feature it repeated in the viewport.',
      };
    }
    return PatternOptions.forRow(repeat, options);
  }

  /** The option at a statement — a kept pattern's, or a re-found pick's. */
  static forLocation(
    loc: { filePath: string; line: number },
    options: readonly PatternOption[],
  ): PatternOption | undefined {
    return options.find(option => option.filePath === loc.filePath && option.line === loc.line);
  }

  /** A stable signature for "same options" checks across the async name lookup. */
  static signature(options: readonly PatternOption[]): string {
    return options.map(option => `${option.filePath}:${option.line}`).join('|');
  }

  /** The options relabeled with their statements' variables (`holes`) where bound. */
  static async labelWithNames(options: PatternOption[]): Promise<PatternOption[]> {
    if (options.length === 0) {
      return options;
    }
    const names = await fetchSketchNames(options.map(option => option.line), 'repeat');
    return options.map((option, i) => {
      const name = names[i];
      return name ? { ...option, label: name } : option;
    });
  }

  /** A repeat's chip: its name, and its statement's line with the jump to it. */
  static chip(option: PatternOption, opts: { removable?: boolean } = {}): PickSlotChip {
    return {
      label: option.label,
      title: `Repeat ${option.label}`,
      badge: '●',
      removable: opts.removable,
      line: option.line,
      onGoto: () => gotoSource({ filePath: option.filePath, line: option.line, column: option.column }),
    };
  }
}
