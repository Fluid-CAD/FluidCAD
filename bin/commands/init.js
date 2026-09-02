import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  writeEnginePin,
  writeProjectUnit,
  parseProjectUnit,
  LENGTH_UNITS,
} from '../../server/dist/project-config.js';
import { readPackageVersion } from '../lib/workspace.js';

const INIT_JS = `import { init } from 'fluidcad'\n\nexport default await init()\n`;

const TEST_FLUID_JS = `import { extrude, fillet, rect, shell, sketch } from "fluidcad/core";

sketch("xy", () => {
    rect(100, 50).radius(10).centered();
});

const e = extrude(30);

fillet(4, e.startEdges());

shell(-2, e.endFaces());
`;

const JSCONFIG = JSON.stringify({
  compilerOptions: {
    checkJs: true,
    module: 'node20',
  },
}, null, 2) + '\n';

function runInit(options) {
  const cwd = process.cwd();

  // Validate before touching the disk: a bad unit must not leave a
  // half-scaffolded project behind.
  const unit = options.unit === undefined ? null : parseProjectUnit(options.unit);
  if (options.unit !== undefined && unit === null) {
    console.error(`Unknown length unit '${options.unit}'. Use one of: ${LENGTH_UNITS.join(', ')}.`);
    process.exit(1);
  }

  const initPath = resolve(cwd, 'init.js');
  if (existsSync(initPath)) {
    console.error('init.js already exists in this directory.');
    process.exit(1);
  }

  writeFileSync(initPath, INIT_JS);

  const testPath = resolve(cwd, 'test.fluid.js');
  if (!existsSync(testPath)) {
    writeFileSync(testPath, TEST_FLUID_JS);
  }

  const jsconfigPath = resolve(cwd, 'jsconfig.json');
  if (!existsSync(jsconfigPath)) {
    writeFileSync(jsconfigPath, JSCONFIG);
  }

  // Pin the engine this project is being authored against. Left alone if it
  // already exists — an existing pin is a deliberate choice about which
  // kernel this model's geometry came from, not a stale default to refresh.
  const configPath = resolve(cwd, 'fluidcad.json');
  if (!existsSync(configPath)) {
    writeEnginePin(cwd, readPackageVersion());
  }
  // The unit is only written when asked for: a project without the key is
  // an mm project, and that stays the default. An explicit `--unit` is a
  // deliberate choice, so it does update an existing fluidcad.json.
  if (unit !== null) {
    writeProjectUnit(cwd, unit);
  }

  console.log('FluidCAD initialized.');
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Scaffold init.js, test.fluid.js, jsconfig.json, and fluidcad.json in the current directory')
    .option('--unit <unit>', `project document unit written to fluidcad.json: ${LENGTH_UNITS.join(', ')} (default: mm, key omitted)`)
    .action(runInit);
}
