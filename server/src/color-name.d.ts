// `color-name` ships no types: the CSS colour names, each as its [r, g, b].
declare module 'color-name' {
  const cssColorNames: Record<string, [number, number, number]>;
  export default cssColorNames;
}
