import type { SelectedEntity } from '../../viewer';

/** What hiding the idle selection needs of the viewer. */
export type SelectionHighlighter = {
  clearHighlight(): void;
  highlightEntities(entities: SelectedEntity[]): void;
};

/** Something else the selection draws in the scene (the measure overlay), hidden alongside. */
export type HideableOverlay = { setHidden(hidden: boolean): void };

/**
 * Runs `fn` with the idle selection's highlight (the amber faces and edges)
 * and its overlay off, and puts them back right after, in the same task: a
 * capture taken inside `fn` (the Agent's references image, §11.2) shows
 * only what it highlights itself, and the user never sees the selection
 * flicker. `fn` must draw what it needs before it returns (a capture renders
 * synchronously; only its PNG encoding is async).
 */
export function withSelectionHidden<T>(
  viewer: SelectionHighlighter,
  entities: readonly SelectedEntity[],
  fn: () => T,
  overlay?: HideableOverlay,
): T {
  if (entities.length === 0) {
    overlay?.setHidden(true);
    try {
      return fn();
    } finally {
      overlay?.setHidden(false);
    }
  }
  viewer.clearHighlight();
  overlay?.setHidden(true);
  try {
    return fn();
  } finally {
    overlay?.setHidden(false);
    viewer.highlightEntities([...entities]);
  }
}
