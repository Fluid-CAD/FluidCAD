# FluidCAD

**Write CAD models in JavaScript. See the result in real time.**

> FluidCAD is under active development. APIs and features may change as the project evolves.

<!-- ![FluidCAD Demo](docs/assets/demo.gif) -->

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

<!-- ![CAD Workflow](docs/assets/workflow.gif) -->

### Modeling History

Navigate through your modeling history step by step. Review how any model was built and roll back to any point in the feature tree.

<!-- ![Modeling History](docs/assets/history.gif) -->

### Interactive Prototyping

Some operations support interactive mouse-driven input directly in the viewport, letting you prototype faster without writing every parameter by hand.

<!-- ![Interactive Features](docs/assets/interactive.gif) -->

### Feature Transforms

Re-apply modeling features based on matrix transformations. Move, rotate, or mirror entire feature sequences to build complex geometry from simple building blocks.

<!-- ![Feature Transforms](docs/assets/transforms.gif) -->

### Pattern Copying

Duplicate features in linear or circular patterns to quickly populate repetitive geometry.

### Smart Defaults

Most operations just do the right thing without extra arguments. `extrude` picks up the last sketch, `fillet` targets the last selection, and touching shapes are automatically fused -- less boilerplate, more readable code.

### STEP Import / Export

Import and export STEP files with full color support. Bring in existing CAD models or share your designs with any standard CAD tool.

<!-- ![STEP Import/Export](docs/assets/step.gif) -->

### Use Your Favorite Editor

FluidCAD ships official extensions for **VS Code** and **Neovim**, but works with any editor -- just point the CLI at your project.

---

## Getting Started

### 1. Create a New Project

```bash
npm create fluidcad-app@latest my-app
cd my-app
npm install
```

This scaffolds a project with a sample `.fluid.js` file ready to go.

### 2. Set Up Your Editor

<details>
<summary><strong>VS Code</strong></summary>

1. Install the **FluidCAD** extension from the VS Code Marketplace.
2. Open your project folder in VS Code.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Show FluidCAD Scene**.

The 3D viewport opens in a side panel and updates live as you edit `.fluid.js` files.

</details>

<details>
<summary><strong>Neovim</strong></summary>

Add the plugin with [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "fluidcad/fluidcad",
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

Run the FluidCAD server directly:

```bash
npx fluidcad -w ./my-app
```

This starts a local server and opens a 3D viewport in your browser. Edit your `.fluid.js` files in any editor -- the viewport updates on save.

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-w, --workspace <path>` | Path to your project | Current directory |
| `-p, --port <port>` | Server port | `3100` |

</details>

---

## License

LGPL-2.1
