#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerStartCommand } from './commands/start.js';
import { registerInitCommand } from './commands/init.js';
import { registerServeCommand } from './commands/serve.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerPackCommand } from './commands/pack.js';
import { registerPackageCommand } from './commands/package.js';
import { registerVersionCommand } from './commands/version.js';
import { registerInstallCommand } from './commands/install.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerPackagesCommand } from './commands/packages.js';
import { registerExportCommand } from './commands/export.js';
import { registerLoginCommand } from './commands/login.js';
import { registerPublishCommand } from './commands/publish.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command()
  .name('fluidcad')
  .description('FluidCAD CLI')
  .version(pkg.version);

registerStartCommand(program);
registerInitCommand(program);
registerServeCommand(program);
registerMcpCommand(program);
registerPackCommand(program);
registerPackageCommand(program);
registerVersionCommand(program);
registerInstallCommand(program);
registerRemoveCommand(program);
registerPackagesCommand(program);
registerExportCommand(program);
registerLoginCommand(program);
registerPublishCommand(program);

program.parseAsync(process.argv);
