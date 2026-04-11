# FluidCAD Neovim Plugin

Neovim integration for the FluidCAD editor. Spawns the same server used by the VS Code extension and exposes the 3D viewport URL so you can view it in a browser.

## Prerequisites

- Neovim >= 0.10
- Node.js >= 23 (with `--experimental-transform-types` support)
- The FluidCAD project dependencies installed (`npm install` from the repo root)

## Installation

### lazy.nvim

```lua
{
  "Fluid-CAD/FluidCAD",
  config = function()
    require("fluidcad").setup()
  end,
  ft = { "javascript" },
}
```

### Manual / development

Add the plugin directory to your runtimepath in `init.lua`:

```lua
vim.opt.rtp:prepend("~/projects/cad/extension/neovim")
require("fluidcad").setup()
```

## Setup Options

```lua
require("fluidcad").setup({
  -- Path to bridge.js. Auto-detected from plugin install path by default.
  bridge_path = nil,

  -- Automatically start the server when opening a .fluid.js file.
  auto_start = true,

  -- Automatically open the browser when the server is ready.
  open_browser = true,

  -- Debounce interval (ms) for live-update on text changes.
  debounce_ms = 300,
})
```

## Commands

| Command                   | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `:FluidCadStart`          | Start the FluidCAD server for the current working directory |
| `:FluidCadStop`           | Stop the FluidCAD server                                  |
| `:FluidCadUrl`            | Print the server URL and copy it to the `+` register      |
| `:FluidCadOpenBrowser`    | Open the server URL in your default browser               |
| `:FluidCadProcessFile`    | Send the current `.fluid.js` file to the server           |
| `:FluidCadRollback <n>`   | Rollback the scene to operation index `n`                 |
| `:FluidCadImport <path>`  | Import a STEP file (`.step` / `.stp`)                     |
| `:FluidCadLog`            | Open server logs in a scratch buffer                      |

## Usage

1. Open a workspace that contains `.fluid.js` files:

   ```
   nvim ~/my-project/part.fluid.js
   ```

2. If `auto_start` is enabled (the default), the server starts automatically. Otherwise run `:FluidCadStart`.

3. Get the viewer URL:

   ```
   :FluidCadUrl
   ```

   This prints the URL (e.g. `http://localhost:3142`) and copies it to your clipboard.

4. Open it in a browser:

   ```
   :FluidCadOpenBrowser
   ```

5. Edit your `.fluid.js` file — changes are sent to the server as you type (debounced) and on every save. The browser view updates in real time.

## Testing the Bridge Standalone

You can test the bridge outside of Neovim to verify the server works:

```bash
# From the repo root — send a process-file message and observe JSON output
echo '{"type":"process-file","filePath":"/absolute/path/to/file.fluid.js"}' \
  | node extension/neovim/bridge.js /path/to/workspace
```

You should see JSON lines on stdout like:

```json
{"type":"ready","url":"http://localhost:3142"}
{"type":"init-complete","success":true}
{"type":"scene-rendered","absPath":"/absolute/path/to/file.fluid.js","result":[...]}
```

Server logs go to stderr, so they won't interfere with the JSON protocol.

## Architecture

```
Neovim ←→ (stdin/stdout JSON lines) ←→ bridge.js ←→ (Node IPC) ←→ server
```

The bridge (`bridge.js`) is a thin Node.js script that:

- Forks the FluidCAD server using `child_process.fork()` (same mechanism as the VS Code extension)
- Translates JSON lines on stdin into Node IPC messages sent to the server
- Translates IPC messages from the server into JSON lines on stdout
- Pipes server stdout/stderr to bridge stderr so they don't interfere with the protocol

This means the server requires zero changes — the same server process works for both VS Code and Neovim.
