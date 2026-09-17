/** Raw source imports (`!!raw-loader!./file.js`) resolve to their text. */
declare module '!!raw-loader!*' {
  const content: string;
  export default content;
}

/** PNGs imported from the app's feature icon set are bundled as asset URLs. */
declare module '*.png' {
  const url: string;
  export default url;
}
