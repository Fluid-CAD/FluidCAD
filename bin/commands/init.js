import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  writeEnginePin,
  writeProjectUnit,
  parseProjectUnit,
  LENGTH_UNITS,
} from '../../server/dist/project-config.js';
import { preferredNewProjectUnit } from '../../server/dist/preferences.js';
import { ProjectJsconfig } from '../../server/dist/project-jsconfig.js';
import { ProjectGitignore } from '../../server/dist/project-gitignore.js';
import { readPackageVersion } from '../lib/workspace.js';

const INIT_JS = `import { init } from 'fluidcad'\n\nexport default await init()\n`;

// An empty part, the same shape the editor gives a new part file: everything
// the tools emit lands inside the callback.
const PART_JS = `import { part } from 'fluidcad/core';

export const part1 = part('Part 1', () => {
});
`;

async function runInit(options) {
  const cwd = process.cwd();

  // Validate before touching the disk: a bad unit must not leave a
  // half-scaffolded project behind.
  const explicitUnit = options.unit === undefined ? null : parseProjectUnit(options.unit);
  if (options.unit !== undefined && explicitUnit === null) {
    console.error(`Unknown length unit '${options.unit}'. Use one of: ${LENGTH_UNITS.join(', ')}.`);
    process.exit(1);
  }
  // No `--unit`: the Settings dialog's "default unit for new projects"
  // decides, and it stays null for mm so an untouched preference scaffolds
  // exactly what it always has.
  const unit = explicitUnit ?? (await preferredNewProjectUnit());

  const initPath = resolve(cwd, 'init.js');
  if (existsSync(initPath)) {
    console.error('init.js already exists in this directory.');
    process.exit(1);
  }

  writeFileSync(initPath, INIT_JS);

  const partPath = resolve(cwd, 'part1.part.js');
  if (!existsSync(partPath)) {
    writeFileSync(partPath, PART_JS);
  }

  // checkJs, and deep enough for a pinned package's types (see
  // ProjectJsconfig). An existing one is the user's and stays as it is.
  const jsconfigPath = resolve(cwd, ProjectJsconfig.FILENAME);
  if (!existsSync(jsconfigPath)) {
    writeFileSync(jsconfigPath, ProjectJsconfig.text());
  }

  // `.fluidcad/` is this machine's state for the project (the running
  // engine, the editor's tabs, the panels' choices): kept out of git. A
  // .gitignore is written, or gains the one line; nothing else in it changes.
  ProjectGitignore.ensure(cwd);

  // Pin the engine this project is being authored against. Left alone if it
  // already exists — an existing pin is a deliberate choice about which
  // kernel this model's geometry came from, not a stale default to refresh.
  const configPath = resolve(cwd, 'fluidcad.json');
  if (!existsSync(configPath)) {
    writeEnginePin(cwd, readPackageVersion());
  }
  // The unit is only written when asked for, by the flag or by the stored
  // default: a project without the key is an mm project, and that stays the
  // default. Either is a deliberate choice, so it does update an existing
  // fluidcad.json.
  if (unit !== null) {
    writeProjectUnit(cwd, unit);
  }

  console.log('FluidCAD initialized.');
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Scaffold init.js, an empty part1.part.js, jsconfig.json, and fluidcad.json in the current directory, and keep .fluidcad/ out of git (.gitignore)')
    .option('--unit <unit>', `project document unit written to fluidcad.json: ${LENGTH_UNITS.join(', ')} (default: the Settings dialog's unit for new projects, mm unless changed)`)
    .action(runInit);
}
