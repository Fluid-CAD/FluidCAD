---
id: concepts/packages
title: Packages — sharing custom features and parts as a versioned .fluidpkg
summary: "A package is a workspace whose fluidcad.json has a \"package\" block (@scope/name, semver version) and whose features/, parts/ and assemblies/ folders hold what it exports (*.feature.js, *.part.js or *.fluid.js, *.assembly.js; no exports list). fluidcad pack (MCP pack) checks the layout and the code on the engine and writes <scope>-<name>-<version>.fluidpkg: the exported modules and what they import, verbatim, plus a generated index.js, manifest.json and a reduced fluidcad.json. fluidcad install puts it in the user library (the home directory's ~/.fluidcad/packages by default) or a project's packages/ folder; a project pins each package it uses in fluidcad.json \"dependencies\" as { version, integrity } and imports it by bare name. Features from a package are imported into any model; its parts reach a scene only through insert() in an assembly. Installed packages are read-only; a missing, changed, unpinned or too-new package fails the render with a sentence."
tags: [concept, package, custom-feature, sdk, project]
seeAlso: [concepts/custom-features, concepts/assemblies, concepts/units, api/insert, api/part, api/define-feature]
---

# Packages

A package is how a project's custom features ([[concepts/custom-features]])
and parts travel to other projects and other people. It is one file,
`<scope>-<name>-<version>.fluidpkg`, made by `fluidcad pack`. Installed, it
is a read-only folder the engine loads from; a project that uses it records
the exact version and a hash of its contents, and imports it by name:

```js
import { standoff } from '@acme/mounting-hardware';
```

## Making a workspace a package

A workspace is a package when its `fluidcad.json` holds a `package` block,
and it keeps what it shares in three folders. It is still an ordinary
project: its test models render, and it keeps its `engine`, `unit` and
`materials`.

```
mounting-hardware/
  fluidcad.json                  # "package": { "name", "version", … }
  README.md  LICENSE  CHANGELOG.md
  features/
    bolt-circle.feature.js
    bolt-circle.svg  bolt-circle/      # its icon and option images
    standoff.feature.js  standoff.svg
    shared/geometry.js           # a helper module
  parts/
    hub-flange.part.js           # imports ../features/bolt-circle.feature.js
    pcb-plate.part.js
  assemblies/
    plate-stack.assembly.js      # inserts ../parts/pcb-plate.part.js
  bench.part.js                  # a test model: outside the folders, never ships
```

```json
{
  "engine": "0.0.46",
  "unit": "mm",
  "package": {
    "name": "@acme/mounting-hardware",
    "version": "0.1.0",
    "description": "Standoffs, bosses, bolt circles and fastener holes, with a PCB plate and a hub flange",
    "license": "MIT",
    "author": "Acme Robotics"
  }
}
```

| key | required | rule |
|---|---|---|
| `name` | yes | `@scope/name`: lowercase letters, digits and dashes; unscoped names are refused |
| `version` | yes | strict semver `MAJOR.MINOR.PATCH`, optional `-prerelease`, no build metadata |
| `description`, `license`, `author`, `homepage` | no | strings, copied into the manifest |
| `keywords` | no | a list of strings |
| `minEngine` | no | semver; the lowest FluidCAD the package runs on. Default: the `engine` pin, else the packing engine |

**The folders decide what a package exports.** There is no list to keep in
sync:

| folder | holds | exported |
|---|---|---|
| `features/` | `*.feature.js` modules, their images, helpers | every feature builder each module exports |
| `parts/` | `*.part.js` and `*.fluid.js` models, helpers | every `part()` definition or factory each module exports |
| `assemblies/` | `*.assembly.js` models, helpers | every `assembly()` definition or factory each module exports |

- Nested folders are fine (`parts/brackets/l-bracket.part.js`), and plain
  `.js` helpers may sit in any of the three. A helper ships only when a
  module imports it.
- **Models import the package's features relatively**, as any module inside
  a package does: `import { boltCircle } from '../features/bolt-circle.feature.js'`.
  An assembly inserts the package's parts the same way
  (`../parts/pcb-plate.part.js`).
- Everything outside the three folders is the workspace's own: test models
  at the root (they import `./features/…`), `init.js`, notes. None of it
  ships.
- A block that still lists `exports` (an older layout) is refused: "fluidcad.json
  has a "package" with an "exports" list, but a package exports its
  features/, parts/ and assemblies/ folders: remove "exports" (this
  workspace has features/ and parts/)." Move the modules it listed into the
  folders, then delete the key.
- **Feature ids must start with the scope**: `@acme/mounting-hardware` may
  only declare `acme.*` ids (`acme.standoff`).
- **To publish on the hub, a package needs at least one part or assembly**,
  so its page has a model to show. A features-only package still packs and
  installs from a file.
- `fluidcad package init --name @acme/mounting-hardware` writes the block
  (the name and version `0.1.0`) and says what the folders hold. Without
  `--name` it asks on a terminal.
- `fluidcad version patch|minor|major|<x.y.z>` bumps `version`
  (`@acme/mounting-hardware 0.1.0 → 0.1.1`). Packing never bumps.
- A broken block is reported at startup ("FluidCAD: fluidcad.json has a
  "package" whose "name" "gears" is not a package name (…). Treating this
  workspace as a plain project, not a package.") and never costs the
  `engine`, `unit` or `materials` keys.

Advisory meaning of versions: **major** may break a statement written
against the old version (a removed export or parameter); **minor** adds
features, or parameters whose defaults keep old statements building the
same; **patch** fixes. Pins are exact, so no version changes under a project
by itself.

## Packing

```bash
npx fluidcad pack                    # → acme-mounting-hardware-0.1.0.fluidpkg in the workspace
npx fluidcad pack -o dist/           # -o takes a file or a directory
npx fluidcad pack --json             # the result as JSON (contents by folder)
```

```
Packed @acme/mounting-hardware 0.1.0 → …/acme-mounting-hardware-0.1.0.fluidpkg
  features/   4 features: acme.boltCircle, acme.boss, acme.fastener, acme.standoff
  parts/      2 parts: hubFlange, pcbPlate
  assemblies/ 1 assembly: plateStack
  29 files, 18.2 kB, unit mm
```

A package with no part or assembly adds the line "no parts or assemblies:
it installs, but the hub needs at least one to publish". `--json` prints
`{ name, version, fileName, savedTo, bytes, files, unit, contents }`, where
`contents` is `{ features: [{ id, exportName, module, usesOcct }], parts:
[{ exportName, name, module, params }], assemblies: […], models }` (`params`
counts the `param()`s). The MCP tool `pack` does the same through the
running engine (pass `saveAsPath`) and returns the same `contents`. The
archive, which is also the installed folder:

| file | what |
|---|---|
| the exported modules and every file they import | verbatim, paths kept (`features/standoff.feature.js`): real modules, not a bundle |
| the images the features declare (icons, option pictures) | next to their modules |
| `README.md`, `LICENSE*`, `CHANGELOG.md` | when present at the workspace root |
| `index.js` | generated: `export { standoff } from "./features/standoff.feature.js";`, one named re-export per exported name |
| `manifest.json` | generated: identity, `engine` packed on, `minEngine`, `sdkVersion`, `unit`, `fileUnits`, `contents`, each feature's metadata snapshot and `usesOcct`, each part's and assembly's name, `kind` and params, `files` |
| `fluidcad.json` | generated: only `unit` (always explicit) and `materials` |

Test models outside the folders, `init.js`, `jsconfig.json` and anything
not imported stay out. Pack writes nothing to the workspace except the
archive, and the same sources always pack to the same bytes (no timestamp
anywhere; zip entries are dated 1980-01-01), so the same version packed
twice has the same hash.

**Pack checks.** The engine boots, evaluates every export and builds every
part and assembly with its default parameters first. Each refusal is one
sentence naming the file (`pack-refused` from MCP, with `details.code`):

- the workspace has no `package` block ("This workspace isn't a package —
  run `fluidcad package init` first."), its block still lists `exports`, or
  `fluidcad.json` is broken;
- **`wrong-folder`**: a module whose suffix belongs in another folder
  ("features/hub-flange.part.js is a part in features/, but parts belong in
  parts/: move it there.");
- **`no-exports`**: the three folders hold nothing ("@acme/mounting-hardware
  exports nothing: put its feature modules in features/, its parts in parts/
  and its assemblies in assemblies/. …");
- **`outside-layout`**: an import leaves the three folders ("parts/hub-flange.part.js
  imports lib/sizes.js, which is outside features/, parts/ and assemblies/:
  a package ships only what those folders hold. Move lib/sizes.js into one
  of them.");
- an export doesn't evaluate, or exports nothing shareable;
- two modules export one name, or two features share an id;
- a feature id outside the scope ("features/standoff.feature.js declares the
  feature id 'mounts.standoff', but @acme/mounting-hardware may only declare
  ids that start with 'acme.' (the package's scope).");
- a part or assembly fails to build with its default parameters (any object
  in error);
- an import reaches `node_modules`, a file outside the workspace, `init.js`,
  a blocked Node built-in, or another package;
- a declared image is missing ("… declares the image ./standoff.svg (feature
  'acme.standoff'), which doesn't exist next to the module.");
- an authored `index.js`, `manifest.json` or `fluidcad.json` at the root sits
  in the closure (those three are generated);
- a shipped file has unsaved editor changes (the route and MCP; save first).

To release a new version: edit, `fluidcad version minor`, `fluidcad pack`.

Archives packed before the folders existed (modules at the archive root)
still install and load: the layout is checked when packing, not when
installing.

## Installing

Two places hold installed packages, as `<root>/@scope/name/<version>/`:

- **the user library**, once per machine. Its folder is, first match:
  `FLUIDCAD_PACKAGES`, the Settings → Packages **Library folder**,
  `$FLUIDCAD_HOME/packages`, the home directory's `~/.fluidcad/packages`;
- **a project copy** in the project's own `packages/` folder (next to
  `fluidcad.json`, committed with it), only when asked for. It wins over the
  library.

An installed folder is recognised by location plus its `manifest.json`;
anything else in a user's `packages/` folder (their own models) is ordinary
workspace code.

```bash
npx fluidcad install acme-mounting-hardware-0.1.0.fluidpkg          # into the library; pins it when run in a project
npx fluidcad install acme-mounting-hardware-0.1.0.fluidpkg --project # into this project's packages/ (and pins it)
npx fluidcad install @acme/mounting-hardware                       # pin a library package into this project, no files copied
npx fluidcad install @acme/mounting-hardware --project             # …and copy it into packages/
npx fluidcad install                                               # check every pin is installed
npx fluidcad packages                                              # the library, the project copy and the pins
npx fluidcad remove @acme/mounting-hardware [--project]            # @scope/name@version when several are installed
```

- Installing from a file prints the summary (features with labels, parts,
  the engine requirement, files, size, `sha256-…`, a raw OpenCascade warning
  for any `usesOcct` feature, and "A package's code runs in the FluidCAD
  engine with your permissions. Install only packages you trust.") and asks
  y/N; without a terminal it needs `--yes`.
- The same version with the same contents is a no-op. The same version with
  other contents is refused ("… is already in your library with different
  contents. An installed version never changes; replace it explicitly, or
  install it under a new version.") unless `--replace`.
- Installed files are read-only on disk.
- `remove` deletes files only and never unpins: a project still pinning it
  says so on its next render. `install` with no arguments lists missing pins
  and exits 1 (downloading from the hub comes later).
- In the UI: Settings → Packages (**Install package…**, **Remove**), the
  top bar's **Packages** dialog, or a `.fluidpkg` dropped on the window, each
  through a consent dialog with **My library** / **This project**.

## Pins: `dependencies` in `fluidcad.json`

```json
{
  "engine": "0.0.46",
  "dependencies": {
    "@acme/mounting-hardware": {
      "version": "0.1.0",
      "integrity": "sha256-9gPApDnFu7GQz1+By40SoZnvxLgLSZDezAbqJSxF2Mw="
    }
  }
}
```

- One entry per package the project uses: the exact version (never a range)
  and `integrity`, a sha256 tree hash of the installed folder. No lock file.
- **Written for you** the first time a feature or part from a library
  package is used (Custom dropdown, Insert), by `fluidcad install` in a
  project, and by an install whose target is the project. Using a library
  package copies no files into the project.
- Re-read before every render, like the rest of `fluidcad.json`: editing it
  re-renders with no restart.
- A bad map is reported on its own ("… Ignoring the project's package pins.").

## Using a package in a model

**Features** are imported by the package's bare name into any model and
called like the workspace's own (the Custom dropdown writes the import):

```js
// tray.part.js
import { part, extrude } from 'fluidcad/core';
import { standoff } from '@acme/mounting-hardware';

export const tray = part('Electronics tray', () => {
  // … the tray's outline sketch …
  const base = extrude(3);
  standoff(base.endFaces(), { height: 8, outer: 6, hole: 3.2 });
});
```

**Parts** reach a scene only through `insert()` in an assembly, as for
another part file of the workspace ([[concepts/assemblies]]):

```js
// controller.assembly.js
import { insert } from 'fluidcad/core';
import { pcbPlate } from '@acme/mounting-hardware';
import { tray } from './tray.part.js';

insert(tray).grounded();
insert(pcbPlate).translate(20, 15, 11);
```

A part file shows only the parts it declares: importing `standoff` from a
package that also exports parts never adds them to `tray.part.js`.

- Import by name only: `@acme/mounting-hardware/parts/x.part.js` is refused
  ("a package is imported by its name only").
- A package part builds in the package's unit (its `fluidcad.json` is
  explicit), and `.material()` inside it resolves against the package's own
  materials then the built-ins, never the consumer's map, so its mass is the
  same in every project ([[concepts/units]]).
- A package's statements in a model are attributed to the model's call line
  (feature modules are skipped like workspace ones).
- Share links refuse a model that imports a package ("Links can't carry
  packages yet (`@acme/mounting-hardware`).").

## Read-only

Installed packages never change:

- the files are read-only on disk, and the engine refuses every edit aimed at
  one (dialogs, breakpoints, materials, connectors, file writes into a
  project copy): "`pcb-plate.part.js` belongs to `@acme/mounting-hardware`
  0.1.0 and is read-only.";
- timeline rows that come from a package file carry a package mark and no
  edit, rename, remove or source jump;
- to change a package, change its workspace, bump the version and pack again.

## Errors when a package can't load

The render fails (a compile error in the model) with one of these, and the UI
offers **Install from file…** for the missing case:

| cause | sentence |
|---|---|
| the import's name has no pin | `` `@acme/gears` is not a dependency of this project — install it or add it from your library. `` |
| pinned, installed in neither place | `` This project uses `@acme/gears` 1.2.0, which isn't installed. `` |
| installed copy's hash differs from the pin | `` The installed `@acme/gears` 1.2.0 differs from the one this project was built with. `` |
| `minEngine` above the running engine | `` `@acme/gears` 1.2.0 needs FluidCAD 0.0.50 or newer; this engine is 0.0.46. `` |
| built against another feature SDK | `` `@acme/gears` 1.2.0 was built against feature SDK version 2; this engine has version 1. `` |
| a `node_modules/@acme/gears` exists | `FluidCAD packages never load from node_modules, but … would shadow the installed package. Remove it so the engine loads the installed copy.` |
| a package file imports another package | `` … imports `@acme/other`, but a package can't import another package yet. `` |

Startup warnings list missing pins too. An unpinned scoped name that a
`node_modules` folder does hold is an ordinary npm import, not a package.

## Editor types

Pinned, installed packages complete and hover like workspace code, typed from
their own JavaScript (no `.d.ts` needed), with no setup:

- the in-page editor gets the package sources from the engine;
- for VS Code and Neovim (tsserver) the engine keeps a shim at
  `node_modules/@types/<scope>__<name>/` (an `index.d.ts`, a
  `.fluidcad-package-types` marker and an `installed` link to the installed
  folder). It is rewritten when the pins change, safe to delete, and not
  committed. Go to definition opens the installed, read-only file.
- **Never create `node_modules/@scope/name`** for a package: the engine
  refuses a package found there.
- `fluidcad init` writes `"maxNodeModuleJsDepth": 8` into `jsconfig.json`.
  An older project whose package helpers read as `any` needs the same line.
- An unpinned library package is not typed until it is pinned.

## Limits

- No package-to-package imports and no npm dependencies inside a package
  (pack refuses both).
- No hub yet: packages travel as files; `fluidcad install` with no arguments
  only lists what is missing.
- Moving a project to a newer version of a package it pins is not supported
  yet (the Packages dialog shows "x.y.z available").
