# Creating FluidCAD Tutorials

Guide for adding new tutorials to the FluidCAD documentation website.

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
website/static/img/docs/tutorials/<name>-step1.png
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

Create `website/docs/tutorials/<tutorial-name>.mdx`. Follow this template:

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

### 6. Generate screenshots

The screenshot script lives at `website/scripts/generate-screenshots.mjs`. It discovers all `_examples/*.js` files automatically.

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
- `// @screenshot waitForInput` — pause for manual camera adjustment
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
- [ ] Screenshots generated and verified visually
- [ ] `npm run build` passes
