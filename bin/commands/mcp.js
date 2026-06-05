import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(__dirname, '..', '..', 'mcp', 'dist', 'server.js');

async function runMcp() {
  // stdout is reserved for the MCP protocol. Any incidental console.log from
  // FluidCAD internals would corrupt the stream — route everything to stderr.
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);

  // file:// URL required: Windows ESM loader rejects bare drive paths (D:\...).
  const mod = await import(pathToFileURL(mcpEntry).href);
  if (typeof mod.runStdio !== 'function') {
    console.error('mcp/dist/server.js does not export runStdio.');
    process.exit(1);
  }
  await mod.runStdio();
}

export function registerMcpCommand(program) {
  program
    .command('mcp')
    .description('Run the FluidCAD MCP server over stdio (for Claude Desktop, Claude Code, Cursor, ...)')
    .action(async () => {
      try {
        await runMcp();
      } catch (err) {
        console.error(err?.stack || err?.message || String(err));
        process.exit(1);
      }
    });
}
