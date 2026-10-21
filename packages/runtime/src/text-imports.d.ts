/**
 * Text imports.
 *
 * The deep engine's HTTP server is Python, and it ships *inside* the build:
 * `airllm.ts` imports it as text so a compiled binary or an npm install has
 * the server with it, with no loose file to lose. Bun resolves the import;
 * this declaration is what tells TypeScript what the result is.
 */
declare module "*.py" {
  const source: string
  export default source
}
