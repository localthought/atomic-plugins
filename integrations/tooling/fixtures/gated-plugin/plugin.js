// A test fixture for integrations/tooling, not a plugin anyone installs:
// the smallest gated plugin. Its manifest is version 3 with one anonymous
// `GET /hello` route on the `drive-prefix` mount
// (`/_routes/<installation-slug>/hello`), so it needs a node built with
// `--features plugin-routes` and started with `--plugin-routes read-only` or
// higher (design docs/design/server-plugin-routes.md, section 0). Its
// derived `requires` is ["persistent-host", "plugin-routes:read-only",
// "public-origin", "wasm-sandbox"].
//
// Used by catalog-requires.test.mjs and certify.test.mjs, and published,
// installed and requested by the `plugin-routes` lane's e2e
// (../../e2e/plugin-routes.spec.ts). Hand-written, not a bundle. Shaped like
// atomic-server's testdata/plugin-routes/hello-route: a route request runs
// `handle(ctx, request)` (the `http` trigger); every other trigger runs `run`.
export const manifest = {
  schemaVersion: 3,
  secrets: [],
  operations: [],
  http: {
    mount: 'drive-prefix',
    routes: [{ id: 'hello', path: '/hello', methods: ['GET'] }],
    reason: 'Tooling fixture: one read-only route.',
  },
};

export function handle() {
  return {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Hello from the gated fixture',
  };
}

export function run() {
  return { intents: [] };
}
