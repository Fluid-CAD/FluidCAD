# Plan: Extract Code Examples to Separate Files

## Context

The FluidCAD documentation has **159 code blocks across 28 markdown files**. Currently all code is inline in the markdown. We want to extract each code example into its own `.js` file so that:

1. The screenshot generation script (`website/scripts/generate-screenshots.mjs`) can directly run each file to capture screenshots — no fragile markdown parsing or code assembly needed.
2. Code examples are actual runnable files that can be tested, linted, and validated.
3. Docs stay clean and the code is the single source of truth.

## Approach: Docusaurus CodeBlock with raw-loader

Docusaurus supports importing external files as code snippets using `raw-loader`.

### Setup

Install dependency in `website/`:

```bash
cd website && npm install --save raw-loader
```

### Syntax in docs

Rename `.md` files to `.mdx` (required for JSX/import syntax). Then:

```mdx
import CodeBlock from '@theme/CodeBlock';
import extrudeBasic from '!!raw-loader!./_examples/extrude-basic.js';

<CodeBlock language="js">{extrudeBasic}</CodeBlock>
```

Each `.mdx` file imports the code snippets it needs and renders them via the `<CodeBlock>` component with `language="js"` for syntax highlighting.

### File structure

```
website/docs/
├── _examples/                          # Shared/common examples
│   └── default-sketch.js
├── getting-started/
│   ├── _examples/
│   │   ├── first-model-step2.js
│   │   ├── first-model-step4.js
│   │   ├── first-model-step5.js
│   │   └── first-model-final.js
│   └── your-first-model.mdx
├── guides/
│   ├── 3d-operations/
│   │   ├── _examples/
│   │   │   ├── extrude-basic.js
│   │   │   ├── extrude-symmetric.js
│   │   │   ├── extrude-draft.js
│   │   │   ├── extrude-region-pick.js
│   │   │   ├── extrude-no-arg.js
│   │   │   ├── extrude-geometry.js
│   │   │   ├── extrude-fusion.js
│   │   │   ├── cut-basic.js
│   │   │   ├── cut-through.js
│   │   │   ├── cut-draft.js
│   │   │   ├── cut-region-pick.js
│   │   │   ├── cut-geometry.js
│   │   │   ├── cut-fusion.js
│   │   │   ├── revolve-partial.js
│   │   │   ├── revolve-full.js
│   │   │   ├── revolve-half.js
│   │   │   ├── revolve-pick.js
│   │   │   ├── revolve-geometry.js
│   │   │   ├── revolve-fusion.js
│   │   │   ├── loft-two.js
│   │   │   ├── loft-three.js
│   │   │   ├── loft-geometry.js
│   │   │   ├── loft-fusion.js
│   │   │   ├── sweep-basic.js
│   │   │   ├── sweep-geometry.js
│   │   │   ├── sweep-fusion.js
│   │   │   ├── fillet-basic.js
│   │   │   ├── fillet-edges.js
│   │   │   ├── fillet-select.js
│   │   │   ├── fillet-2d.js
│   │   │   ├── chamfer-basic.js
│   │   │   ├── chamfer-asymmetric.js
│   │   │   ├── chamfer-select.js
│   │   │   ├── shell-basic.js
│   │   │   ├── shell-direct.js
│   │   │   ├── shell-multi.js
│   │   │   ├── shell-geometry.js
│   │   │   ├── color-basic.js
│   │   │   ├── color-selection.js
│   │   │   ├── color-fragile.js
│   │   │   ├── parts-basic.js
│   │   │   ├── parts-options.js
│   │   │   └── parts-import.js     (this is two blocks in the doc — keep both in one file with a comment separator, or split)
│   │   ├── extrude.mdx
│   │   ├── cut.mdx
│   │   ├── revolve.mdx
│   │   ├── loft.mdx
│   │   ├── sweep.mdx
│   │   ├── fillet.mdx
│   │   ├── chamfer.mdx
│   │   ├── shell.mdx
│   │   ├── color.mdx
│   │   └── parts.mdx
│   ├── sketching/
│   │   ├── _examples/
│   │   │   └── ... (one file per code block)
│   │   └── *.mdx
│   ├── _examples/
│   │   ├── boolean-autofusion.js
│   │   ├── boolean-separate.js
│   │   ├── boolean-subtract.js
│   │   ├── copy-linear.js
│   │   ├── copy-multi.js
│   │   ├── copy-circular.js
│   │   ├── copy-bolt-pattern.js
│   │   ├── pattern-concept.js
│   │   ├── pattern-linear.js
│   │   ├── pattern-circular.js
│   │   ├── pattern-mirror.js
│   │   ├── pattern-ice-tray.js
│   │   ├── transform-translate.js
│   │   ├── transform-rotate.js
│   │   ├── transform-mirror.js
│   │   ├── selection-direct.js
│   │   ├── selection-select.js
│   │   ├── selection-example.js
│   │   └── ...
│   └── *.mdx
└── tutorials/
    ├── _examples/
    │   ├── lantern-setup.js
    │   ├── lantern-step1.js       # accumulates: setup + step1
    │   ├── lantern-step1-shell.js # accumulates: setup + step1 + shell
    │   ├── lantern-step2.js       # accumulates: all above + windows
    │   ├── lantern-step3.js       # + base
    │   ├── lantern-step4.js       # + top + loft
    │   ├── lantern-final.js       # complete code
    │   └── ...
    └── lantern.mdx
```

The `_examples/` prefix with underscore ensures Docusaurus **does not** treat these directories as doc pages (underscore-prefixed dirs are ignored by the sidebar auto-generator).

## Code example file rules

Each `.js` file must be a **complete, runnable FluidCAD script** with imports:

```js
import { sketch, extrude } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
})

const e = extrude(30)
```

### For fragment examples (code that needs setup but the doc only shows the fragment)

Some doc pages show just the operation without a sketch (e.g., `extrude(40).symmetric()`). The `.js` file should contain the **full runnable code** including the sketch setup:

```js
import { sketch, extrude } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
})

// highlight-next-line
extrude(40).symmetric()
```

Use Docusaurus `// highlight-next-line` or `// highlight-start` / `// highlight-end` comments to highlight only the relevant lines in the rendered docs. This way:
- The file is runnable (has the full sketch + operation).
- The docs show the full code but visually emphasize the key part.

Alternatively, if you want the docs to show ONLY the fragment (no sketch setup visible), you can use the `CodeBlock` `title` prop and only display a portion. But showing full code with highlights is preferred for clarity.

### For progressive tutorials (lantern, first model)

Each step file contains the **complete accumulated code** up to that point. Example: `lantern-step2.js` contains the full code from setup through step 2 (not just step 2's additions).

This means later steps duplicate earlier code. This is intentional — each file is independently runnable, which makes screenshot generation trivial.

### For doc-only code blocks (API references, non-visual)

Some code blocks are API references or non-visual explanations (e.g., `e.endFaces()`, geometry access tables). These stay inline in the markdown — no need to extract them. Only extract code blocks that:
- Produce visual output (geometry)
- Are used for screenshots
- Benefit from being runnable/testable

## Screenshot generation script update

Update `website/scripts/generate-screenshots.mjs` to:

1. Glob all `_examples/**/*.js` files under `website/docs/`
2. For each `.js` file, run it through the FluidCAD server and take a screenshot
3. Save the screenshot to `website/static/img/docs/<section>/<example-name>.png`
4. The filename determines the output path: `_examples/extrude-basic.js` → `img/docs/3d-operations/extrude-basic.png`

The mapping from example file to output image path can use a convention:
- `docs/guides/3d-operations/_examples/foo.js` → `static/img/docs/3d-operations/foo.png`
- `docs/guides/_examples/foo.js` → `static/img/docs/guides/foo.png`
- `docs/tutorials/_examples/foo.js` → `static/img/docs/tutorials/foo.png`
- `docs/getting-started/_examples/foo.js` → `static/img/docs/getting-started/foo.png`

The script becomes much simpler: no markdown parsing, no code assembly, no import detection — just read `.js` files and run them.

### Screenshot options per file

Use a comment convention in the `.js` file to set screenshot options:

```js
// @screenshot showAxes
```

Default options (no annotation needed): `transparent: true, showGrid: true, showAxes: false, autoCrop: true, margin: 20`

### Files that should NOT generate screenshots

Not every `_examples/` file needs a screenshot. Some are for doc display only (e.g., API reference blocks showing geometry access methods). The script should only generate screenshots for files that have a corresponding image reference in the docs. To detect this, the script can:
- Glob for all `![...](/img/docs/...)` in `.mdx` files
- Only process `.js` files whose name matches an existing image reference

OR simpler: generate screenshots for ALL `_examples/` files and let unused ones be harmless. Images not referenced in docs just sit unused — no harm.

## Steps to implement

### 1. Install raw-loader
```bash
cd website && npm install --save raw-loader
```

### 2. Create `_examples/` directories and extract code
For each doc file with code blocks:
1. Create `_examples/` directory next to it (or in the nearest parent)
2. For each code block, create a `.js` file with:
   - Imports (auto-detected or copied from doc)
   - Setup code (sketch, if the block is a fragment)
   - The example code itself
3. Name the file descriptively: `<operation>-<variant>.js`

### 3. Convert `.md` files to `.mdx`
Rename all doc files that will use `<CodeBlock>` imports from `.md` to `.mdx`.

### 4. Update doc files to use CodeBlock imports
Replace inline code blocks with:
```mdx
import CodeBlock from '@theme/CodeBlock';
import extrudeBasic from '!!raw-loader!./_examples/extrude-basic.js';

<CodeBlock language="js">{extrudeBasic}</CodeBlock>
```

Keep non-visual/API-reference code blocks as inline markdown (no extraction needed).

### 5. Update screenshot script
Rewrite `website/scripts/generate-screenshots.mjs` to:
- Glob `docs/**/_examples/*.js`
- For each file, read the code, send to server, take screenshot
- Save to `static/img/docs/<section>/<name>.png`

### 6. Update sidebar config if needed
The `_examples/` directories should be automatically ignored by Docusaurus sidebar generation (underscore prefix). Verify this works.

### 7. Verify
- `cd website && npm run build` — docs build cleanly
- `node website/scripts/generate-screenshots.mjs` — all screenshots generate
- Check rendered docs show code with correct syntax highlighting

## Files to modify/create
- **New**: `docs/**/_examples/*.js` — ~159 code example files (only visual ones need to be complete; API refs can stay inline)
- **Renamed**: `docs/**/*.md` → `docs/**/*.mdx` (28 files)
- **Modified**: All `.mdx` files — replace inline code blocks with CodeBlock imports
- **Modified**: `website/scripts/generate-screenshots.mjs` — simplified to glob `.js` files
- **Deleted**: `website/scripts/screenshot-configs.mjs` — no longer needed
- **Modified**: `website/package.json` — add `raw-loader` dependency
