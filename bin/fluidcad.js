#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerInitCommand } from './commands/init.js';
import { registerServeCommand } from './commands/serve.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerPackCommand } from './commands/pack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command()
  .name('fluidcad')
  .description('FluidCAD CLI')
  .version(pkg.version);

registerInitCommand(program);
registerServeCommand(program);
registerMcpCommand(program);
registerPackCommand(program);

program.parseAsync(process.argv);
