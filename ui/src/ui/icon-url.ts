/**
 * Where the PNG icons of the timeline, the toolbars and the feature dialogs
 * come from.
 *
 * The product's page asks for them relative to itself (`icons/x.png`): the
 * same page then works at `/` under `fluidcad serve` and the extensions, and
 * under `/p/<project>/` behind the proxy `npx fluidcad` puts in front of each
 * engine, where an absolute `/icons/` would reach the start server instead.
 * The viewer library keeps the absolute path (`viewer-ui.ts`): a docs page
 * embeds it at any depth and serves the icons at its root.
 */

let base = 'icons/';

/** Where `iconUrl` points: `icons/` by default, `/icons/` for the viewer library. */
export function setIconBase(path: string): void {
  base = path;
}

/** The URL of the icon named `name` (`extrude`, `box-blue`, …). */
export function iconUrl(name: string): string {
  return `${base}${name}.png`;
}
