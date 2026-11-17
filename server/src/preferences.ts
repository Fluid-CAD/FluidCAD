import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultMaxWorkers, logicalCpuCount } from '../../lib/dist/oc/workers.js';
import { parseProjectMaterials, type ProjectMaterials } from './project-config.ts';

export type MeasureLengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type GridFixedSpacing = Record<MeasureLengthUnit, number>;

export const MEASURE_LENGTH_UNITS: MeasureLengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
/** Bounds the POST guard clamps to (no UI edits these; they only arrive from a hand-edited file). */
export const GRID_MIN_CELL_PX_RANGE: [number, number] = [8, 80];
export const GRID_MAJOR_EVERY_RANGE: [number, number] = [2, 100];
/** Editor font size bounds, px. */
export const EDITOR_FONT_SIZE_RANGE: [number, number] = [8, 40];
/** Sketch snap and pick radius bounds, screen px. */
export const SNAP_RADIUS_PX_RANGE: [number, number] = [2, 80];
export const PICK_RADIUS_PX_RANGE: [number, number] = [2, 80];
/** Kernel worker count bounds: at least one, at most one per logical CPU of this machine. */
export const MAX_WORKERS_RANGE: [number, number] = [1, logicalCpuCount()];

export interface Preferences {
  theme: string;
  showGrid: boolean;
  /** Part-view connector gizmos visible. */
  showConnectors: boolean;
  cameraMode: 'perspective' | 'orthographic';
  showBuildTimings: boolean;
  measureLengthUnit: MeasureLengthUnit;
  /** Grid pitch follows zoom (true) or pins `gridFixedSpacing` (false). */
  gridAdaptive: boolean;
  /** Adaptive grid: the minor cell never shrinks below this many pixels. */
  gridMinCellPx: number;
  /** Fixed grid: minor pitch per document unit, in that unit. */
  gridFixedSpacing: GridFixedSpacing;
  /** Fixed grid: a major line every N minor cells. */
  gridMajorEvery: number;
  /** Draw tangent (G1) edges dimmed toward the face colour instead of as
   *  regular edges. Default false: every model edge is a full line. */
  dimTangentEdges: boolean;
  /** Code-editor pane open at startup. Default false — the scene is the product. */
  editorOpen: boolean;
  /** Code-editor pane width, in px. */
  editorWidth: number;
  /** Code-editor font family; empty means the editor's own default stack. */
  editorFontFamily: string;
  /** Code-editor font size, px. */
  editorFontSize: number;
  /** Code-editor lines wrap at the pane edge instead of scrolling sideways. */
  editorWordWrap: boolean;
  /** Sketch snapping: how close (screen px) the cursor must be to a vertex, axis or grid line to snap. */
  snapRadiusPx: number;
  /** Sketch picking: how close (screen px) the cursor must be to an entity or vertex to hover or select it. */
  pickRadiusPx: number;
  /** The unit `fluidcad init` writes into a new project when none is asked for. */
  defaultProjectUnit: MeasureLengthUnit;
  /** Which of a sketch's children the timeline lists: every row, or only the features that have an edit dialog. */
  timelineSketchChildren: TimelineSketchChildren;
  /** The timeline lists a sketch's constraints (behind their "N constraints" group). Default true. */
  timelineShowConstraints: boolean;
  /** The timeline lists a sketch's region declarations (behind their "N regions" group). Default false. */
  timelineShowRegions: boolean;
  /** Most threads the kernel runs a boolean or a mesh on, which is also how many workers it starts with. Default: one per CPU, at most 8. */
  maxWorkers: number;
  /**
   * The user's own materials (Settings → Materials), keyed by the id
   * `part(...).material(id)` takes, in the same shape as a project's
   * `fluidcad.json` map. Picking one for a part copies that entry into the
   * project, so a model file never depends on this machine's list.
   */
  materials: ProjectMaterials;
  /**
   * Settings → Packages "Library folder": where installed packages live,
   * an absolute path. Empty means the default (`$FLUIDCAD_HOME/packages`,
   * else the home directory's `~/.fluidcad/packages`); `FLUIDCAD_PACKAGES`
   * overrides it (`PackageRoots.libraryPath`).
   */
  packageLibraryPath: string;
  /** Settings → Packages "New packages go to": the user library (default) or the open project's `packages/`. */
  packageInstallTarget: PackageInstallTarget;
  /**
   * The packages whose custom features the toolbar shows as buttons of
   * their own (pinned from the Custom dropdown), by package name — in every
   * project that offers them.
   */
  toolbarPackages: string[];
  /**
   * The tools Quick Find (the <kbd>S</kbd> popover) shows before a word is
   * typed, by tool id (`part:extrude`, `sketch:line`…) — in every project.
   * Null until the user pins or unpins one: the UI's defaults then, so a
   * new default reaches a user who never touched the pins.
   */
  quickFindPins: string[] | null;
  /** The in-app agent panel (Settings → Agent). */
  agent: AgentPreferences;
}

export const AGENT_KINDS = ['claude', 'codex'] as const;
export type AgentKindPreference = (typeof AGENT_KINDS)[number];
/** The efforts the older single `effort` field took; both agents accept them. */
export const AGENT_EFFORTS = ['low', 'medium', 'high'] as const;
/** Claude Code's `--effort` choices (`claude --help`, 2.1.326). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/**
 * A Codex reasoning effort: Codex types it as a string, and each model lists
 * its own (`model/list` → `supportedReasoningEfforts`: low … max, ultra).
 */
export const AGENT_EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const AGENT_PERMISSION_MODES = ['ask', 'auto-edits'] as const;

export interface AgentPreferences {
  /** The agent a new chat starts with; null until the user picks one. */
  defaultAgent: AgentKindPreference | null;
  /** Absolute path to the `claude` binary, overriding detection. */
  claudePath?: string;
  /** Absolute path to the `codex` binary, overriding detection. */
  codexPath?: string;
  /** Claude Code model (alias or full name); absent means Claude Code's own default. */
  claudeModel?: string;
  /** Codex model id; absent means Codex's own default. */
  codexModel?: string;
  /** Before per-agent efforts: one effort for both. Read when the agent's own is absent. */
  effort?: (typeof AGENT_EFFORTS)[number];
  /** Claude Code's `--effort`; absent means Claude Code's own default. */
  claudeEffort?: (typeof CLAUDE_EFFORTS)[number];
  /** Codex's reasoning effort; absent means the model's default. */
  codexEffort?: string;
  /** Ask before every edit (default), or apply workspace edits without asking. */
  permissionMode: (typeof AGENT_PERMISSION_MODES)[number];
  /**
   * Run Claude Code on the user's subscription even when ANTHROPIC_API_KEY
   * is set: the key is left out of its environment. true or false is the
   * user's choice and always holds; absent means automatic (the agent
   * runtime leaves the key out when a Claude subscription is signed in).
   * Never filled in by the defaults; null or '' in a POST clears it.
   */
  claudeIgnoreApiKey?: boolean;
}

const MAX_AGENT_PATH_CHARS = 1024;
const MAX_AGENT_MODEL_CHARS = 200;
/** A model alias or full model name: no spaces, nothing a shell or a flag parser reads specially. */
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][\w.:@\/\[\]-]*$/;

/**
 * The agent preferences in `value` merged over `base`: each field is taken
 * when valid and ignored otherwise; an empty string or null clears an
 * optional field. Used for the stored file and for a POST alike.
 */
export function mergeAgentPreferences(base: AgentPreferences, value: unknown): AgentPreferences {
  const out: AgentPreferences = { ...base };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return out;
  }
  const v = value as Record<string, unknown>;
  if (v.defaultAgent === null || AGENT_KINDS.includes(v.defaultAgent as AgentKindPreference)) {
    out.defaultAgent = v.defaultAgent as AgentKindPreference | null;
  }
  for (const key of ['claudePath', 'codexPath'] as const) {
    const raw = v[key];
    if (raw === null || raw === '') {
      delete out[key];
    } else if (typeof raw === 'string' && raw.length <= MAX_AGENT_PATH_CHARS && !raw.includes('\0')) {
      out[key] = raw.trim();
    }
  }
  for (const key of ['claudeModel', 'codexModel'] as const) {
    const raw = v[key];
    if (raw === null || raw === '') {
      delete out[key];
    } else if (typeof raw === 'string' && raw.length <= MAX_AGENT_MODEL_CHARS && AGENT_MODEL_PATTERN.test(raw.trim())) {
      out[key] = raw.trim();
    }
  }
  if (v.effort === null || v.effort === '') {
    delete out.effort;
  } else if (AGENT_EFFORTS.includes(v.effort as any)) {
    out.effort = v.effort as AgentPreferences['effort'];
  }
  if (v.claudeEffort === null || v.claudeEffort === '') {
    delete out.claudeEffort;
  } else if (CLAUDE_EFFORTS.includes(v.claudeEffort as any)) {
    out.claudeEffort = v.claudeEffort as AgentPreferences['claudeEffort'];
  }
  if (v.codexEffort === null || v.codexEffort === '') {
    delete out.codexEffort;
  } else if (typeof v.codexEffort === 'string' && AGENT_EFFORT_PATTERN.test(v.codexEffort)) {
    out.codexEffort = v.codexEffort;
  }
  if (AGENT_PERMISSION_MODES.includes(v.permissionMode as any)) {
    out.permissionMode = v.permissionMode as AgentPreferences['permissionMode'];
  }
  if (v.claudeIgnoreApiKey === null || v.claudeIgnoreApiKey === '') {
    delete out.claudeIgnoreApiKey;
  } else if (typeof v.claudeIgnoreApiKey === 'boolean') {
    out.claudeIgnoreApiKey = v.claudeIgnoreApiKey;
  }
  return out;
}

export const PACKAGE_INSTALL_TARGETS = ['library', 'project'] as const;

/** Most tool ids a Quick Find pin list keeps, and the longest one may be. */
const MAX_QUICK_FIND_PINS = 60;
const MAX_TOOL_ID_CHARS = 120;

/**
 * A Quick Find pin list as stored: unique non-empty tool ids, in the user's
 * order; null for an explicit null (the defaults). Undefined when `value`
 * is neither.
 */
export function parseQuickFindPins(value: unknown): string[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.filter(
    (id): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= MAX_TOOL_ID_CHARS,
  );
  return [...new Set(ids.map(id => id.trim()))].slice(0, MAX_QUICK_FIND_PINS);
}

/** Most packages the toolbar keeps pinned, and the longest name one may have (npm's limit). */
const MAX_TOOLBAR_PACKAGES = 100;
const MAX_PACKAGE_NAME_CHARS = 214;

/**
 * A list of pinned package names as stored: unique non-empty strings no
 * longer than a package name may be, sorted; null when `value` is no list.
 */
export function parseToolbarPackages(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names = value.filter(
    (name): name is string => typeof name === 'string' && name.trim() !== '' && name.length <= MAX_PACKAGE_NAME_CHARS,
  );
  return [...new Set(names.map(name => name.trim()))].sort().slice(0, MAX_TOOLBAR_PACKAGES);
}
export type PackageInstallTarget = (typeof PACKAGE_INSTALL_TARGETS)[number];

export const TIMELINE_SKETCH_CHILDREN = ['all', 'editable'] as const;
export type TimelineSketchChildren = (typeof TIMELINE_SKETCH_CHILDREN)[number];

const DEFAULTS: Preferences = {
  theme: 'fluidcad-dark',
  showGrid: true,
  showConnectors: true,
  cameraMode: 'orthographic',
  showBuildTimings: false,
  measureLengthUnit: 'mm',
  gridAdaptive: true,
  gridMinCellPx: 20,
  gridFixedSpacing: { mm: 10, cm: 1, m: 0.1, in: 0.5, ft: 0.25 },
  gridMajorEvery: 10,
  dimTangentEdges: false,
  editorOpen: false,
  editorWidth: 420,
  editorFontFamily: '',
  editorFontSize: 13,
  editorWordWrap: false,
  snapRadiusPx: 15,
  pickRadiusPx: 12,
  defaultProjectUnit: 'mm',
  timelineSketchChildren: 'all',
  timelineShowConstraints: true,
  timelineShowRegions: false,
  maxWorkers: defaultMaxWorkers(),
  materials: {},
  packageLibraryPath: '',
  packageInstallTarget: 'library',
  toolbarPackages: [],
  quickFindPins: null,
  agent: { defaultAgent: null, permissionMode: 'ask' },
};

/** A fresh copy of the defaults — what "Reset all to defaults" writes. */
export function defaultPreferences(): Preferences {
  return {
    ...DEFAULTS,
    gridFixedSpacing: { ...DEFAULTS.gridFixedSpacing },
    materials: {},
    toolbarPackages: [],
    quickFindPins: null,
    agent: { ...DEFAULTS.agent },
  };
}

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
    return parsePreferences(await fs.readFile(getPreferencesPath(), 'utf-8'));
  } catch {
    return defaultPreferences();
  }
}

/**
 * {@link loadPreferences} for a synchronous caller: the package roots are
 * asked from the workspace walks and the watcher's `ignored` test, which
 * can't wait.
 */
export function loadPreferencesSync(): Preferences {
  try {
    return parsePreferences(readFileSync(getPreferencesPath(), 'utf-8'));
  } catch {
    return defaultPreferences();
  }
}

function parsePreferences(data: string): Preferences {
  const parsed = JSON.parse(data);
  // The spacing record is the one nested value: merge it per key so a
  // file written before a unit existed still yields a pitch for it.
  // A hand-edited map that fails the fluidcad.json rules is dropped whole,
  // like a bad project map: nothing downstream re-validates entries.
  const materials = parseProjectMaterials(parsed.materials);
  return {
    ...DEFAULTS,
    ...parsed,
    gridFixedSpacing: { ...DEFAULTS.gridFixedSpacing, ...(parsed.gridFixedSpacing ?? {}) },
    materials: 'materials' in materials ? materials.materials : {},
    toolbarPackages: parseToolbarPackages(parsed.toolbarPackages) ?? [],
    quickFindPins: parseQuickFindPins(parsed.quickFindPins) ?? null,
    agent: mergeAgentPreferences({ ...DEFAULTS.agent }, parsed.agent),
  };
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getPreferencesPath(), JSON.stringify(prefs, null, 2), 'utf-8');
}

/** Put every preference back to its default and persist that. */
export async function resetPreferences(): Promise<Preferences> {
  const prefs = defaultPreferences();
  await savePreferences(prefs);
  return prefs;
}

/**
 * The unit a new project starts in when `fluidcad init` is given none: the
 * stored preference, or null when it is the built-in mm (a project without
 * the key is an mm project, so nothing needs writing).
 */
export async function preferredNewProjectUnit(): Promise<MeasureLengthUnit | null> {
  const prefs = await loadPreferences();
  const unit = prefs.defaultProjectUnit;
  if (!MEASURE_LENGTH_UNITS.includes(unit) || unit === 'mm') {
    return null;
  }
  return unit;
}
