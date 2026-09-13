# Hero models

The models the home page's viewer switches between. Each one is ordinary
FluidCAD source: the page ships it to the viewer as a workspace of one file
and the engine builds it in the visitor's browser.

Placeholders for now — swap in better parts by editing these files and the
registry in `../hero/models.ts`.

## Adding or replacing a model

1. Write the model here. The extension matters: `*.part.js` builds a part
   scene (feature tree, replayable), `*.assembly.js` an assembly scene
   (parts, joints, live solver). Keep it to one file — the registry ships a
   single-entry workspace.
2. Build it in a real FluidCAD workspace first and confirm
   `render.state === "rendered"`. A feature that fails to build is skipped,
   not fatal, so a model can look finished in code and be missing geometry.
3. Add or edit its entry in `../hero/models.ts`.
4. Capture a poster (below) into `static/img/landing/<id>.png`.

## Capturing the poster

The poster is the still the hero paints before the engine is warm, so it has
to be framed exactly like the live scene: same direction, same fit,
transparent background.

With the model open in a running workspace (`npx fluidcad serve`, note the
port):

```bash
curl -s -X POST http://localhost:3100/api/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"width":1500,"height":1000,"transparent":true,"showGrid":false,
       "showAxes":false,"autoCrop":false,"fitToModel":true,"margin":0,
       "view":{"kind":"look-from","eye":[50,-50,40]}}' \
  -o static/img/landing/<id>.png
```

`eye: [50, -50, 40]` is the viewer's own default camera direction, and the
hero asks the viewer for the same direction once it is live — that is what
makes the cross-fade land without the model jumping. Keep the 3:2 aspect.
