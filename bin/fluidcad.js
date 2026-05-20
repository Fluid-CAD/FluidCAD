#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerInitCommand } from './commands/init.js';
import { registerServeCommand } from './commands/serve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command()
  .name('fluidcad')
  .description('FluidCAD CLI')
  .version(pkg.version);

registerInitCommand(program);
registerServeCommand(program);

program.parseAsync(process.argv);
