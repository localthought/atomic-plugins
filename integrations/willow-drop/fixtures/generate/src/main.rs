//! Writes the fixture drops for `integrations/willow-drop/` with willow25, the
//! reference Rust implementation of the Willow Drop Format, and decodes each
//! one again with willow25's own `DropDecoder` before writing it.
//!
//! Every key comes from a fixed ChaCha20 seed, so a run with the same willow25
//! version writes the same bytes. Usage, from this directory:
//!
//!     cargo run --release -- ..
//!
//! The argument is the directory the `.drop` files and `expected.json` go to.

use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use std::fmt::Write as _;
use ufotofu::codec_prelude::*;
use willow25::authorisation::{AuthorisationToken, PossiblyAuthorisedEntry, WriteCapability};
use willow25::drop_format::*;
use willow25::entry::{
    randomly_generate_communal_namespace, randomly_generate_owned_namespace,
    randomly_generate_subspace,
};
use willow25::prelude::*;

const CHUNK: u64 = 1024;

/// One entry of a fixture, with the payload bytes the drop carries (if any).
struct Item {
    entry: AuthorisedEntry,
    payload: Vec<u8>,
    /// Whether the drop includes the payload (slice mode 01) or not (00).
    included: bool,
    /// The capability kind, for the expectations file.
    kind: &'static str,
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(out, "{b:02x}").unwrap();
    }
    out
}

fn authorise(entry: Entry, cap: &WriteCapability, secret: &SubspaceSecret) -> AuthorisedEntry {
    let token = AuthorisationToken::new_for_entry(&entry, cap, secret).expect("cap authorises");
    PossiblyAuthorisedEntry::new(entry, token)
        .into_authorised_entry()
        .expect("token verifies")
}

fn entry(ns: &NamespaceId, ss: &SubspaceId, path: Path, ts: u64, payload: &[u8]) -> Entry {
    Entry::builder()
        .namespace_id(ns.clone())
        .subspace_id(ss.clone())
        .path(path)
        .timestamp(ts)
        .payload(payload)
        .build()
}

fn encode(items: &[Item]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    pollster::block_on(async {
        let mut encoder: DropEncoder<_, _> = DropEncoder::new((&mut out).into_consumer());
        for item in items {
            let chunks = item.entry.payload_length().div_ceil(CHUNK);
            let (count, bytes) = if item.included {
                (chunks, item.payload.clone())
            } else {
                (0, Vec::new())
            };
            let metadata = DropSliceMetadata::new(item.entry.clone(), 0, count, 0, false)
                .expect("valid slice metadata");
            encoder
                .consume_item((metadata, bytes.into_producer()))
                .await
                .expect("encodes");
        }
        encoder.consume_final(()).await.expect("finishes");
    });
    out
}

/// Decodes `bytes` with willow25's `DropDecoder`, which verifies every
/// entry's authorisation token, and checks it yields `items` back.
fn check(bytes: &[u8], items: &[Item]) {
    pollster::block_on(async {
        let mut decoder = DropDecoder::new(bytes.to_vec().into_producer());
        let mut index = 0;
        loop {
            match decoder.produce().await.expect("reference decoder accepts the drop") {
                Left((metadata, mut slice)) => {
                    let mut got = Vec::new();
                    while let Left(byte) = slice.produce().await.expect("slice bytes") {
                        got.push(byte);
                    }
                    let item = &items[index];
                    assert_eq!(metadata.entry(), &item.entry, "entry {index}");
                    let want: &[u8] = if item.included { &item.payload } else { &[] };
                    assert_eq!(got, want, "payload {index}");
                    index += 1;
                }
                Right(()) => break,
            }
        }
        assert_eq!(index, items.len(), "entry count");
    });
}

fn describe(items: &[Item]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        let e = item.entry.entry();
        let components: Vec<String> = e
            .path()
            .components()
            .map(|c| format!("\"{}\"", hex(c.as_ref())))
            .collect();
        let payload = if item.included {
            format!("\"{}\"", hex(&item.payload))
        } else {
            "null".into()
        };
        let comma = if i == 0 { "" } else { "," };
        write!(
            out,
            "{comma}\n      {{ \"namespace\": \"{}\", \"subspace\": \"{}\", \"path\": [{}], \"pathDisplay\": \"{}\", \"timestamp\": \"{}\", \"willow25UnixMillis\": \"{}\", \"payloadLength\": \"{}\", \"payloadDigest\": \"{}\", \"capability\": \"{}\", \"payload\": {} }}",
            hex(e.namespace_id().as_bytes()),
            hex(e.subspace_id().as_bytes()),
            components.join(", "),
            e.path(),
            u64::from(e.timestamp()),
            Epoch::from(e.timestamp()).to_unix_milliseconds() as i64,
            e.payload_length(),
            hex(e.payload_digest().as_bytes()),
            item.kind,
            payload,
        )
        .unwrap();
    }
    out.push_str("\n    ]");
    out
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: willow-drop-fixtures <out dir>");
    let mut rng = ChaCha20Rng::seed_from_u64(0x77696c6c6f77); // "willow"

    let (communal, _) = randomly_generate_communal_namespace(&mut rng);
    let (alice, alice_secret) = randomly_generate_subspace(&mut rng);
    let (bob, bob_secret) = randomly_generate_subspace(&mut rng);
    let (owned, owned_secret) = randomly_generate_owned_namespace(&mut rng);
    let (carol, carol_secret) = randomly_generate_subspace(&mut rng);
    let (dave, dave_secret) = randomly_generate_subspace(&mut rng);

    let alice_cap = WriteCapability::new_communal(communal.clone(), alice.clone());
    let bob_cap = WriteCapability::new_communal(communal.clone(), bob.clone());
    let carol_cap = WriteCapability::new_owned(&owned_secret, carol.clone());

    // The data model recommends microseconds of TAI since J2000 (2000-01-01
    // 12:00 TT); read that way, this is 2026-09-24T00:00:00Z. willow25 0.7.9
    // converts through hifitime, whose J2000_REF_EPOCH is 2000-01-02 12:00
    // TAI, so its reading (willow25UnixMillis) is 86 432.184 s later.
    let t0: u64 = 843_480_069_184_000;
    let binary: Vec<u8> = (0..=255u8).rev().collect();
    let large: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();

    let mut communal_items = vec![];
    for (ss, secret, cap, path, ts, payload, included) in [
        (&alice, &alice_secret, &alice_cap, path!("/notes/hello.txt"), t0, b"Hello from Willow\n".to_vec(), true),
        (&alice, &alice_secret, &alice_cap, path!("/notes/todo.txt"), t0 + 1, b"buy oat milk".to_vec(), true),
        (&bob, &bob_secret, &bob_cap, path!("/blog/2026/first-post"), t0 + 2, "Gr\u{fc}\u{df}e \u{2713}".as_bytes().to_vec(), true),
        (&bob, &bob_secret, &bob_cap, path!("/blog/empty"), t0 + 3, Vec::new(), true),
        (&alice, &alice_secret, &alice_cap, path!("/photos/pixel.bin"), t0 + 4, binary.clone(), true),
        (&alice, &alice_secret, &alice_cap, path!("/large/2500-bytes"), t0 + 5, large.clone(), true),
        (&alice, &alice_secret, &alice_cap, path!("/metadata-only"), t0 + 6, b"hello".to_vec(), false),
    ] {
        communal_items.push(Item {
            entry: authorise(entry(&communal, ss, path, ts, &payload), cap, secret),
            payload,
            included,
            kind: "communal",
        });
    }

    // An owned namespace: carol's capability, signed by the namespace key,
    // grants the full area, so she may also write into dave's subspace. The
    // last entry switches back to a communal namespace.
    let owned_items = vec![
        Item {
            entry: authorise(entry(&owned, &carol, path!("/profile"), t0, b"carol"), &carol_cap, &carol_secret),
            payload: b"carol".to_vec(),
            included: true,
            kind: "owned",
        },
        Item {
            entry: authorise(entry(&owned, &dave, path!("/guestbook/carol"), t0 + 1, b"hi dave"), &carol_cap, &carol_secret),
            payload: b"hi dave".to_vec(),
            included: true,
            kind: "owned",
        },
        Item {
            entry: authorise(entry(&owned, &carol, path!("/odd/a%20b/x%2fy"), t0 + 2, b"odd"), &carol_cap, &carol_secret),
            payload: b"odd".to_vec(),
            included: true,
            kind: "owned",
        },
        Item {
            entry: authorise(entry(&communal, &bob, path!("/blog/second-post"), t0 + 2, b"two"), &bob_cap, &bob_secret),
            payload: b"two".to_vec(),
            included: true,
            kind: "communal",
        },
    ];

    // A delegated capability: carol hands dave write access to his own
    // subspace. The importer does not decode delegations yet.
    let mut dave_cap = carol_cap.clone();
    dave_cap.delegate(&carol_secret, Area::new_subspace_area(dave.clone()), dave.clone());
    let delegated_items = vec![Item {
        entry: authorise(entry(&owned, &dave, path!("/notes"), t0, b"delegated"), &dave_cap, &dave_secret),
        payload: b"delegated".to_vec(),
        included: true,
        kind: "delegated",
    }];

    // Prefix pruning: /old/note is pruned by the newer /old; /old/newer is
    // newer than /old and stays. The importer keeps what a store would keep.
    let mut pruning_items = vec![];
    for (path, ts, payload) in [
        (path!("/old/note"), t0, b"pruned".to_vec()),
        (path!("/old"), t0 + 1, b"prefix".to_vec()),
        (path!("/old/newer"), t0 + 2, b"kept".to_vec()),
    ] {
        pruning_items.push(Item {
            entry: authorise(entry(&communal, &alice, path, ts, &payload), &alice_cap, &alice_secret),
            payload,
            included: true,
            kind: "communal",
        });
    }

    let mut expected = String::from("{\n  \"generator\": \"willow25 0.7.9\",\n  \"drops\": {");
    for (i, (name, items)) in [
        ("communal", &communal_items),
        ("owned", &owned_items),
        ("delegated", &delegated_items),
        ("pruning", &pruning_items),
        ("empty", &vec![]),
    ]
    .into_iter()
    .enumerate()
    {
        let bytes = encode(items);
        check(&bytes, items);
        std::fs::write(format!("{dir}/{name}.drop"), &bytes).unwrap();
        let comma = if i == 0 { "" } else { "," };
        write!(expected, "{comma}\n    \"{name}\": {}", describe(items)).unwrap();
    }
    expected.push_str("\n  }\n}\n");
    std::fs::write(format!("{dir}/expected.json"), expected).unwrap();
}
