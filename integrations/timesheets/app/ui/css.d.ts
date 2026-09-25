// @wc-ignore-file
/** `theme.css?raw`: the stylesheet's text (see `theme.ts`, `build.mjs`). */
declare module '*.css?raw' {
  const text: string;

  export default text;
}
