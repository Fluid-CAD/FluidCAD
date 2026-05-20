import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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

  console.log('FluidCAD initialized.');
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Scaffold init.js, test.fluid.js, and jsconfig.json in the current directory')
    .action(runInit);
}
