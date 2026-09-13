/** Raw source imports (`!!raw-loader!./file.js`) resolve to their text. */
declare module '!!raw-loader!*' {
  const content: string;
  export default content;
}
