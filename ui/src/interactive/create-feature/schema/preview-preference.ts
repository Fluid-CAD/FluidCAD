/**
 * Whether a custom feature's dialog draws its live preview, remembered per
 * feature id in this browser. A preview runs the feature's own code on every
 * change, which can be slow (a gear, a loft through many sections), so it
 * starts off; a feature the user turned it on for opens with it on.
 */
export class PreviewPreference {
  private static readonly PREFIX = 'fluidcad.featurePreview.';

  /** On only when the user turned it on for this feature. */
  static read(featureId: string): boolean {
    try {
      return localStorage.getItem(PreviewPreference.PREFIX + featureId) === 'on';
    } catch {
      return false;
    }
  }

  static write(featureId: string, on: boolean): void {
    try {
      if (on) {
        localStorage.setItem(PreviewPreference.PREFIX + featureId, 'on');
      } else {
        localStorage.removeItem(PreviewPreference.PREFIX + featureId);
      }
    } catch {
      // Storage blocked or full: the toggle still works for this dialog.
    }
  }
}
