# Moneybird readable-record metadata

These overlays accompany the generated read-only Moneybird OpenAPI document at
commit `85a6105220036a98ef0d7cd6f228d4aae0036508` in the OpenAPI directory.

`crud-causality-overlay.yaml` describes record identity, collections, object
reads, and response Links. The contact-to-subscriptions relation uses standard
Link request context plus the proposed `x-for-each` item binding; publication
of that dependency waits for the filtering/Link proposal review.

`all-records-selection.json` is deliberately separate from the overlays. Its
generic `query_overrides` request archived, inactive, billed, and unbilled
records for an “all records” import. The catalog passes this object to the
client as explicit consumer configuration; it is never composed into the
OpenAPI document and makes no claim about Moneybird's default API behavior.

Regenerate and validate from a checkout containing the generated OpenAPI
document:

```sh
ruby scripts/generate_moneybird_metadata.rb /path/to/APIs/moneybird.com/v2-readonly
ruby scripts/validate_moneybird_metadata.rb /path/to/APIs/moneybird.com/v2-readonly
```

`throttling-overlay.yaml` describes the API's announced 150-request, 300-second
source-IP quota using `spec/throttling` from pondersource/openapi-extensions. The
window algorithm is explicitly unspecified; pacing/retries remain consumer
choices. The catalog excludes report endpoints, whose stricter quota is not
modeled by this overlay. Source: https://developer.moneybird.com/#throttling
