#!/usr/bin/env node

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';

const projectName = process.argv[2] || 'my-fluidcad-project';
const targetDir = resolve(process.cwd(), projectName);

if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  console.error(`Error: Directory "${projectName}" already exists and is not empty.`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

// package.json
const pkg = {
  name: basename(targetDir),
  version: '0.0.1',
  type: 'module',
  dependencies: {
    fluidcad: 'latest',
  },
};
writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// init.js
const initJs = `import { init } from 'fluidcad'

export default init(import.meta.dirname)
`;
writeFileSync(resolve(targetDir, 'init.js'), initJs);

// jsconfig.json
const jsconfig = {
  compilerOptions: {
    checkJs: true,
    module: 'node20',
  },
};
writeFileSync(resolve(targetDir, 'jsconfig.json'), JSON.stringify(jsconfig, null, 2) + '\n');

// test.fluid.js
const testFluid = `import { extrude, fillet, shell, sketch } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)

shell(-6, e.endFaces())

fillet(5, e.startEdges())
`;
writeFileSync(resolve(targetDir, 'test.fluid.js'), testFluid);

console.log(`\nFluidCAD project created in ./${projectName}\n`);
console.log('Next steps:\n');
console.log(`  cd ${projectName}`);
console.log('  npm install');
console.log('  # Open in VS Code with the FluidCAD extension');
console.log('');
