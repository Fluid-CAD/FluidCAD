// Per-render bookkeeping of which file declared which unit. A leaf module:
// imports units.ts only, so lib/oc can read the active unit without cycles.
//
// unit() never sets a global "current unit" — import order would otherwise
// let an imported file's unit('in') poison a root without unit(). Units are
// stored BY FILE and resolved by file; the dynamic scope (withUnit) is the
// only carrier of "the unit of the thing being built right now".

import { DEFAULT_LENGTH_UNIT } from './units.js';
import type { LengthUnit } from './units.js';

export type UnitRegistryOptions = {
  projectUnit: LengthUnit;
  /** The entry document of this render. */
  rootFile: string;
  /** Nearest fluidcad.json lookup (Node only); undefined in the browser. */
  projectUnitForFile?: (file: string) => LengthUnit | null;
};

export class UnitRegistry {
  projectUnit: LengthUnit;
  rootFile: string;
  private readonly projectUnitForFile: ((file: string) => LengthUnit | null) | undefined;
  private readonly unitsByFile: Map<string, LengthUnit> = new Map();
  private readonly geometryStartedByFile: Set<string> = new Set();

  constructor(opts: UnitRegistryOptions) {
    this.projectUnit = opts.projectUnit;
    this.rootFile = opts.rootFile;
    this.projectUnitForFile = opts.projectUnitForFile;
  }

  /** Record a file's unit() statement. Once per file, and before its first geometry. */
  declare(file: string, unit: LengthUnit): void {
    if (this.unitsByFile.has(file)) {
      throw new Error(`unit(): unit() was already called in ${file}`);
    }
    if (this.geometryStartedByFile.has(file)) {
      throw new Error(`unit(): unit() must come before any geometry in ${file}`);
    }
    this.unitsByFile.set(file, unit);
  }

  /** The unit a file's numbers are in: its own unit() → nearest fluidcad.json → project unit. */
  resolve(file: string | null | undefined): LengthUnit {
    if (file) {
      const declared = this.unitsByFile.get(file);
      if (declared) {
        return declared;
      }
      const project = this.projectUnitForFile?.(file);
      if (project) {
        return project;
      }
    }
    return this.projectUnit;
  }

  declared(file: string): LengthUnit | null {
    return this.unitsByFile.get(file) ?? null;
  }

  /** Called by every builder invocation: from here on `file` can no longer declare a unit. */
  markGeometry(file: string | null | undefined): void {
    if (file) {
      this.geometryStartedByFile.add(file);
    }
  }

  hasGeometry(file: string): boolean {
    return this.geometryStartedByFile.has(file);
  }

  get rootUnit(): LengthUnit {
    return this.resolve(this.rootFile);
  }
}

let currentRegistry: UnitRegistry | null = null;

/** Create a fresh registry and install it as current — one per render / startScene(). */
export function createUnitRegistry(opts: UnitRegistryOptions): UnitRegistry {
  currentRegistry = new UnitRegistry(opts);
  return currentRegistry;
}

export function getUnitRegistry(): UnitRegistry {
  if (!currentRegistry) {
    currentRegistry = new UnitRegistry({ projectUnit: DEFAULT_LENGTH_UNIT, rootFile: '' });
  }
  return currentRegistry;
}

/** Reinstall a previously captured registry — mirror of setParamRegistry. */
export function setUnitRegistry(registry: UnitRegistry): void {
  currentRegistry = registry;
}

const unitStack: LengthUnit[] = [];

/** The unit of the thing being built: innermost withUnit() scope, else the root document's unit. */
export function getActiveUnit(): LengthUnit {
  if (unitStack.length > 0) {
    return unitStack[unitStack.length - 1];
  }
  return getUnitRegistry().rootUnit;
}

/** Run `fn` with `unit` as the active unit; the scope pops even when `fn` throws. */
export function withUnit<T>(unit: LengthUnit, fn: () => T): T {
  unitStack.push(unit);
  try {
    return fn();
  } finally {
    unitStack.pop();
  }
}
