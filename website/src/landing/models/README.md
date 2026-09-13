# Hero models

The models the home page's viewer switches between. Each one is ordinary
FluidCAD source: the page ships it to the viewer as a workspace of one file
and the engine builds it in the visitor's browser.

Placeholders for now — swap in better parts by editing these files and the
registry in `../hero/models.ts`.

Nothing stands in for the engine while it loads, and nothing is replayed once
it has: the viewer paints its own "Loading engine…" and "Building model…",
then the finished model. The only still the hero needs is the switcher
thumbnail.

## Adding or replacing a model

1. Write the model here. The extension matters: `*.part.js` builds a part
   scene, `*.assembly.js` an assembly scene (parts, joints, live solver).
   Keep it to one file — the registry ships a single-entry workspace.
2. Build it in a real FluidCAD workspace first and confirm
   `render.state === "rendered"`. A feature that fails to build is skipped,
   not fatal, so a model can look finished in code and be missing geometry.
3. Add or edit its entry in `../hero/models.ts`.
4. Capture a thumbnail (below) into `static/img/landing/thumb-<id>.png`.

## Capturing the thumbnail

The thumbnail is the render on the switcher button, so the button shows what
it switches to. Square, transparent, cropped to the part, and shot from the
viewer's own camera direction so it reads as the same object the scene is
about to show.

With the model open in a running workspace (`npx fluidcad serve`, note the
port):

```bash
curl -s -X POST http://localhost:3100/api/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"width":512,"height":512,"transparent":true,"showGrid":false,
       "showAxes":false,"autoCrop":true,"fitToModel":true,"margin":0,
       "view":{"kind":"look-from","eye":[50,-50,40]}}' \
  -o static/img/landing/thumb-<id>.png
```

`eye: [50, -50, 40]` is the viewer's own default camera direction. Keep it
square: the button sizes the image to a fixed box and lets `object-fit`
letterbox whatever shape the crop comes out at.
