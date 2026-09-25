// @wc-ignore-file
/** A stylesheet imported as text (Vite's `?raw`; build.mjs minifies it). */
declare module '*.css?raw' {
  const css: string;

  export default css;
}
