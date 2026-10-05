import { UserPreferences, type TimelineSketchChildren } from '../api';
import type { LengthUnit } from '../units/units';
import {
  DEFAULT_GRID_FIXED_SPACING,
  DEFAULT_GRID_MAJOR_EVERY,
  DEFAULT_GRID_MIN_CELL_PX,
} from '../grid/grid-spacing';

export interface ViewerSettings {
  cameraMode: 'perspective' | 'orthographic';
  showGrid: boolean;
  /** Part-view connector gizmos (the `connector()` axis triads). */
  showConnectors: boolean;
  /** The world axis lines through the origin. Off for hosts that want the
   *  model alone on the surface (an embed, a captured still). */
  showAxes: boolean;
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
  /** Grid pitch follows zoom (ladder) rather than `gridFixedSpacing`. */
  gridAdaptive: boolean;
  /** Adaptive grid: the minor cell never shrinks below this many pixels. */
  gridMinCellPx: number;
  /** Fixed grid: minor pitch per document unit. */
  gridFixedSpacing: Record<LengthUnit, number>;
  /** Fixed grid: a major line every N minor cells. */
  gridMajorEvery: number;
  /** Tangent (G1) edges drawn dimmed toward the face colour. Off: they draw
   *  like every other model edge. The `dimTangentEdges` preference. */
  dimTangentEdges: boolean;
  /** Sketch snapping: the cursor snaps to a vertex, axis or grid line within
   *  this many screen pixels. The `snapRadiusPx` preference. */
  snapRadiusPx: number;
  /** Sketch picking: an entity or vertex within this many screen pixels of
   *  the cursor is hovered and selectable. The `pickRadiusPx` preference. */
  pickRadiusPx: number;
  /** Which of a sketch's children the timeline lists: every row, or only
   *  the features that open an edit dialog. Constraints and regions have
   *  their own switches. The `timelineSketchChildren` preference. */
  timelineSketchChildren: TimelineSketchChildren;
  /** The timeline lists a sketch's constraints behind their group row.
   *  The `timelineShowConstraints` preference. */
  timelineShowConstraints: boolean;
  /** The timeline lists a sketch's region declarations behind their group
   *  row. The `timelineShowRegions` preference. */
  timelineShowRegions: boolean;
}

export const DEFAULT_SNAP_RADIUS_PX = 15;
export const DEFAULT_PICK_RADIUS_PX = 12;

type Listener = (settings: ViewerSettings) => void;

const defaults: ViewerSettings = {
  cameraMode: 'orthographic',
  showGrid: true,
  showConnectors: true,
  showAxes: true,
  sectionView: true,
  sketchLockCamera: true,
  sketchShowDimensions: true,
  sketchShowPositional: true,
  measureLengthUnit: 'mm',
  gridAdaptive: true,
  gridMinCellPx: DEFAULT_GRID_MIN_CELL_PX,
  gridFixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING },
  gridMajorEvery: DEFAULT_GRID_MAJOR_EVERY,
  dimTangentEdges: false,
  snapRadiusPx: DEFAULT_SNAP_RADIUS_PX,
  pickRadiusPx: DEFAULT_PICK_RADIUS_PX,
  timelineSketchChildren: 'all',
  timelineShowConstraints: true,
  timelineShowRegions: false,
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
    ...(typeof prefs.showConnectors === 'boolean' ? { showConnectors: prefs.showConnectors } : {}),
    cameraMode: prefs.cameraMode,
    ...(prefs.measureLengthUnit ? { measureLengthUnit: prefs.measureLengthUnit } : {}),
    ...(typeof prefs.gridAdaptive === 'boolean' ? { gridAdaptive: prefs.gridAdaptive } : {}),
    ...(typeof prefs.gridMinCellPx === 'number' ? { gridMinCellPx: prefs.gridMinCellPx } : {}),
    // Older preference files may carry a partial record — fill from defaults
    // so every unit always has a pitch.
    ...(prefs.gridFixedSpacing ? { gridFixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING, ...prefs.gridFixedSpacing } } : {}),
    ...(typeof prefs.gridMajorEvery === 'number' ? { gridMajorEvery: prefs.gridMajorEvery } : {}),
    ...(typeof prefs.dimTangentEdges === 'boolean' ? { dimTangentEdges: prefs.dimTangentEdges } : {}),
    ...(typeof prefs.snapRadiusPx === 'number' ? { snapRadiusPx: prefs.snapRadiusPx } : {}),
    ...(typeof prefs.pickRadiusPx === 'number' ? { pickRadiusPx: prefs.pickRadiusPx } : {}),
    ...(prefs.timelineSketchChildren === 'all' || prefs.timelineSketchChildren === 'editable' ? { timelineSketchChildren: prefs.timelineSketchChildren } : {}),
    ...(typeof prefs.timelineShowConstraints === 'boolean' ? { timelineShowConstraints: prefs.timelineShowConstraints } : {}),
    ...(typeof prefs.timelineShowRegions === 'boolean' ? { timelineShowRegions: prefs.timelineShowRegions } : {}),
  });
}
