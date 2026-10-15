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
                                           or opened in the desktop app)
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

### The FluidCAD skills

The server ships the companion skills and serves them to the agent, so no
install is needed. It implements the MCP Skills Extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640),
`io.modelcontextprotocol/skills`): every skill file is a resource at
`skill://<name>/<path>` (`skill://fluidcad/SKILL.md`,
`skill://fluidcad/references/traps.md`, ...), `skills/list` and `skills/get`
publish each skill's frontmatter and a sha256 manifest of its files, and
`resources/directory/read` lists a skill directory. A host that supports the
extension shows the served skills next to its local ones and loads them on
demand.

For every other client, the server's startup instructions point at
`skill://fluidcad/SKILL.md` and the `list_skills` / `read_skill(name, file)`
tools return the skills and their `references/` files, always at the version
matching the server.

Clients with native skill support (Claude Code, opencode, ...) can still
install them as skills, which adds automatic triggering from the skill
description:

```bash
npx skills add Fluid-CAD/FluidCAD
```

An installed copy is frozen at install time; re-run the command after
upgrading `fluidcad` to keep it in step with the served version.

Three skills ship with the package, under `mcp/skills/`:

- **fluidcad** — the core modeling loop: read the docs, plan, write the file,
  check the render, resolve filters before writing them, verify with
  screenshots and measurements. Its `references/` folder holds task-specific
  guidance the agent loads on demand (traps, repair loop, verification and
  report, modifying an existing model, sketching, handoff).
- **fluidcad-from-drawing** — layered on top, for building a part from a 2D
  engineering drawing, blueprint, dimension sheet, or an image without
  dimensions.
- **fluidcad-assembly** — layered on top, for multi-part models: `.part.js`
  files with `param()` / `connector()` / `expose()`, `.assembly.js` files with
  `insert()` / `mate()` / `replicate()`, STEP parts, units, and assembly export.

`mcp/tests/skills.test.ts` checks that every tool name a skill mentions is
registered by the server and that the `mcp__FluidCAD__*` prefix in each skill's
frontmatter matches the server name registered above.

---

## Use it

1. Open a workspace in FluidCAD — either in the desktop app, or with
   `fluidcad serve --workspace /path/to/project`. The server registers
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

Two failures are reported, and they are not the same thing:

| `state` | What happened | What is being served |
| --- | --- | --- |
| `compile-error` | The module never ran | The **previous** scene |
| `build-error` | The module ran; one or more features' `build()` threw | The new scene, **missing** that geometry |

A failing feature does not abort the render — the renderer records the message
on that object and carries on — so only `rendered` means the scene matches the
source. On `build-error`, `render.objectErrors` lists every failed feature
(`index`, `id`, `name`, `uniqueKind`, `message`, 1-based `sourceLocation`).
`recompute` and `rollback_to` report the same `state` / `objectErrors` pair
alongside `success`.

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
| Skills          | `list_skills`, `read_skill` (plus SEP-2640 `skills/list`, `skills/get`, `skill://` resources) |
| Inspection      | `get_scene_summary`, `list_shapes`, `get_shape_properties`, `get_face_properties`, `get_edge_properties`, `get_compile_error`, `hit_test`, `resolve_selection`, `measure`, `validate` |
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
│   ├── skills-index.ts  # in-memory index over mcp/skills/ (frontmatter, digests)
│   ├── skills-extension.ts # SEP-2640: skills/list, skills/get, resources/directory/read
│   ├── resources.ts     # MCP resource registration for llm-docs/ and skill://
│   ├── tools/           # one file per tool category
│   └── types.ts
├── skills/              # fluidcad, fluidcad-from-drawing, fluidcad-assembly (served + installable)
├── tests/               # vitest, undici MockAgent
└── package.json
```

The stdio entry point lives in `bin/commands/mcp.js` and is registered by
`bin/fluidcad.js` alongside `init` and `serve`.
