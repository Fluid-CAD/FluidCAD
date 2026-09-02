import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type MeasureLengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type MeasureAngleUnit = 'deg' | 'rad';
export type GridFixedSpacing = Record<MeasureLengthUnit, number>;

export const MEASURE_LENGTH_UNITS: MeasureLengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
/** Bounds the POST guard clamps to; mirrored in the UI's grid module. */
export const GRID_MIN_CELL_PX_RANGE: [number, number] = [8, 80];
export const GRID_MAJOR_EVERY_RANGE: [number, number] = [2, 100];

export interface Preferences {
  theme: string;
  showGrid: boolean;
  cameraMode: 'perspective' | 'orthographic';
  showBuildTimings: boolean;
  measureLengthUnit: MeasureLengthUnit;
  measureAngleUnit: MeasureAngleUnit;
  /** Append the document unit to on-canvas sketch dimension labels. */
  sketchDimensionSuffix: boolean;
  /** Grid pitch follows zoom (true) or pins `gridFixedSpacing` (false). */
  gridAdaptive: boolean;
  /** Adaptive grid: the minor cell never shrinks below this many pixels. */
  gridMinCellPx: number;
  /** Fixed grid: minor pitch per document unit, in that unit. */
  gridFixedSpacing: GridFixedSpacing;
  /** Fixed grid: a major line every N minor cells. */
  gridMajorEvery: number;
  /** Code-editor pane open at startup. Default false — the scene is the product. */
  editorOpen: boolean;
  /** Code-editor pane width, in px. */
  editorWidth: number;
}

const DEFAULTS: Preferences = {
  theme: 'fluidcad-dark',
  showGrid: true,
  cameraMode: 'orthographic',
  showBuildTimings: false,
  measureLengthUnit: 'mm',
  measureAngleUnit: 'deg',
  sketchDimensionSuffix: false,
  gridAdaptive: true,
  gridMinCellPx: 20,
  gridFixedSpacing: { mm: 10, cm: 1, m: 0.1, in: 0.5, ft: 0.25 },
  gridMajorEvery: 10,
  editorOpen: false,
  editorWidth: 420,
};

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fluidcad');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'fluidcad');
  }
  // Linux / other
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'fluidcad');
}

function getPreferencesPath(): string {
  return path.join(getConfigDir(), 'preferences.json');
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const data = await fs.readFile(getPreferencesPath(), 'utf-8');
    const parsed = JSON.parse(data);
    // The spacing record is the one nested value: merge it per key so a
    // file written before a unit existed still yields a pitch for it.
    return {
      ...DEFAULTS,
      ...parsed,
      gridFixedSpacing: { ...DEFAULTS.gridFixedSpacing, ...(parsed.gridFixedSpacing ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getPreferencesPath(), JSON.stringify(prefs, null, 2), 'utf-8');
}
