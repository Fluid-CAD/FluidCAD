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

const BOX_PART_JS = `import { arc, line, extrude, shell, sketch, part } from "fluidcad/core";
import { radius, distance, equal, vertical, horizontal, tangent, coincident } from 'fluidcad/constraints';


export const box = part("Box", () => {
    sketch("xy", () => {
      const l1 = line([-30, -20], [30, -20]);
      const a1 = arc([30, -20], [40, -10], [30, -10]);
      const l2 = line([40, -10], [40, 10]);
      const a2 = arc([40, 10], [30, 20], [30, 10]);
      const l3 = line([30, 20], [-30, 20]);
      const a3 = arc([-30, 20], [-40, 10], [-30, 10]);
      const l4 = line([-40, 10], [-40, -10]);
      const a4 = arc([-40, -10], [-30, -20], [-30, -10]);
      coincident(l1.end(), a1.start());
      coincident(a1.end(), l2.start());
      coincident(l2.end(), a2.start());
      coincident(a2.end(), l3.start());
      coincident(l3.end(), a3.start());
      coincident(a3.end(), l4.start());
      coincident(l4.end(), a4.start());
      coincident(a4.end(), l1.start());
      tangent(l1, a1);
      tangent(a1, l2);
      tangent(l2, a2);
      tangent(a2, l3);
      tangent(l3, a3);
      tangent(a3, l4);
      tangent(l4, a4);
      tangent(a4, l1);
      horizontal(l1);
      horizontal(l3);
      vertical(l2);
      vertical(l4);
      equal(a1, a2);
      equal(a1, a3);
      equal(a1, a4);
      distance(l4, l2, 80);
      radius(a1, 10);    
    });

    const e = extrude(25);
    shell(-2, e.endFaces());
});
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

  const partPath = resolve(cwd, 'box.part.js');
  if (!existsSync(partPath)) {
    writeFileSync(partPath, BOX_PART_JS);
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
    .description('Scaffold init.js, box.part.js, jsconfig.json, and fluidcad.json in the current directory')
    .option('--unit <unit>', `project document unit written to fluidcad.json: ${LENGTH_UNITS.join(', ')} (default: mm, key omitted)`)
    .action(runInit);
}
