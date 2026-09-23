"""Snapshot the Notion catalog document the integration proxy composes.

Composes overlays/catalog.json's `notion` entry (the pinned OAD plus its
overlays, in order), fetching sources with overlays/tests' `fetch` (Pages
URLs are read from this checkout), and writes:

  notion.json             the composed document, as JSON
  notion.provenance.json  every source URL and its SHA-256

The Notion drive plugin bundles notion.json and the mock proxy's notion
fixture serves it, so neither needs a YAML parser. catalog.test.ts fails
when catalog.json's notion entry or an overlay file no longer matches the
provenance; rerun this then:

  pip install -r overlays/requirements-identity-tests.txt
  python3 integrations/notion/catalog/generate.py
"""
import copy
import json
import pathlib
import re
import sys
import tempfile

import yaml
from openapi_spec_validator import validate

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "overlays" / "tests"))

from generate_identity_catalog_fixtures import fetch, platform_config  # noqa: E402


def merge(destination, update):
    """integration-proxy's `merge`: objects merge key by key, anything else
    replaces. (overlays/tests' `merge` cannot take a list update, which
    Notion's auth overlay makes at `$.security`.)"""
    if not isinstance(destination, dict) or not isinstance(update, dict):
        return copy.deepcopy(update)
    for key, value in update.items():
        destination[key] = merge(destination.get(key), value)
    return destination


def apply(document, overlay):
    """integration-proxy's `merge_at_target`: every segment must exist."""
    for action in overlay["actions"]:
        keys = [
            quoted or bare
            for bare, quoted in re.findall(
                r"\.([^.\[]+)|\['([^']+)'\]", action["target"][1:]
            )
        ]
        parent, last = document, None
        for key in keys[:-1]:
            parent = parent[key]
        if keys:
            last = keys[-1]
            if last not in parent:
                raise KeyError(f"overlay target {action['target']} does not exist")
            parent[last] = merge(parent[last], action["update"])
        else:
            merge(document, action["update"])


def compose(name, cache):
    config = platform_config(name)
    base, record = fetch(config["openapi"], cache)
    provenance = [record]
    document = yaml.safe_load(base)
    for url in config["overlays"]:
        raw, record = fetch(url, cache)
        apply(document, yaml.safe_load(raw))
        provenance.append(record)
    # As overlays/tests does: validate as ordinary OpenAPI without the
    # non-`x-` pagination/CRUD component members.
    standard = copy.deepcopy(document)
    for key in ("paginationSchemes", "crudResources"):
        standard.get("components", {}).pop(key, None)
    validate(standard)
    return document, provenance


def main():
    with tempfile.TemporaryDirectory() as cache:
        document, provenance = compose("notion", pathlib.Path(cache))
    (HERE / "notion.json").write_text(json.dumps(document, indent=2) + "\n")
    (HERE / "notion.provenance.json").write_text(
        json.dumps({"platform": "notion", "sources": provenance}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
