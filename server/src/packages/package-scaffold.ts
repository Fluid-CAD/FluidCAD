import fs from 'fs';
import path from 'path';
import { PROJECT_CONFIG_FILENAME, writePackageInfo } from '../project-config.ts';
import { ProjectGitignore } from '../project-gitignore.ts';
import { ProjectJsconfig } from '../project-jsconfig.ts';
import { ProjectScaffold, ProjectScaffoldError, type ScaffoldOptions } from '../project-scaffold.ts';
import { PackageAuthoring } from './package-authoring.ts';
import { PackageLayout, type PackageFolder } from './package-manifest.ts';

/** A package scaffold's inputs: the project's, plus the package's name (`@acme/kit`). */
export type PackageScaffoldOptions = ScaffoldOptions & { name: string };

/**
 * `fluidcad init --package @acme/kit` (ui-packages-plan U3/U4): a new
 * package workspace in one command. Everything a plain project gets, laid
 * out the way a package ships (HD20): the starter part in `parts/`, since
 * the layout decides what is exported; `features/` and `assemblies/`
 * created empty; a `README.md` with the package's name as its heading; and
 * the `package` block (`name`, version 0.1.0) beside the engine pin and the
 * unit in `fluidcad.json`. The start screen's New Package (Stage N2) runs
 * this through the launcher, so the rules live here and not in a dialog.
 *
 * A package is only ever created new (U1: nothing converts a project), so a
 * folder holding anything but dot-entries (`.git`, a `.gitignore`) is
 * refused before a byte is written. The name follows `PackageAuthoring`'s
 * rules: scoped and valid, a bare name refused with the sentence saying to
 * add the handle.
 */
export class PackageScaffold extends ProjectScaffold {
  /** The version a new package starts at. */
  static readonly INITIAL_VERSION = PackageAuthoring.INITIAL_VERSION;

  /** The starter part, in the folder a package ships its parts from. */
  static readonly PART_FILE = `parts/${ProjectScaffold.PART_FILE}`;

  static readonly README_FILE = 'README.md';

  /** The layout folders created empty: the ones the starter part doesn't already make. */
  static readonly EMPTY_FOLDERS: readonly PackageFolder[] = PackageLayout.FOLDERS.filter((folder) => folder !== 'parts');

  /** What a fresh folder gets, in the order it is written; a folder ends with `/`. */
  static plan(): string[] {
    return [
      ProjectScaffold.INIT_FILE,
      PROJECT_CONFIG_FILENAME,
      PackageScaffold.PART_FILE,
      ...PackageScaffold.EMPTY_FOLDERS.map((folder) => `${folder}/`),
      PackageScaffold.README_FILE,
      ProjectJsconfig.FILENAME,
      ProjectGitignore.FILENAME,
    ];
  }

  /** Scaffold a package workspace; the paths it wrote, workspace-relative, as {@link plan} lists them. */
  static write(workspacePath: string, options: PackageScaffoldOptions): string[] {
    const problem = PackageAuthoring.nameProblem(options.name);
    if (problem !== null) {
      throw new ProjectScaffoldError(problem);
    }
    PackageScaffold.refuseNonEmpty(workspacePath);

    const written = [
      ...ProjectScaffold.writeInit(workspacePath),
      ...ProjectScaffold.writeConfig(workspacePath, options),
    ];
    writePackageInfo(workspacePath, { name: options.name, version: PackageScaffold.INITIAL_VERSION });
    written.push(...ProjectScaffold.writePart(workspacePath, PackageScaffold.PART_FILE));
    for (const folder of PackageScaffold.EMPTY_FOLDERS) {
      fs.mkdirSync(path.join(workspacePath, folder), { recursive: true });
      written.push(`${folder}/`);
    }
    fs.writeFileSync(path.join(workspacePath, PackageScaffold.README_FILE), PackageScaffold.readme(options.name));
    written.push(PackageScaffold.README_FILE);
    written.push(...ProjectScaffold.writeTooling(workspacePath));
    return written;
  }

  /** The README a new package starts with: its name as the heading. */
  static readme(name: string): string {
    return `# ${name}\n`;
  }

  /** The folder must hold nothing visible; dot-entries (`.git`, a `.gitignore`, `.DS_Store`) don't count. */
  private static refuseNonEmpty(workspacePath: string): void {
    const visible = fs.readdirSync(workspacePath).filter((entry) => !entry.startsWith('.')).sort();
    if (visible.length === 0) {
      return;
    }
    const shown = visible.slice(0, 3).join(', ');
    const more = visible.length > 3 ? ` and ${visible.length - 3} more` : '';
    throw new ProjectScaffoldError(`This directory is not empty (${shown}${more}). A new package needs an empty directory.`);
  }
}
