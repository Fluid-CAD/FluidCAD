# FluidCAD MCP server

An [MCP](https://modelcontextprotocol.io) server that lets LLM agents drive a
running FluidCAD workspace — take screenshots, inspect geometry, edit `.fluid.js`
source files, and look up the FluidCAD API by symbol or keyword.

The server is transport-agnostic. It currently ships a stdio transport via
`fluidcad mcp`; an HTTP transport will be added when there is demand.

---

## How it talks to FluidCAD

```
  Claude Desktop / Code / Cursor          (MCP client)
                  │ stdio
                  ▼
        fluidcad mcp  (this package)      (MCP server)
                  │ HTTP + WS
                  ▼
       running FluidCAD server            (the workspace you started with `fluidcad serve`
                                           or by opening a .fluid.js file in VSCode)
```

The MCP process is a thin proxy. It does not run OpenCascade itself — it
connects to whatever FluidCAD instance you already have running, so the agent
and the user share the same scene manager, the same OCC shape cache, and the
same camera.

Multiple FluidCAD instances on one machine are discovered through the
per-user registry at `~/.fluidcad/instances.json`, which each running server
maintains automatically.

---

## Install

The MCP server is bundled with the main `fluidcad` package. If you have
`fluidcad` installed (locally in a project or globally), you have `fluidcad mcp`.

```bash
npm install fluidcad        # local — recommended for project-scoped agents
# or
npm install -g fluidcad     # global — recommended for desktop MCP clients
```

No separate install is needed.

### Wire it into an MCP client

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "FluidCAD": {
      "command": "npx",
      "args": ["-y", "fluidcad", "mcp"]
    }
  }
}
```

**Claude Code** — register the server with the CLI at **user scope** so it's
available across every project, not just the directory you ran the command in:

```bash
claude mcp add --scope user FluidCAD -- npx -y fluidcad mcp
```

Omit `--scope user` (the default `local` scope) only if you want the server
restricted to one project. Use `--scope project` to commit the entry to
`.mcp.json` and share it with your team.

**Cursor** — add to `~/.cursor/mcp.json` (or the workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "FluidCAD": {
      "command": "npx",
      "args": ["-y", "fluidcad", "mcp"]
    }
  }
}
```

**opencode** — `opencode mcp add` is interactive and will prompt you
through the fields. Run it and answer:

```
$ opencode mcp add
? Enter MCP server name: FluidCAD
? Select MCP server type: Local
? Enter command to run: npx -y fluidcad mcp
```

Or skip the prompts and edit `~/.config/opencode/opencode.json` (or a
project-local `opencode.json`) by hand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "FluidCAD": {
      "type": "local",
      "command": ["npx", "-y", "fluidcad", "mcp"],
      "enabled": true
    }
  }
}
```

For a globally installed `fluidcad`, replace `npx -y fluidcad mcp` with
`fluidcad mcp` in any of the configs above (the opencode `command` array
becomes `["fluidcad", "mcp"]`).

### Install the FluidCAD skill

The MCP ships with a companion **FluidCAD skill** (in `mcp/skills/FluidCAD/`)
that gives agents the workflow and best practices for driving the MCP — when
to call `list_workspaces` first, how to resolve unfamiliar types, how to recover
from `compile-error`, etc. Install it into your Claude Code skills directory:

```bash
npx skills add Fluid-CAD/FluidCAD
```

Once installed, Claude Code will load the skill automatically whenever the
FluidCAD MCP tools are available and the task involves CAD modeling.

---

## Use it

1. Open a workspace in FluidCAD — either through the VSCode/Neovim extension,
   or with `fluidcad serve --workspace /path/to/project`. The server registers
   itself in `~/.fluidcad/instances.json` on startup.
2. Start a conversation in your MCP client. The agent should call
   `list_workspaces` first to find your workspace, then pass that path to
   subsequent tools.
3. Useful first prompts:
   - *"Take a screenshot of the iso-ftr view of my workspace."*
   - *"What does the `extrude` API look like?"* (uses `get_api_signature`)
   - *"What is a `PlaneLike`?"* (uses `get_type_definition`)
   - *"List every `.fluid.js` file in the workspace, then show me the shapes
     in the current scene."*

`get_api_signature` returns the first code block of a function/filter doc.
`get_type_definition` is the parallel for *type* names — given `PlaneLike`,
`SceneObject`, `LinearRepeatOptions`, etc. it returns the TypeScript
definition, the accepted forms (for union/literal aliases), the method or
property table, and the doc body. Use it whenever a signature mentions a
type whose meaning isn't obvious.

Tools that trigger a re-render (`write_file`, `edit_range`, `recompute`,
`rollback_to`, `import_step`) are synchronous — they return once the render
settles. `write_file` and `edit_range` additionally carry the render outcome
under `render`. The agent should inspect `render.state` and surface any
`compile-error` to the user before retrying.

---

## Test locally

### 1. Sanity check: build and run with the MCP inspector

The official inspector is the fastest way to verify every tool is registered
and responsive.

```bash
# from the repo root
npm install
npm run build:mcp                 # produces mcp/dist/server.js

npx @modelcontextprotocol/inspector node bin/fluidcad.js mcp
```

The inspector opens a browser UI. You can list tools, call each one, and see
the JSON / image response. Try `list_workspaces` first — it works even with no
FluidCAD workspaces running (returns an empty array).

To exercise the full surface, start a workspace in another terminal first:

```bash
node bin/fluidcad.js serve --workspace /path/to/some/project
```

Then call `list_workspaces` in the inspector — the workspace should appear
with `alive: true`. From there, `screenshot`, `list_shapes`, `get_scene_summary`
and so on should all return real data.

### 2. Run the unit tests

The MCP package has a vitest suite covering discovery, the docs index, the
tool handlers, and the server wiring.

```bash
# all MCP tests
npx vitest run mcp/tests

# one file
npm test -- mcp/tests/tools.screenshot.test.ts
```

The tests stub the running FluidCAD server with `undici`'s `MockAgent`, so
they do not need a real workspace open.

### 3. End-to-end smoke test

A quick way to confirm a full installation works against a real workspace:

```bash
# terminal 1
node bin/fluidcad.js serve --workspace examples/

# terminal 2 — send `list_workspaces` over stdio and check the JSON-RPC reply
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_workspaces","arguments":{}}}' \
  | node bin/fluidcad.js mcp
```

You should see two JSON-RPC responses on stdout: the `initialize` reply and a
`tools/call` reply listing your running workspace.

---

## Tool surface (at a glance)

| Category        | Tools                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Discovery       | `list_workspaces`                                                     |
| Docs            | `list_docs`, `read_doc`, `search_docs`, `get_api_signature`, `get_type_definition` |
| Inspection      | `get_scene_summary`, `list_shapes`, `get_shape_properties`, `get_face_properties`, `get_edge_properties`, `get_compile_error`, `hit_test` |
| Visual          | `screenshot`, `screenshot_multi`, `screenshot_shape`, `get_camera_state` |
| Coordination    | `wait_for_idle`                                                       |
| Source editing  | `list_fluid_files`, `read_file`, `write_file`, `edit_range`           |
| Engine control  | `recompute`, `rollback_to`, `add_breakpoint`, `clear_breakpoints`, `import_step`, `export` |

Tool descriptions and full input schemas are available via the MCP inspector
or any compliant client.

---

## Development

```bash
npm run build:mcp          # tsc -p mcp/tsconfig.json
npx vitest run mcp/tests   # tests
```

Layout:

```
mcp/
├── src/
│   ├── server.ts        # buildServer() + runStdio() — transport-agnostic core
│   ├── discovery.ts     # read-only access to ~/.fluidcad/instances.json
│   ├── client.ts        # HTTP/WS helpers for talking to the FluidCAD server
│   ├── docs-index.ts    # frontmatter-driven in-memory doc index
│   ├── resources.ts     # MCP resource registration for llm-docs/
│   ├── tools/           # one file per tool category
│   └── types.ts
├── tests/               # vitest, undici MockAgent
└── package.json
```

The stdio entry point lives in `bin/commands/mcp.js` and is registered by
`bin/fluidcad.js` alongside `init` and `serve`.
