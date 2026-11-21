/**
 * `fluidcad export dxf` and `fluidcad export svg`: the plane flag, the
 * request body it becomes and the warnings a drawing comes back with — kept
 * free of I/O so they are testable on their own
 * (`bin/tests/export-drawing.test.ts`).
 */

/**
 * The standard planes a drawing can be made on, each with the view it shows
 * — where the viewer stands. Six planes, each under its axis name and its
 * view name; the server knows the same twelve.
 */
export const DRAWING_PLANES = {
  top: 'top',
  xy: 'top',
  bottom: 'bottom',
  '-xy': 'bottom',
  front: 'front',
  xz: 'front',
  back: 'back',
  '-xz': 'back',
  right: 'right',
  yz: 'right',
  left: 'left',
  '-yz': 'left',
};

/** The response header a drawing's warnings travel in: a URI-encoded JSON array of strings. */
export const EXPORT_WARNINGS_HEADER = 'x-fluidcad-export-warnings';

/**
 * The planes as the help of a drawing subcommand (`dxf`, `svg`) lists them:
 * one line per view, with what the viewer looks along.
 */
export function drawingPlanesHelp(format) {
  return `
Planes (--plane), each by its view name or its axis name:
  top     xy    looking down the Z axis: X to the right, Y up
  bottom  -xy   looking up the Z axis
  front   xz    looking along +Y, from the −Y side: X to the right, Z up
  back    -xz   looking along −Y
  right   yz    looking along −X, from the +X side: Y to the right, Z up
  left    -yz   looking along +X

The drawing is the model's view on that plane with hidden lines removed, at
model coordinates in the document's unit: a point at (12, 7, z) is at (12, 7)
in a top view. Several solids are drawn together, one hiding another.
Without -o the file is named after the view:
  fluidcad export ${format} --plane top     → bracket-top.${format}
  fluidcad export ${format} --plane front --hidden-lines -o drawings/bracket-front.${format}`;
}

/** The DXF subcommand's planes help. */
export const DRAWING_PLANES_HELP = drawingPlanesHelp('dxf');

/** What `fluidcad export svg` says about its page, after the planes. */
export const SVG_PAGE_HELP = `
Page:
  One SVG unit is one document unit, and the page has the drawing's physical
  size (mm for a metric document, in for an imperial one), so it prints and
  cuts 1:1. --stroke-width and --margin are millimetres on paper whatever
  the document's unit; hidden and tangent edges are drawn at half the width.
  SVG's Y runs down the page, so X is the model's own and Y is measured down
  from the drawing's top edge: the picture is the right way up.
  The file has no script, style sheet or external reference.`;

/**
 * A page length flag (`--stroke-width`, `--margin`) as millimetres;
 * undefined when the flag was not given. `allowZero` is the margin's: a
 * stroke of no width draws nothing.
 */
function parsePageLength(flag, raw, { allowZero }) {
  if (raw === undefined) {
    return undefined;
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  const valid = String(raw).trim() !== '' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new Error(`Invalid ${flag} "${raw}". Expected a number of millimetres${allowZero ? ', 0 or more' : ' greater than 0'}.`);
  }
  return value;
}

/**
 * The drawing flags as a request: `body` is what `POST /api/export` takes
 * beside the format and the selector, `view` the view the plane shows (the
 * default file name ends in it). `--plane` is required: a drawing is a view,
 * and no view suits every part. `format` `'svg'` reads the page flags too
 * (`--stroke-width`, `--margin`, millimetres on paper).
 */
export function parseDrawingOptions(opts, format = 'dxf') {
  const requested = typeof opts.plane === 'string' ? opts.plane.trim().toLowerCase() : opts.plane;
  if (requested === undefined || requested === '') {
    throw new Error(`--plane is required: the plane the model is drawn on. One of: ${Object.keys(DRAWING_PLANES).join(', ')}.`);
  }
  if (!Object.hasOwn(DRAWING_PLANES, requested)) {
    throw new Error(`Invalid --plane "${opts.plane}". Expected one of: ${Object.keys(DRAWING_PLANES).join(', ')}.`);
  }
  const strokeWidth = format === 'svg' ? parsePageLength('--stroke-width', opts.strokeWidth, { allowZero: false }) : undefined;
  const margin = format === 'svg' ? parsePageLength('--margin', opts.margin, { allowZero: true }) : undefined;
  return {
    view: DRAWING_PLANES[requested],
    body: {
      plane: requested,
      ...(opts.hiddenLines === true ? { hiddenLines: true } : {}),
      ...(opts.tangentEdges === true ? { tangentEdges: true } : {}),
      ...(strokeWidth !== undefined ? { strokeWidth } : {}),
      ...(margin !== undefined ? { margin } : {}),
    },
  };
}

/**
 * The warnings of an export response — what the drawing had to approximate.
 * Empty when the header is absent or is not the list it should be: a note
 * the CLI cannot read is not worth failing a written file over.
 */
export function exportWarnings(headers) {
  const raw = headers?.get?.(EXPORT_WARNINGS_HEADER);
  if (typeof raw !== 'string' || raw === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  } catch {
    return [];
  }
}
