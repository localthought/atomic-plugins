# Notion catalog document

`notion.json` is what a LocalThought proxy serves for `notion`: the
`overlays/catalog.json` `notion` entry composed the way integration-proxy
composes it. That means the OpenAPI subset pinned at
`localthought/openapi-directory@0c8e229`
(`APIs/notion.com/2026-03-11/openapi.yaml`), plus these overlays in order:

| Overlay (`overlays/notion.com/2026-03-11/`) | What it adds                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-overlay.yaml`                         | OAuth authorization code, `owner=user`, Basic client auth, JSON token and refresh operations. It was already listed.                                                                                                                                                     |
| `pagination-overlay.yaml`                   | `bodyCursor`: `start_cursor`/`page_size` in the POST body of `/search` and `/data_sources/{id}/query`. `queryCursor`: the same fields as query parameters on `GET /views`. Both are applied with explicit `x-pagination`; auto-detection is off.                         |
| `crud-causality-overlay.yaml`               | Read-only `crudResources`: `data_source`, listed with `POST /search` filtered to data sources, and `page`, listed per data source with `POST /data_sources/{data_source_id}/query`. It also adds typed `NotionDataSource`/`NotionPage` schemas for the top-level fields. |

Two consumers use `notion.json` as JSON, so neither needs a YAML parser: the
drive plugin (`../app/`), which bundles it, and the mock proxy's notion
fixture (`../fixtures/notion/`), which serves it. `notion.provenance.json`
records each source URL and its SHA-256. `../catalog.test.ts` fails when
`overlays/catalog.json`'s notion entry, or any overlay file, stops matching
that record. Regenerate both files then:

```sh
pip install -r overlays/requirements-identity-tests.txt
python3 integrations/notion/catalog/generate.py
```

`generate.py` fetches with overlays/tests' `fetch`, so Pages URLs are read
from this checkout. It merges with integration-proxy's semantics: a list
update replaces, and every target must exist. It then validates the result as
ordinary OpenAPI, like overlays CI does.

## The two collection extensions

Notion's lists are `POST` operations. The CRUD Causality extension has no
field for that, so each collection declares two extension keys, both read by
`syncables/browser`:

- `x-list-method: POST` means the collection is listed with the `post` under
  its `urlTemplate`, not `get`.
- `x-list-body` holds the fixed JSON body fields. Each page merges the
  pagination scheme's body fields over them.

reflector's `resources.ts` reads neither key.

## Not verified

- On merge, this changes production. The overlays are published from
  `overlays/` on GitHub Pages, unpinned, and the proxy composes
  `catalog.json` at start. So the next proxy start after merge serves the two
  new overlays for `notion`. They declare nothing writable.
- Authored from Notion's reference documentation. Nothing here was recorded
  against a live workspace or run through a real proxy deployment.
- `overlays/notion.com/1.0.0/pagination-overlay.yaml`, migrated from
  `localthought/overlays`, is not in `catalog.json` and is left untouched. It
  puts `start_cursor` in the query string, which is wrong for the two POST
  lists. It also uses a `hasMore` role that syncables' validator rejects.
