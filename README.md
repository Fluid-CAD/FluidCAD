<p align="center">
  <img src="https://fluidcad.io/img/logo.png" alt="FluidCAD Logo" width="120" />
</p>

<h1 align="center">FluidCAD</h1>

<p align="center"><strong>Write CAD models in JavaScript. See the result in real time.</strong></p>

<p align="center">
  <a href="https://fluidcad.io/docs/getting-started">Getting Started</a> &middot;
  <a href="https://fluidcad.io/docs/tutorials/">Tutorials</a> &middot;
  <a href="https://fluidcad.io/docs/guides">Guides</a>
</p>

> FluidCAD is under active development. APIs and features may change as the project evolves.
>
> I'm not accepting pull requests just yet -- I'm still finalizing the design and putting together a roadmap. Once I hit **v0.1.0**, I'd love to have contributions from the community. Stay tuned!

---

## Under the Hood

FluidCAD is built on [OpenCascade](https://dev.opencascade.org/), a full B-Rep (boundary representation) modeling kernel, through the [opencascade.js](https://ocjs.org/) WebAssembly binding. This means precise, production-grade geometry -- exact edges, fillets, and booleans -- not mesh approximations.

A huge thanks to the [opencascade.js](https://ocjs.org/) team for making this possible.

---

## Features

### Code-Driven 3D Modeling

Design parametric 3D models using JavaScript. Every change in your code is reflected instantly in the 3D viewport.

```js
import { extrude, fillet, sketch } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)

fillet(5, e.startEdges())
```

### Traditional CAD Workflow

A modeling workflow that feels familiar to users of mainstream CAD software -- sketches, extrusions, fillets, shells, booleans, and more -- all driven by code.

### Modeling History

Navigate through your modeling history step by step. Review how any model was built and roll back to any point in the feature tree.

<p align="center">
  <img src="https://fluidcad.io/img/history.gif" alt="FluidCAD History" />
</p>

### Interactive Prototyping

Some operations support interactive mouse-driven input directly in the viewport, letting you prototype faster without writing every parameter by hand.

<p align="center">
  <img src="https://fluidcad.io/img/region-extrude.gif" alt="FluidCAD Region Extrude" />
</p>

### Feature Transforms

Re-apply modeling features based on matrix transformations. Move, rotate, or mirror entire feature sequences to build complex geometry from simple building blocks.

```javascript
sketch("xy", () => {
    rect(200, 100).centered()
})

const e1 = extrude(20)

sketch(e1.endFaces(), () => {
    circle([-80, 30], 30)
});

const pin = extrude(10)

const f = chamfer(2, pin.endEdges());

repeat("linear", ["x", "y"], {
    count: [4, 2],
    length: [160, -60]
}, pin, f)

```
<p align="center">
  <img src="https://fluidcad.io/img/repeat.png" alt="FluidCAD Repeat Feature" />
</p>


### Pattern Copying

Duplicate features in linear or circular patterns to quickly populate repetitive geometry.

### Smart Defaults

Most operations just do the right thing without extra arguments. `extrude` picks up the last sketch, `fillet` targets the last selection, and touching shapes are automatically fused -- less boilerplate, more readable code.

### STEP Import / Export

Import and export STEP files with full color support. Bring in existing CAD models or share your designs with any standard CAD tool.

<p align="center">
  <img src="https://fluidcad.io/img/step-import.png" alt="FluidCAD Step Import" />
</p>

### Use Your Favorite Editor

FluidCAD ships official extensions for **VS Code** and **Neovim**, but works with any editor -- just point the CLI at your project.

### LLM / AI Agent Integration (MCP)

FluidCAD ships an [MCP](https://modelcontextprotocol.io) server so AI agents (Claude Code, Claude Desktop, Cursor, opencode, etc.) can drive a running workspace -- take screenshots, inspect geometry, edit `.fluid.js` files, and look up the API by symbol. See [Set Up the MCP Server](#3-optional-set-up-the-mcp-server) below.


---

## Tutorials

Step-by-step tutorials from simple shapes to exam-level parts. [Browse all tutorials &rarr;](https://fluidcad.io/docs/tutorials/)

<table>
  <tr>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/lantern">
        <img src="https://fluidcad.io/img/docs/tutorials/lantern-final.png" alt="Lantern" height="180" /><br />
        <strong>Lantern</strong>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/ice-cube-tray">
        <img src="https://fluidcad.io/img/docs/tutorials/ice-cube-tray-final.png" alt="Ice Cube Tray" height="180" /><br />
        <strong>Ice Cube Tray</strong>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/grooved-box">
        <img src="https://fluidcad.io/img/docs/tutorials/grooved-box-final.png" alt="Grooved Box" height="180" /><br />
        <strong>Grooved Box</strong>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/flange-with-notch">
        <img src="https://fluidcad.io/img/docs/tutorials/flange-with-notch-final.png" alt="Flange With Notch" height="180" /><br />
        <strong>Flange With Notch</strong>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/cswp-sample-exam">
        <img src="https://fluidcad.io/img/docs/tutorials/cswp-sample-exam-final.png" alt="CSWP Sample Exam" height="180" /><br />
        <strong>CSWP Sample Exam</strong>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://fluidcad.io/docs/tutorials/hinge-bracket">
        <img src="https://fluidcad.io/assets/images/hinge-bracket-final-137547b475db21736d78b5b13f8db48b.png" alt="Hinge Bracket" height="180" /><br />
        <strong>Hinge Bracket</strong>
      </a>
    </td>
  </tr>
</table>

---

## Getting Started

### 1. Create a New Project

```bash
mkdir my-app && cd my-app
npm init -y
npm install fluidcad
npx fluidcad init
```

This generates `init.js` and `jsconfig.json` to get you started.

### File extensions

FluidCAD recognizes two source-file extensions:

- `*.part.js` — a **part-design** file. Code defines geometry; every edit
  rebuilds the model and updates the viewport.
- `*.assembly.js` — an **assembly driver** file. Code references parts and
  declares mates between them; the viewport then lets you manipulate the
  result interactively.

`*.fluid.js` continues to work as a back-compat alias for `*.part.js`, so
existing projects keep running unchanged.

### 2. Set Up Your Editor

<details>
<summary><strong>VS Code</strong></summary>

1. Install the **FluidCAD** extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=FluidCAD.fluidcad).
2. Open your project folder in VS Code.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Show FluidCAD Scene**.

The 3D viewport opens in a side panel and updates live as you edit `.fluid.js` files.

</details>

<details>
<summary><strong>Neovim</strong></summary>

Add the plugin with [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "Fluid-CAD/FluidCAD",
  config = function()
    require("fluidcad").setup()
  end,
  ft = { "javascript" },
}
```

Open a `.fluid.js` file and the server starts automatically. Run `:FluidCadOpenBrowser` to open the 3D viewport in your browser.

See the full list of commands in the [Neovim plugin README](extension/neovim/README.md).

</details>

<details>
<summary><strong>Any Other Editor</strong></summary>

From your project directory, run the FluidCAD server directly:

```bash
npx fluidcad serve
```

This starts a local server and opens a 3D viewport in your browser. Edit your `.fluid.js` files in any editor -- the viewport updates on save.

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-w, --workspace <path>` | Path to your project | Current directory |
| `-p, --port <port>` | Server port | `3100` |
| `--open` | Open the viewport in your default browser when ready | _off_ |

</details>

### 3. (Optional) Set Up the MCP Server

FluidCAD bundles an [MCP](https://modelcontextprotocol.io) server so LLM agents can drive your workspace -- screenshots, geometry inspection, source edits, API lookup. It's included in the `fluidcad` package; no separate install needed.

Wire it into your MCP client:

<details>
<summary><strong>Claude Code</strong></summary>

Register at user scope so it's available in every project:

```bash
claude mcp add --scope user FluidCAD -- npx -y fluidcad mcp
```

</details>

<details>
<summary><strong>Claude Desktop / Cursor</strong></summary>

Add to `claude_desktop_config.json` or `~/.cursor/mcp.json`:

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

</details>

<details>
<summary><strong>opencode</strong></summary>

Run `opencode mcp add` and answer the prompts, or add to `~/.config/opencode/opencode.json`:

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

</details>

Then install the companion skill so agents follow the FluidCAD workflow:

```bash
npx skills add Fluid-CAD/FluidCAD
```

See the [MCP README](mcp/README.md) for the full tool surface, transport details, and local-testing guide.


---

## License

LGPL-2.1
