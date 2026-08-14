import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { writeEnginePin } from '../../server/dist/project-config.js';
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

function runInit() {
  const cwd = process.cwd();

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

  console.log('FluidCAD initialized.');
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Scaffold init.js, test.fluid.js, jsconfig.json, and fluidcad.json in the current directory')
    .action(runInit);
}
