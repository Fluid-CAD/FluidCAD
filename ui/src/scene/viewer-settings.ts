import { UserPreferences } from '../api';
import type { AngleUnit, LengthUnit } from '../units/units';
import {
  DEFAULT_GRID_FIXED_SPACING,
  DEFAULT_GRID_MAJOR_EVERY,
  DEFAULT_GRID_MIN_CELL_PX,
} from '../grid/grid-spacing';

export interface ViewerSettings {
  cameraMode: 'perspective' | 'orthographic';
  showGrid: boolean;
  sectionView: boolean;
  sketchLockCamera: boolean;
  /** Sketch dimensional-constraint annotations (distance, angle, radius,
   * diameter): leaders, value readouts, angle arcs. */
  sketchShowDimensions: boolean;
  /** Sketch positional-constraint annotations: badges and coincidence dots. */
  sketchShowPositional: boolean;
  /** The measure tool's display unit — a preference, distinct from the
   * document unit (`sceneUnit`), which it converts from. */
  measureLengthUnit: LengthUnit;
  measureAngleUnit: AngleUnit;
  /** Append the document unit to on-canvas sketch dimension labels. */
  sketchDimensionSuffix: boolean;
  /** Grid pitch follows zoom (ladder) rather than `gridFixedSpacing`. */
  gridAdaptive: boolean;
  /** Adaptive grid: the minor cell never shrinks below this many pixels. */
  gridMinCellPx: number;
  /** Fixed grid: minor pitch per document unit. */
  gridFixedSpacing: Record<LengthUnit, number>;
  /** Fixed grid: a major line every N minor cells. */
  gridMajorEvery: number;
}

type Listener = (settings: ViewerSettings) => void;

const defaults: ViewerSettings = {
  cameraMode: 'orthographic',
  showGrid: true,
  sectionView: true,
  sketchLockCamera: true,
  sketchShowDimensions: true,
  sketchShowPositional: true,
  measureLengthUnit: 'mm',
  measureAngleUnit: 'deg',
  sketchDimensionSuffix: false,
  gridAdaptive: true,
  gridMinCellPx: DEFAULT_GRID_MIN_CELL_PX,
  gridFixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING },
  gridMajorEvery: DEFAULT_GRID_MAJOR_EVERY,
};

class ViewerSettingsStore {
  current: ViewerSettings = { ...defaults };
  private listeners = new Set<Listener>();

  update(partial: Partial<ViewerSettings>): void {
    Object.assign(this.current, partial);
    for (const fn of this.listeners) fn(this.current);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const viewerSettings = new ViewerSettingsStore();

export function applyPreferences(prefs: UserPreferences): void {
  viewerSettings.update({
    showGrid: prefs.showGrid,
    cameraMode: prefs.cameraMode,
    ...(prefs.measureLengthUnit ? { measureLengthUnit: prefs.measureLengthUnit } : {}),
    ...(prefs.measureAngleUnit ? { measureAngleUnit: prefs.measureAngleUnit } : {}),
    ...(typeof prefs.sketchDimensionSuffix === 'boolean' ? { sketchDimensionSuffix: prefs.sketchDimensionSuffix } : {}),
    ...(typeof prefs.gridAdaptive === 'boolean' ? { gridAdaptive: prefs.gridAdaptive } : {}),
    ...(typeof prefs.gridMinCellPx === 'number' ? { gridMinCellPx: prefs.gridMinCellPx } : {}),
    // Older preference files may carry a partial record — fill from defaults
    // so every unit always has a pitch.
    ...(prefs.gridFixedSpacing ? { gridFixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING, ...prefs.gridFixedSpacing } } : {}),
    ...(typeof prefs.gridMajorEvery === 'number' ? { gridMajorEvery: prefs.gridMajorEvery } : {}),
  });
}
