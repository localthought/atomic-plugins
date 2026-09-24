// A test fixture for integrations/tooling, not a plugin anyone installs:
// the smallest gated plugin. Its manifest is version 3 with one anonymous
// GET route, so it needs a node built with `--features plugin-routes` and
// started with `--plugin-routes read-only` or higher (design
// docs/design/server-plugin-routes.md, section 0). Its derived `requires` is
// ["persistent-host", "plugin-routes:read-only", "public-origin",
// "wasm-sandbox"].
//
// Used by catalog-requires.test.mjs and certify.test.mjs, and published and
// pinned by the `plugin-routes` lane's e2e (../../e2e/plugin-routes.spec.ts).
// The route is never served: no host serves routes yet (atomic-server
// AS-04/AS-05), so nothing calls a handler. Hand-written, not a bundle.
export const manifest = {
  schemaVersion: 3,
  secrets: [],
  operations: [],
  http: {
    routes: [{ id: 'hello', path: '/hello', methods: ['GET'] }],
    reason: 'Tooling fixture: one read-only route, never served.',
  },
};

export function run() {
  return { intents: [] };
}
