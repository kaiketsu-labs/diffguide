/** Prompt files, bundled as text by esbuild's text loader. */
declare module '*.md' {
  const text: string;
  export default text;
}
