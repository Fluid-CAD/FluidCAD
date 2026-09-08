# Creating FluidCAD Tutorials

Guide for adding new tutorials to the FluidCAD documentation website.

Tutorials are **UI-first** since 2026-09-08 (`desk-organizer.mdx` is the model): the reader builds the part in the FluidCAD workspace and every step is a short click-level instruction with a full-workspace screenshot of that moment — the tool armed, the picks, the ghost preview when the operation has one, the result. The code the dialogs wrote appears once, at the end, inside a `<details>` accordion. The older code-per-step pages remain until converted.

## Directory Structure

```
website/docs/tutorials/
├── index.mdx                              # Tutorial listing page
├── lantern.mdx                            # Example tutorial
├── ice-cube-tray.mdx                      # Example tutorial
└── _examples/
    ├── lantern-final.js                   # Complete code
    ├── lantern-step1.js                   # Cumulative code up to step 1
    ├── ice-cube-tray-final.js
    ├── ice-cube-tray-step1.js
    ├── ice-cube-tray-step5-profile.js     # Sketch-only step (no extrude/cut after)
    └── ...
```

Screenshots are stored at:
```
website/static/img/docs/tutorials/<name>-ui-01-<moment>.png     # UI-first pages: one per moment, numbered in reading order
website/static/img/docs/tutorials/<name>-ui-02-<moment>.png
...
website/static/img/docs/tutorials/<name>-step1.png              # legacy code-first pages (canvas only)
website/static/img/docs/tutorials/<name>-final.png
```

## Step-by-Step Process

### 1. Break the model into logical steps

Read the source `.fluid.js` file and group operations into 4–7 steps. Each step should introduce one or two new concepts. Common groupings:

- Base body (sketch + extrude)
- Cuts/features (sketch + cut + optional repeat/mirror)
- Complex profiles (tangent geometry, projections, constraints)
- Final details (holes, fillets, color)

### 2. Create example code files

All files go in `website/docs/tutorials/_examples/`.

**Naming convention:** `<tutorial-name>-step<N>.js`, `<tutorial-name>-final.js`

**Rules:**
- Each step file is **cumulative** — it contains ALL code from the beginning up to and including that step
- All step files use the **same import line** as the final file (unused imports are fine, this matches the existing pattern)
- The final file contains the complete working code

**Sketch step files** (optional but recommended for steps with interesting sketches):
- Named `<tutorial-name>-step<N>-sketch.js`
- Contains code up to and including the `sketch()` block, but **stops before** the `extrude()`/`cut()` that follows
- Shows the 2D sketch overlaid on the 3D model

### 3. Create the tutorial MDX page

Create `website/docs/tutorials/<tutorial-name>.mdx`. Follow the UI-first template:

```mdx
---
sidebar_position: <next number>
title: "<Tutorial Title>"
---

import CodeBlock from '@theme/CodeBlock';
import finalCode from '!!raw-loader!./_examples/<name>-final.js';
import {OpenInViewer} from '@site/src/components/docs/OpenInViewer';
import {ViewerEmbed} from '@site/src/components/docs/ViewerEmbed';

# Building a <Tutorial Title>

<ViewerEmbed code={finalCode} entry="<name>.fluid.js" />

In this tutorial, you'll build ... based on the [original design by <Author>](<url>). You build it entirely from the FluidCAD workspace ... the [full code](#full-code) at the end is what the UI produced.

## Before you start

Open a workspace and create `<name>.fluid.js` with **+** in the top bar. Then the UI habits used throughout:
- **Ctrl+click** adds to a selection; a plain click replaces it.
- The **constraint bar** appears while sketching; hover a button for its name.
- The **DOF pill** counts what is left; *Fully constrained* when done.
- Each dialog shows the **statement** it will write; **Apply** / <kbd>Enter</kbd> writes it, **Exit** / <kbd>Escape</kbd> discards it.

## Step 1: <Title>

### <Sub-moment, e.g. Start a sketch on the XY plane>

Click **Sketch** ... Click the **XY** plane.

![<what the reader sees>](/img/docs/tutorials/<name>-ui-01-<moment>.png)

### <Next moment: the tool, the picks, the typed value>

Pick the **Polygon** tool ... type `140`, press <kbd>Enter</kbd> ...

![...](/img/docs/tutorials/<name>-ui-02-<moment>.png)

### <The operation with its ghost preview>

Click **Finish Sketch ▾** and choose **Extrude**. Set **Distance** to `110`. The green ghost is the live preview; the statement reads `extrude(110)`.

![...](/img/docs/tutorials/<name>-ui-03-<moment>.png)

Click **Apply**.

![...](/img/docs/tutorials/<name>-ui-04-<moment>.png)

...

## Full code

Everything above was written into `<name>.fluid.js` by the dialogs ...

<details>
  <summary>Show the full code</summary>

  <CodeBlock language="js">{finalCode}</CodeBlock>

</details>

<OpenInViewer code={finalCode} entry="<name>.fluid.js" />

## What you practiced

- **Tool or dialog** — what it did and what it wrote
- ...
```

**Writing style (UI-first):**
- One image per moment: tool armed → picks → ghost preview → result. Capture the ghost whenever the operation has one (extrude, revolve, rib, repeat, plane, chamfer, fillet, 2D offset); shell and sketch have none, so show the highlighted pick.
- Name controls exactly as the UI labels them (`Finish Sketch ▾`, `3-Pt Arc`, `Extend to walls`, `Total Count`).
- Use the dedicated tool for a shape (Polygon, Rectangle, Slot, sketch Fillet, Offset), never primitives drawn one by one.
- Quote the statement the dialog previews (`chamfer(8, e.startEdges())`) so the reader connects clicks to code.
- Screenshots come from the headless UI capture described in `.claude/skills/create-tutorial/ui-capture.md` (browse skill at 1440×900 @2x, light theme), quantized with `magick … -dither None -colors 255 png8:`. Not from `generate-screenshots.mjs`, which captures the canvas only.

The legacy code-first template, kept for pages not yet converted:

```mdx
---
sidebar_position: <next number>
title: "<Tutorial Title>"
---

import CodeBlock from '@theme/CodeBlock';
import finalCode from '!!raw-loader!./_examples/<tutorial-name>-final.js';

# Building a <Tutorial Title>

![Finished <name>](/img/docs/tutorials/<name>-final.png)

In this tutorial, you'll build ... based on the [original design by <Author>](<youtube-url>). It covers ...

Create a new file called `<name>.fluid.js` in your project.

## Setup

<imports + explanation>

## Step 1: <Title>

<explanation>

```js
<code>
```

<explanation of what the code does>

![<Alt text>](/img/docs/tutorials/<name>-step1.png)

## Step 2: <Title>

### <Subsection for sketch>

```js
<sketch code>
```

<explanation>

![<Sketch alt text>](/img/docs/tutorials/<name>-step2-sketch.png)

### <Subsection for operation>

```js
<cut/extrude code>
```

<explanation>

![<Result alt text>](/img/docs/tutorials/<name>-step2.png)

...

## Full code

<CodeBlock language="js">{finalCode}</CodeBlock>

## What you practiced

- **`function()`** — one-line description
- ...
```

**Writing style:**
- Use subsections (`###`) within steps to separate sketch from operation
- Explain each function call inline with backtick formatting
- Show sketch screenshot after sketch explanation, before the extrude/cut
- Show result screenshot after the extrude/cut explanation
- Use the final screenshot both at the top (hero) and at the end of the last step

### 4. Update the tutorials index

Edit `website/docs/tutorials/index.mdx` — add a `<TutorialCard>`:

```jsx
<TutorialCard
  title="<Title>"
  description="<One-line summary of techniques covered>"
  image="/img/docs/tutorials/<name>-final.png"
  href="/docs/tutorials/<name>"
/>
```

### 5. Update the sidebar

Edit `website/sidebars.ts` — add `'tutorials/<name>'` to the tutorials items array.

### 6. Generate screenshots (legacy code-first pages)

UI-first pages use the headless UI capture (see step 3). The canvas-only script below serves the older pages and the guides. It lives at `website/scripts/generate-screenshots.mjs`. It discovers all `_examples/*.js` files automatically.

```bash
# List discovered examples (dry run)
node website/scripts/generate-screenshots.mjs --list

# Generate screenshots for your tutorial only
node website/scripts/generate-screenshots.mjs <tutorial-name>
```

**How it works:**
1. Forks a FluidCAD server on port 3200
2. Waits for you to open `http://localhost:3200` in a browser
3. Sends each script to the server and captures a screenshot via the `/api/screenshot` API
4. Saves PNGs to `website/static/img/docs/tutorials/`

**Prerequisites:** The FluidCAD server must be built (`server/dist/index.js` must exist). If not, run `npm run build` from the project root.

**Important:** Files are processed alphabetically, so `*-final.js` runs before `*-step1.js`. The first screenshot in a session sometimes renders poorly (bad camera angle). If the final screenshot looks wrong, re-run it alone:

```bash
node website/scripts/generate-screenshots.mjs <tutorial-name>-final
```

**Screenshot annotations** (add as first line of a `.js` file):
- `// @screenshot skip` — skip this file
- `// @screenshot showAxes` — show coordinate axes
- `// @screenshot hideGrid` — hide the ground grid
- `// @screenshot waitForInput` — pause for manual camera adjustment
- `// @screenshot view <name>` — capture from a fixed named view (`front`, `top`, `iso-ftr`, ...) instead of the UI client's camera; reproducible without manual framing
- `// @screenshot noAutoCrop` — disable auto-cropping

Axes are automatically shown if the code contains `revolve(`, `mirror(`, or `rotate(`.

### 7. Build and verify

```bash
cd website && npm run build
```

The Docusaurus build will fail if any referenced image doesn't exist, so always generate screenshots before building.

## Checklist

- [ ] Example step files created (cumulative, same imports throughout)
- [ ] Sketch step files created for interesting sketches
- [ ] Final example file with complete code
- [ ] Tutorial `.mdx` page with hero image, steps, sketches, full code, and "What you practiced"
- [ ] YouTube credit link included (if applicable)
- [ ] `index.mdx` updated with `TutorialCard`
- [ ] `sidebars.ts` updated with tutorial ID
- [ ] Screenshots generated and verified visually (UI-first: one per moment, ghost previews included, reviewed by eye)
- [ ] `npm run build` passes (a `JSON parse error: Unexpected end of JSON` from an unrelated module is the stale bundler cache — `npm run clear`, rebuild)
