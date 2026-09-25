# Official encoding vectors

`upstream-codecs.json.gz` contains all 827 acceptance/refusal vectors for
`EncodeEntry`, `encode_entry`, `EncodePath` and `encode_path` from
[Willow test vectors](https://codeberg.org/worm-blossom/willow_test_vectors),
commit `0c6d078b8653053ccd0349531b1e66fd372ea904`. It also includes upstream
canonical reencodings for accepted relation vectors. Original filenames remain
as IDs in assertion failures; bytes are losslessly base64 encoded and the JSON
is gzip compressed to avoid hundreds of binary fixture files.

These are upstream test data, not our generated expected encodings. The JSON
contains the source URL and commit. To refresh deliberately after reviewing a
specification change:

```sh
node integrations/willow/import-vectors.mjs /path/to/willow_test_vectors
```

The GitHub repository linked by the specification is deprecated; its README
points to this authoritative Codeberg replacement. No deprecated vectors were
used. The current upstream codec corpus contains no `EncodeEntryRelativeEntry`
directory; relative-entry tests use an explicitly hand-calculated normative
example, bounds and roundtrips, and do not claim independent peer evidence.
