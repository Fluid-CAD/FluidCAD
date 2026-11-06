import fs from 'fs';
import path from 'path';
import { PROJECT_CONFIG_FILENAME, writeEnginePin, writeProjectUnit, type LengthUnit } from './project-config.ts';
import { ProjectGitignore } from './project-gitignore.ts';
import { ProjectJsconfig } from './project-jsconfig.ts';

/** A refusal of `fluidcad init`, worded for the terminal. */
export class ProjectScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectScaffoldError';
  }
}

/**
 * What a scaffold is told: the project's document unit (null for mm, the
 * unit a project without the key has, so nothing is written) and the
 * engine version to pin.
 */
export type ScaffoldOptions = { unit: LengthUnit | null; engineVersion: string };

/**
 * What `fluidcad init` writes into a folder: `init.js` (what calls the
 * engine's `init()`; without it no model renders), an empty `part1.part.js`,
 * `jsconfig.json`, `.gitignore` with `.fluidcad/`, and `fluidcad.json`
 * pinning the engine and, when asked for, the unit. A file the folder
 * already has is the user's and stays as it is, `init.js` excepted: a
 * folder with one is a project already, and the scaffold refuses it before
 * writing anything.
 *
 * The shape lives here, once, so the package scaffold (`PackageScaffold`,
 * ui-packages-plan U3) builds on the same steps and the CLI in `bin/` is a
 * thin wrapper over the compiled class.
 */
export class ProjectScaffold {
  static readonly INIT_FILE = 'init.js';
  /** The starter part; a scaffold that lays it out elsewhere (the package's `parts/`) overrides it. */
  static readonly PART_FILE: string = 'part1.part.js';

  static readonly INIT_JS = `import { init } from 'fluidcad'\n\nexport default await init()\n`;

  /**
   * An empty part, the same shape the editor gives a new part file:
   * everything the tools emit lands inside the callback.
   */
  static readonly PART_JS = `import { part } from 'fluidcad/core';

export const part1 = part('Part 1', () => {
});
`;

  /** The files a fresh folder gets, in the order they are written. */
  static plan(): string[] {
    return [
      ProjectScaffold.INIT_FILE,
      ProjectScaffold.PART_FILE,
      ProjectJsconfig.FILENAME,
      ProjectGitignore.FILENAME,
      PROJECT_CONFIG_FILENAME,
    ];
  }

  /** Scaffold a plain project; the paths it wrote or added to, workspace-relative. */
  static write(workspacePath: string, options: ScaffoldOptions): string[] {
    ProjectScaffold.refuseProject(workspacePath);
    return [
      ...ProjectScaffold.writeInit(workspacePath),
      ...ProjectScaffold.writePart(workspacePath, ProjectScaffold.PART_FILE),
      ...ProjectScaffold.writeTooling(workspacePath),
      ...ProjectScaffold.writeConfig(workspacePath, options),
    ];
  }

  /** A folder with an `init.js` is a project already. */
  protected static refuseProject(workspacePath: string): void {
    if (fs.existsSync(path.join(workspacePath, ProjectScaffold.INIT_FILE))) {
      throw new ProjectScaffoldError(`${ProjectScaffold.INIT_FILE} already exists in this directory.`);
    }
  }

  protected static writeInit(workspacePath: string): string[] {
    fs.writeFileSync(path.join(workspacePath, ProjectScaffold.INIT_FILE), ProjectScaffold.INIT_JS);
    return [ProjectScaffold.INIT_FILE];
  }

  /** The empty starter part at `rel` (its folder created), unless a file is already there: that one is the user's. */
  protected static writePart(workspacePath: string, rel: string): string[] {
    const partPath = path.join(workspacePath, rel);
    if (fs.existsSync(partPath)) {
      return [];
    }
    fs.mkdirSync(path.dirname(partPath), { recursive: true });
    fs.writeFileSync(partPath, ProjectScaffold.PART_JS);
    return [rel];
  }

  /**
   * `jsconfig.json` (checkJs, and deep enough for a pinned package's types,
   * see ProjectJsconfig; an existing one is the user's and stays as it is)
   * and `.gitignore`: `.fluidcad/` is this machine's state for the project
   * (the running engine, the editor's tabs, the panels' choices), kept out
   * of git. A .gitignore is written, or gains the one line; nothing else in
   * it changes.
   */
  protected static writeTooling(workspacePath: string): string[] {
    const written: string[] = [];
    const jsconfigPath = path.join(workspacePath, ProjectJsconfig.FILENAME);
    if (!fs.existsSync(jsconfigPath)) {
      fs.writeFileSync(jsconfigPath, ProjectJsconfig.text());
      written.push(ProjectJsconfig.FILENAME);
    }
    if (ProjectGitignore.ensure(workspacePath) !== 'present') {
      written.push(ProjectGitignore.FILENAME);
    }
    return written;
  }

  /**
   * Pin the engine this project is being authored against, left alone if a
   * `fluidcad.json` already exists: an existing pin is a deliberate choice
   * about which kernel this model's geometry came from, not a stale default
   * to refresh. The unit is only written when asked for: a project without
   * the key is an mm project, and that stays the default. Either is a
   * deliberate choice, so it does update an existing fluidcad.json.
   */
  protected static writeConfig(workspacePath: string, options: ScaffoldOptions): string[] {
    let written = false;
    if (!fs.existsSync(path.join(workspacePath, PROJECT_CONFIG_FILENAME))) {
      writeEnginePin(workspacePath, options.engineVersion);
      written = true;
    }
    if (options.unit !== null) {
      writeProjectUnit(workspacePath, options.unit);
      written = true;
    }
    return written ? [PROJECT_CONFIG_FILENAME] : [];
  }
}
