# FluidCAD logo

The approved **Split Cube** mark is a separated three-face cube inside the Twin Forms brackets. Keep the transparent gap between the cube and brackets.

Editable masters and the design archive live beside this repository in `../FluidCAD-Logo/`:

- `logo.svg`: the master, with named groups for each bracket and cube face; no font dependencies.
- `logo.blend`: editable Blender geometry, grouped into Brackets and Cube.
- `logo-mono.svg` and `logo-reversed.svg`: single-colour versions.
- `export.py`: regenerates application assets from the SVG.
- `build_blender.py`: rebuilds the Blender file from the SVG.

After editing the SVG, run from the repository root:

```sh
python3 ../FluidCAD-Logo/export.py --project .
```

The exporter needs Python 3 and ImageMagick 7 (`magick`, with SVG support). It refreshes the website and CAD UI SVGs/PNGs, both favicons, the desktop package/window icons and inline start-screen logo, both VS Code logo copies, and the website share image. PNGs are generated from a 2048px vector render; the ICO contains 16–256px frames.

To refresh the editable Blender file after an SVG change:

```sh
blender --background --python ../FluidCAD-Logo/build_blender.py
```

The checked-in runtime SVG is [website/static/img/logo.svg](website/static/img/logo.svg). It remains editable if the sibling design folder is unavailable. Keep it and `ui/public/logo.svg` identical. The extension prepublish script maps the repository README's logo to the packaged `resources/logo.png`.

The sibling `../FluidCAD-Viewer` uses the shared TopBar and copies the logo and favicons from `ui/dist-lib`. After exporting, run `npm run build:viewer-ui` here, then `npm run build:app` in the Viewer repository. The Viewer app build clears its output directory; rebuild its engine afterward when needed.
