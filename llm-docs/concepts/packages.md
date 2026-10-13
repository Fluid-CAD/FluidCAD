---
id: concepts/packages
title: Packages — sharing custom features and parts through the hub
summary: "A package is a workspace whose fluidcad.json has a \"package\" block (name @<handle>/<name>, the author's own hub handle as its scope; semver version) and whose features/, parts/ and assemblies/ folders hold what it exports (*.feature.js, *.part.js or *.fluid.js, *.assembly.js; no exports list). That one name is the archive's, the hub's, the pin's, the library folder's and every import's. fluidcad publish packs the workspace and uploads it in one command: it checks the layout and the code on the engine and builds <scope>-<name>-<version>.fluidpkg, the exported modules and what they import, verbatim, plus a generated index.js, manifest.json and a reduced fluidcad.json. fluidcad pack (MCP pack) runs the same checks and writes that archive to look at, without publishing; it is never a step before publishing. Packages install only from the hub, never from a .fluidpkg file: fluidcad install @scope/name downloads, verifies and installs into the user library (the home directory's ~/.fluidcad/packages by default) or a project's packages/ folder; a project pins each package it uses in fluidcad.json \"dependencies\" as { version, integrity } and imports it by name. Features from a package are imported into any model; its parts reach a scene only through insert() in an assembly. Installed packages are read-only; a missing, changed, unpinned or too-new package fails the render with a sentence."
tags: [concept, package, custom-feature, sdk, project]
seeAlso: [concepts/custom-features, concepts/assemblies, concepts/units, api/insert, api/part, api/define-feature]
---

# Packages

A package is how a project's custom features ([[concepts/custom-features]])
and parts travel to other projects and other people, through the FluidCAD
hub. `fluidcad publish` packs it into one file,
`<scope>-<name>-<version>.fluidpkg`, and uploads it in one command
(`fluidcad pack` writes the same file to look at, without publishing);
other projects install it from the hub with `fluidcad install @scope/name`.
The archive itself never installs. Installed,
it is a read-only folder the engine loads from; a project that uses it
records the exact version and a hash of its contents, and imports it by its
name:

```js
import { standoff } from '@acme/mounting-hardware';
```

## Names: one name, with the author's handle

- **The author writes the full name**: `"name": "@acme/mounting-hardware"`
  in the `package` block. The scope is the author's own hub handle; the hub
  publishes a package only under its uploader's handle. Each part is
  lowercase letters, digits and single dashes, starting with a letter; the
  handle is 2–39 characters, the name after the slash at most 64.
- **That name is the package's everywhere**: the archive's `manifest.json`
  and file name (`acme-mounting-hardware-0.1.0.fluidpkg`), the hub's URLs,
  pins (`dependencies` keys), import specifiers and library folders
  (`<library>/@acme/mounting-hardware/0.1.0/`). Two publishers can each have
  a `…/mounting-hardware`, side by side in one project.
- **A name without the scope is refused**: "fluidcad.json has a "package"
  whose "name" "mounting-hardware" needs your hub handle as its scope: write
  "@<your-handle>/mounting-hardware"." Any other bad name: "… is not a
  package name (packages are named @handle/name, each part in lowercase
  letters, digits and single dashes, starting with a letter)."
- **`fluidcad publish` refuses another handle's scope** before it packs or
  uploads anything: "@bea-tools/mounting-hardware is under @bea-tools, but
  you are signed in to <hub> as @acme, and you can only publish under your
  own handle: name the package "@acme/mounting-hardware" in fluidcad.json,
  or sign in as @bea-tools."
- **Feature ids are plain** (`static id = 'standoff'`) and never written into
  a model. The engine keys an installed package's features by the package at
  load time — `@acme/mounting-hardware:standoff` is the type of their
  timeline rows and `get_scene_summary` entries — so two packages'
  `standoff` never collide. In the author's own workspace the type stays
  `standoff`.
- An archive packed while package names had no scope (its manifest names
  `mounting-hardware`) is refused when it arrives from a hub, never
  converted: "This archive names mounting-hardware, without a scope: it was
  packed by an earlier FluidCAD, whose package names had none. Publish it
  again with this one, after naming the package "@<your-handle>/mounting-hardware"
  in its fluidcad.json." Trees already installed keep working: their folder
  names them.

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
| `name` | yes | `@<handle>/<name>`, the scope being the author's hub handle; each part lowercase letters, digits and single dashes, starting with a letter; a name without the scope is refused |
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
- **Feature ids are plain** (`standoff`); no two features of a package may
  share one.
- **To publish on the hub, a package needs at least one part or assembly**,
  so its page has a model to show. A features-only package still packs, but
  can't be published.
- `fluidcad package init --name @acme/mounting-hardware` writes the block
  (the name and version `0.1.0`) and says what the folders hold. Signed in
  (`fluidcad login`), `--name mounting-hardware` takes the signed-in handle
  and prints "Named it @acme/mounting-hardware: your handle on <hub>.";
  signed out, a name without the scope is refused with the sentence above.
  Without `--name` it asks on a terminal (`Package name: @acme/` when signed
  in).
- `fluidcad version patch|minor|major|<x.y.z>` bumps `version`
  (`@acme/mounting-hardware 0.1.0 → 0.1.1`). Packing never bumps.
- A broken block is reported at startup ("FluidCAD: fluidcad.json has a
  "package" whose "name" "@acme/3d-gears" is not a package name (…). Treating this
  workspace as a plain project, not a package.") and never costs the
  `engine`, `unit` or `materials` keys.
- **Test a package in its own workspace**, with its own models (test models
  at the root, the parts and assemblies in its folders). There is no step
  that installs the author's own archive into another project.

Advisory meaning of versions: **major** may break a statement written
against the old version (a removed export or parameter); **minor** adds
features, or parameters whose defaults keep old statements building the
same; **patch** fixes. Pins are exact, so no version changes under a project
by itself.

## Packing

`fluidcad publish` packs the workspace itself, with the checks below, and
uploads the result: publishing is one command. `fluidcad pack` is optional:
it builds the same archive and writes it out, to look at what would be
published (its files, `manifest.json`, the contents) without publishing.

```bash
npx fluidcad pack                    # → acme-mounting-hardware-0.1.0.fluidpkg in the workspace
npx fluidcad pack -o dist/           # -o takes a file or a directory
npx fluidcad pack --json             # the result as JSON (contents by folder)
```

```
Packed @acme/mounting-hardware 0.1.0 → …/acme-mounting-hardware-0.1.0.fluidpkg
  features/   4 features: boltCircle, boss, fastener, standoff
  parts/      2 parts: hubFlange, pcbPlate
  assemblies/ 1 assembly: plateStack
  29 files, 18.2 kB, unit mm
```

A package with no part or assembly adds the line "no parts or assemblies:
the hub needs at least one to publish". `--json` prints
`{ name, version, fileName, savedTo, bytes, files, unit, contents }`, where
`contents` is `{ features: [{ id, exportName, module }], parts:
[{ exportName, name, module, params }], assemblies: […], models }` (`params`
counts the `param()`s). The MCP tool `pack` does the same through the
running engine (pass `saveAsPath`) and returns the same `contents`. The
archive is what `fluidcad publish` uploads, and what a hub install unpacks
into the installed folder:

| file | what |
|---|---|
| the exported modules and every file they import | verbatim, paths kept (`features/standoff.feature.js`): real modules, not a bundle |
| the images the features declare (icons, option pictures) | next to their modules |
| `README.md`, `LICENSE*`, `CHANGELOG.md` | when present at the workspace root |
| `index.js` | generated: `export { standoff } from "./features/standoff.feature.js";`, one named re-export per exported name |
| `manifest.json` | generated: identity, `engine` packed on, `minEngine`, `sdkVersion`, `unit`, `fileUnits`, `contents`, each feature's metadata snapshot, each part's and assembly's name, `kind` and params, `files` |
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
- a part or assembly fails to build with its default parameters (any object
  in error);
- an import reaches `node_modules`, a file outside the workspace, `init.js`,
  a blocked Node built-in, or another package;
- a declared image is missing ("… declares the image ./standoff.svg (feature
  'standoff'), which doesn't exist next to the module.");
- an authored `index.js`, `manifest.json` or `fluidcad.json` at the root sits
  in the closure (those three are generated);
- a shipped file has unsaved editor changes (the route and MCP; save first).

To release a new version: edit, `fluidcad version minor`, `fluidcad publish`.

Archives packed before the folders existed (modules at the archive root)
still install and load: the layout is checked when packing (and by the hub
on upload), not when installing.

## Installing

Packages install only from the hub. Two places hold installed packages, as
`<root>/@scope/name/<version>/`:

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
npx fluidcad install @acme/mounting-hardware          # the hub's latest this FluidCAD runs; pins it when run in a project
npx fluidcad install @acme/mounting-hardware@0.1.0    # that version: the library's copy when there is one, else the hub
npx fluidcad install @acme/mounting-hardware --project  # …into (or copied into) this project's packages/
npx fluidcad install                                  # in a project: download every pinned package that isn't installed
npx fluidcad packages                                 # the library, the project copy and the pins
npx fluidcad remove @acme/mounting-hardware [--project]  # @scope/name@version when several are installed
```

- A download is verified before anything is installed: its files must hash
  to the hub's listed integrity, and to the project's pin when there is
  one. Then it installs without asking (`--yes` is accepted and does
  nothing) and prints one line per package: `✓ Installed
  @acme/mounting-hardware@0.1.0 into your library · 4 features, 2 parts ·
  pinned in fluidcad.json` (a zero count left out), then a short `!` line
  per warning: deprecated, a yanked or unpublished exact version, an older
  version because the latest needs a newer engine, a package needing a
  newer engine or another SDK version. A refusal prints its sentence and
  exits 1. A package's code runs in the FluidCAD engine with the user's
  permissions: install only packages the user trusts.
- A name alone asks the hub for its latest version first and uses the
  library's copy when its files are the hub's; with the hub unreachable it
  uses the newest version the library holds, with a note. A name without
  the scope is refused: "Name the publisher: `fluidcad install
  @<handle>/mounting-hardware`."
- **A `.fluidpkg` file (or any path) is refused**, before anything is read:
  "Packages install from the hub: `fluidcad install @<handle>/<name>`. A
  .fluidpkg file is an archive to look inside (`fluidcad pack` writes one);
  it isn't installed." There is no offline install: a machine without the hub
  uses its library, or a project's `packages/` copy (Copy into project
  carries packages with a project).
- The same version with the same contents is a no-op. The same version with
  other contents is refused ("… is already in your library with different
  contents. An installed version never changes; replace it explicitly, or
  install it under a new version.") unless `--replace`.
- Installed files are read-only on disk.
- `remove` deletes files only and never unpins: a project still pinning it
  says so on its next render.
- In the UI: Settings → Packages (the library, **Remove**) and the top bar's
  **Packages** dialog (Copy into project, Use from library). The app has no
  install button until the hub's panel; the missing-package banner and the
  Packages dialog name the command.

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
  package is used (Custom dropdown, Insert), and by `fluidcad install` in a
  project. Using a library
  package copies no files into the project.
- Re-read before every render, like the rest of `fluidcad.json`: editing it
  re-renders with no restart.
- A bad map is reported on its own ("… Ignoring the project's package pins.").

## Using a package in a model

**Features** are imported by the package's name into any model and
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
- to change a package, change its workspace, bump the version and publish again.

## Errors when a package can't load

The render fails (a compile error in the model) with one of these; the
missing case names the command that downloads the package:

| cause | sentence |
|---|---|
| the import's name has no pin | `` `@acme/gears` is not a dependency of this project — install it or add it from your library. `` |
| pinned, installed in neither place | `` This project uses `@acme/gears` 1.2.0, which isn't installed: `fluidcad install @acme/gears@1.2.0` downloads it from the hub. `` |
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
