"""Compose exactly the catalog-pinned Google and GitHub OADs and overlays.

Outputs are reproducible snapshots for integration-proxy tests. The manifest
records every URL and SHA-256 used to produce them.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import re
import urllib.request

import yaml
from openapi_spec_validator import validate


ROOT = pathlib.Path(__file__).parents[1]
CATALOG = json.loads((ROOT / "catalog.json").read_text())
IDENTITY_PLATFORMS = ("google-calendar", "github-issues")
# GitHub Pages publishes this folder here once merged to ontola/atomic-plugins'
# main. Sources under it are read from the checkout instead, so a change is
# validated before it is published.
PAGES_BASE = "https://ontola.github.io/atomic-plugins/overlays/"


def fetch(url, cache):
    if url.startswith(PAGES_BASE):
        data = (ROOT / url[len(PAGES_BASE):]).read_bytes()
        return data, {"url": url, "sha256": hashlib.sha256(data).hexdigest()}
    name = hashlib.sha256(url.encode()).hexdigest() + ".yaml"
    path = cache / name
    if not path.exists():
        path.write_bytes(urllib.request.urlopen(url, timeout=30).read())
    data = path.read_bytes()
    return data, {"url": url, "sha256": hashlib.sha256(data).hexdigest()}


def merge(destination, update):
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(destination.get(key), dict):
            merge(destination[key], value)
        else:
            destination[key] = copy.deepcopy(value)


def target(document, expression):
    node = document
    for bare, quoted in re.findall(r"\.([A-Za-z][A-Za-z0-9]*)|\['([^']+)'\]", expression[1:]):
        node = node[quoted or bare]
    return node


def apply(document, source):
    for action in source["actions"]:
        merge(target(document, action["target"]), action["update"])


def platform_config(name):
    return next(platform for platform in CATALOG["platforms"] if platform["name"] == name)


def compose(name, cache):
    config = platform_config(name)
    base, base_record = fetch(config["openapi"], cache)
    provenance = [base_record]
    document = yaml.safe_load(base)
    for url in config["overlays"]:
        raw, record = fetch(url, cache)
        apply(document, yaml.safe_load(raw))
        provenance.append(record)
    # Existing pagination/CRUD proposals use non-`x-` component members. They
    # remain in the fixture; remove only those extension members for ordinary
    # OpenAPI validation.
    standard = copy.deepcopy(document)
    components = standard.get("components", {})
    for key in ("paginationSchemes", "crudResources"):
        components.pop(key, None)
    validate(standard)
    return document, provenance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--cache", type=pathlib.Path, default=pathlib.Path(".cache/identity-catalog"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    manifest = {"catalog": {"path": "catalog.json", "sha256": hashlib.sha256((ROOT / "catalog.json").read_bytes()).hexdigest()}, "platforms": {}}
    for name in IDENTITY_PLATFORMS:
        document, provenance = compose(name, args.cache)
        (args.output / f"{name}-composed.yaml").write_text(yaml.safe_dump(document, sort_keys=False))
        manifest["platforms"][name] = provenance
    (args.output / "sources.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
