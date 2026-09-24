// browser/lib/src/subject.ts
var ATOMIC_PREFIX = "atomic:";
var DID_AD_PREFIX = "did:ad:";
function isLegacyAtomicLink(raw) {
  return raw.startsWith("atomic://");
}
function startsWithAtomicScheme(raw) {
  return raw.startsWith(ATOMIC_PREFIX) && !isLegacyAtomicLink(raw);
}
function isAtomicIdentifier(raw) {
  return startsWithAtomicScheme(raw) || raw.startsWith(DID_AD_PREFIX);
}
function canonicalizeScheme(raw) {
  if (raw.startsWith(DID_AD_PREFIX)) {
    return ATOMIC_PREFIX + raw.slice(DID_AD_PREFIX.length);
  }
  return raw;
}
function canonicalIdentifier(raw) {
  if (!isAtomicIdentifier(raw)) {
    return raw;
  }
  return canonicalizeScheme(raw.split(/[?#]/)[0]);
}

// browser/lib/src/import-resolution.ts
var IMPORT_RESOLUTION = "https://atomicdata.dev/properties/importResolution";
var IMPORT_REFERENCE_REVIEW = "https://atomicdata.dev/properties/importReferenceReview";
var base = "https://atomicdata.dev/properties/";
var ignored = /* @__PURE__ */ new Set([
  "@id",
  ...[
    "subject",
    "loroUpdate",
    "lastCommit",
    "createdAt",
    "updatedAt",
    "createdBy",
    "modifiedAt",
    "modifiedBy",
    "genesis",
    "importResolution"
  ].map((p) => base + p)
]);
function importReviewSnapshot(row) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !ignored.has(key))
  );
}
function equalImportValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalImportValue(v, b[i]));
  const left = Object.entries(a), right = Object.keys(b);
  return left.length === right.length && left.every(
    ([key, value]) => Object.hasOwn(b, key) && equalImportValue(value, b[key])
  );
}
var pure = (s) => canonicalIdentifier(s);
function marker(row) {
  const v = row[IMPORT_RESOLUTION];
  return v?.version === 1 && typeof v.id === "string" && typeof v.canonical === "string" && v.members && typeof v.members === "object" && Array.isArray(v.supersedes) ? v : void 0;
}
function resolvedImportSubject(rows) {
  const entries = Object.entries(rows);
  if (entries.length === 1 && !entries[0][1][IMPORT_RESOLUTION])
    return entries[0][0];
  const winners = entries.filter(([subject, row]) => {
    const resolution = marker(row);
    if (!resolution || resolution.canonical !== pure(subject) || Object.keys(resolution.members).length !== entries.length)
      return false;
    return entries.every(([other, value]) => {
      const reviewed = resolution.members[pure(other)];
      if (!reviewed) return false;
      if (other === subject) return true;
      const otherMarker = marker(value);
      return (!otherMarker || resolution.supersedes.includes(otherMarker.id)) && equalImportValue(reviewed, importReviewSnapshot(value));
    });
  });
  return winners.length === 1 ? winners[0][0] : void 0;
}

// browser/lib/src/import-records.ts
var IMPORT_LOCAL_ID = "https://atomicdata.dev/properties/localId";
var IMPORT_BASELINE = "https://atomicdata.dev/properties/importBaseline";
var PARENT = "https://atomicdata.dev/properties/parent";
var IS_A = "https://atomicdata.dev/properties/isA";
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}
var same = (a, b) => canonical(a) === canonical(b);
var pure2 = (subject) => typeof subject === "string" ? canonicalIdentifier(subject) : subject;
function importRecords(host, records) {
  const intents = [], problems = [];
  const bindings = /* @__PURE__ */ new Map();
  const snapshots = /* @__PURE__ */ new Map();
  const pending = new Map(records.map((record) => [record.localId, record]));
  if (pending.size !== records.length)
    throw new Error("Duplicate localId in import batch");
  const identities = /* @__PURE__ */ new Set();
  let unchanged = 0, created = 0, updated = 0;
  const read = (subject) => {
    if (!snapshots.has(subject)) snapshots.set(subject, host.read(subject));
    return snapshots.get(subject);
  };
  const resolve = (value) => {
    if (typeof value === "string" && value.startsWith("local:")) {
      const id = value.slice(6);
      if (!bindings.has(id))
        throw new Error(`Unknown import reference ${value}`);
      return bindings.get(id);
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, resolve(v)])
      );
    return value;
  };
  const destinations = /* @__PURE__ */ new Map();
  while (pending.size) {
    let progress = false;
    for (const [id, record] of pending) {
      if (!record.sourceId || !id)
        throw new Error("Import records need sourceId and localId");
      if (record.parent.startsWith("local:") && !bindings.has(record.parent.slice(6)))
        continue;
      const parent = resolve(record.parent);
      destinations.set(id, parent);
      const key = canonical([pure2(parent), record.sourceId]);
      if (identities.has(key))
        throw new Error(
          "Duplicate destination/source identity in import batch"
        );
      identities.add(key);
      let matches = [];
      if (!parent.startsWith("local:")) {
        const match = (property, value) => host.query(property, value).filter((subject2) => {
          const row = read(subject2);
          return pure2(row[PARENT]) === pure2(parent) && same(row[property], value);
        });
        matches = match(IMPORT_LOCAL_ID, record.sourceId);
        if (!matches.length && record.legacy)
          matches = match(record.legacy.property, record.legacy.value);
      }
      let unresolved = false;
      if (matches.length > 1 || matches[0] && read(matches[0])[IMPORT_RESOLUTION]) {
        const resolved = resolvedImportSubject(
          Object.fromEntries(matches.map((subject2) => [subject2, read(subject2)]))
        );
        if (resolved) matches = [resolved];
        else unresolved = true;
      }
      if (unresolved) {
        problems.push({
          severity: "error",
          message: "Multiple records represent the same source. Review both before importing again.",
          property: IMPORT_LOCAL_ID,
          importCollision: [...matches].sort()
        });
        return {
          intents,
          problems,
          summary: { created: 0, updated: 0, unchanged: 0 }
        };
      }
      const subject = matches[0];
      if (subject) {
        const current = read(subject);
        const classes = current[IS_A];
        if (!Array.isArray(classes) || record.isA.some((klass) => !classes.includes(klass)))
          throw new Error("Import identity belongs to a different class");
        const persisted = current[IMPORT_LOCAL_ID];
        if (persisted !== void 0 && persisted !== record.sourceId)
          throw new Error("Existing record belongs to another import identity");
      }
      bindings.set(id, subject ?? `local:${id}`);
      pending.delete(id);
      progress = true;
    }
    if (!progress) throw new Error("Import parent cycle");
  }
  for (const record of records) {
    for (const key of [
      PARENT,
      IS_A,
      IMPORT_LOCAL_ID,
      IMPORT_BASELINE,
      IMPORT_RESOLUTION,
      IMPORT_REFERENCE_REVIEW
    ]) {
      if (key in record.values)
        throw new Error(
          "Source values cannot set import identity or baseline metadata"
        );
    }
    const values = resolve(record.values);
    const subject = bindings.get(record.localId);
    if (subject.startsWith("local:")) {
      intents.push({
        op: "create",
        localId: record.localId,
        parent: destinations.get(record.localId),
        isA: record.isA,
        set: {
          ...values,
          [IMPORT_LOCAL_ID]: record.sourceId,
          [IMPORT_BASELINE]: { values, previous: {} }
        }
      });
      created++;
      continue;
    }
    const current = read(subject);
    const baseline = current[IMPORT_BASELINE];
    if (baseline && (!baseline.values || typeof baseline.values !== "object" || Array.isArray(baseline.values)))
      throw new Error("Invalid saved import baseline");
    const prior = baseline?.values;
    const next = { ...prior, ...values };
    const set = {};
    let conflict = false;
    for (const [property, incoming] of Object.entries(values)) {
      const changedAppendSource = !!prior && record.mode === "append" && !same(prior[property], incoming);
      if (same(current[property], incoming) && !changedAppendSource) continue;
      if (!prior || changedAppendSource || !same(current[property], prior[property]) && !same(incoming, prior[property])) {
        problems.push({
          severity: "error",
          subject,
          property,
          importConflict: {
            source: incoming,
            current: current[property],
            previous: prior?.[property],
            appendOnly: record.mode === "append"
          },
          message: prior ? "Source and local values conflict; resolve this record before importing." : "Existing record has no import baseline and differs from the source; review it before adoption."
        });
        conflict = true;
        continue;
      }
      if (same(incoming, prior[property])) continue;
      set[property] = incoming;
    }
    if (conflict) continue;
    if (!same(prior, next))
      set[IMPORT_BASELINE] = { values: next, previous: prior ?? {} };
    if (current[IMPORT_LOCAL_ID] === void 0)
      set[IMPORT_LOCAL_ID] = record.sourceId;
    if (Object.keys(set).length) {
      intents.push({ op: "set", subject, set });
      updated++;
    } else unchanged++;
  }
  return { intents, problems, summary: { created, updated, unchanged } };
}

// browser/lib/node_modules/@noble/ed25519/index.js
var ed25519_CURVE = Object.freeze({
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
});
var { p: P, n: N, Gx, Gy, a: _a, d: _d, h } = ed25519_CURVE;
var L = 32;
var captureTrace = (...args) => {
  if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(...args);
  }
};
var err = (message = "") => {
  const e = new Error(message);
  captureTrace(e, err);
  throw e;
};
var isBig = (n) => typeof n === "bigint";
var isStr = (s) => typeof s === "string";
var isBytes = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
var abytes = (value, length, title = "") => {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    const msg = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    throw bytes ? new RangeError(msg) : new TypeError(msg);
  }
  return value;
};
var u8n = (len) => new Uint8Array(len);
var u8fr = (buf) => Uint8Array.from(buf);
var padh = (n, pad) => n.toString(16).padStart(pad, "0");
var bytesToHex = (b) => Array.from(abytes(b)).map((e) => padh(e, 2)).join("");
var C = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
var _ch = (ch) => {
  if (ch >= C._0 && ch <= C._9)
    return ch - C._0;
  if (ch >= C.A && ch <= C.F)
    return ch - (C.A - 10);
  if (ch >= C.a && ch <= C.f)
    return ch - (C.a - 10);
  return;
};
var hexToBytes = (hex2) => {
  const e = "hex invalid";
  if (!isStr(hex2))
    return err(e);
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    return err(e);
  const array = u8n(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = _ch(hex2.charCodeAt(hi));
    const n2 = _ch(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0)
      return err(e);
    array[ai] = n1 * 16 + n2;
  }
  return array;
};
var cr = () => globalThis?.crypto;
var subtle = () => cr()?.subtle ?? err("crypto.subtle must be defined, consider polyfill");
var concatBytes = (...arrs) => {
  let len = 0;
  for (const a of arrs)
    len += abytes(a).length;
  const r = u8n(len);
  let pad = 0;
  arrs.forEach((a) => {
    r.set(a, pad);
    pad += a.length;
  });
  return r;
};
var big = BigInt;
var assertRange = (n, min, max, msg = "bad number: out of range") => {
  if (!isBig(n))
    throw new TypeError(msg);
  if (min <= n && n < max)
    return n;
  throw new RangeError(msg);
};
var M = (a, b = P) => {
  const r = a % b;
  return r >= 0n ? r : b + r;
};
var P_MASK = (1n << 255n) - 1n;
var modP = (num) => {
  if (num < 0n)
    err("negative coordinate");
  let r = (num >> 255n) * 19n + (num & P_MASK);
  r = (r >> 255n) * 19n + (r & P_MASK);
  return r % P;
};
var modN = (a) => M(a, N);
var invert = (num, md) => {
  if (num === 0n || md <= 0n)
    err("no inverse n=" + num + " mod=" + md);
  let a = M(num, md), b = md, x = 0n, y = 1n, u = 1n, v = 0n;
  while (a !== 0n) {
    const q = b / a, r = b % a;
    const m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  return b === 1n ? M(x, md) : err("no inverse");
};
var callHash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function")
    err("hashes." + name + " not set");
  return fn;
};
var checkDigest = (value) => abytes(value, 64, "digest");
var apoint = (p) => p instanceof Point ? p : err("Point expected");
var B256 = 2n ** 256n;
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  T;
  // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
  // on-curve or that T matches X*Y/Z.
  constructor(X, Y, Z, T) {
    const max = B256;
    this.X = assertRange(X, 0n, max);
    this.Y = assertRange(Y, 0n, max);
    this.Z = assertRange(Z, 1n, max);
    this.T = assertRange(T, 0n, max);
    Object.freeze(this);
  }
  static CURVE() {
    return ed25519_CURVE;
  }
  static fromAffine(p) {
    return new _Point(p.x, p.y, 1n, modP(p.x * p.y));
  }
  /** RFC8032 5.1.3: Bytes to Point. */
  static fromBytes(hex2, zip215 = false) {
    const d = _d;
    const normed = u8fr(abytes(hex2, L));
    const lastByte = hex2[31];
    normed[31] = lastByte & ~128;
    const y = bytesToNumberLE(normed);
    const max = zip215 ? B256 : P;
    assertRange(y, 0n, max);
    const y2 = modP(y * y);
    const u = M(y2 - 1n);
    const v = modP(d * y2 + 1n);
    let { isValid, value: x } = uvRatio(u, v);
    if (!isValid)
      err("bad point: y not sqrt");
    const isXOdd = (x & 1n) === 1n;
    const isLastByteOdd = (lastByte & 128) !== 0;
    if (!zip215 && x === 0n && isLastByteOdd)
      err("bad point: x==0, isLastByteOdd");
    if (isLastByteOdd !== isXOdd)
      x = M(-x);
    return new _Point(x, y, 1n, modP(x * y));
  }
  static fromHex(hex2, zip215) {
    return _Point.fromBytes(hexToBytes(hex2), zip215);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const a = _a;
    const d = _d;
    const p = this;
    if (p.is0())
      return err("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * (aX2 + Y2));
    const right = M(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      return err("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      return err("bad point: equation left != right (2)");
    return this;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const X1Z2 = modP(X1 * Z2);
    const X2Z1 = modP(X2 * Z1);
    const Y1Z2 = modP(Y1 * Z2);
    const Y2Z1 = modP(Y2 * Z1);
    return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
  }
  is0() {
    return this.equals(I);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(M(-this.X), this.Y, this.Z, M(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const a = _a;
    const A = modP(X1 * X1);
    const B = modP(Y1 * Y1);
    const C2 = modP(2n * Z1 * Z1);
    const D = modP(a * A);
    const x1y1 = M(X1 + Y1);
    const E = M(modP(x1y1 * x1y1) - A - B);
    const G2 = M(D + B);
    const F = M(G2 - C2);
    const H = M(D - B);
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(other) {
    const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
    const { X: X2, Y: Y2, Z: Z2, T: T2 } = apoint(other);
    const a = _a;
    const d = _d;
    const A = modP(X1 * X2);
    const B = modP(Y1 * Y2);
    const C2 = modP(modP(T1 * d) * T2);
    const D = modP(Z1 * Z2);
    const E = M(modP(M(X1 + Y1) * M(X2 + Y2)) - A - B);
    const F = M(D - C2);
    const G2 = M(D + C2);
    const H = M(B - modP(a * A));
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
   * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n - scalar by which point is multiplied
   * @param safe - safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n)
      return I;
    assertRange(n, 1n, N);
    if (!safe && this.is0())
      return I;
    if (n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I;
    let f = G;
    for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X, Y, Z } = this;
    if (this.equals(I))
      return { x: 0n, y: 1n };
    const iz = invert(Z, P);
    if (modP(Z * iz) !== 1n)
      err("invalid inverse");
    const x = modP(X * iz);
    const y = modP(Y * iz);
    return { x, y };
  }
  toBytes() {
    const { x, y } = this.toAffine();
    const b = numTo32bLE(y);
    b[31] |= x & 1n ? 128 : 0;
    return b;
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(big(h), false);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let p = this.multiply(N / 2n, false).double();
    if (N % 2n)
      p = p.add(this);
    return p.is0();
  }
};
var G = new Point(Gx, Gy, 1n, M(Gx * Gy));
var I = new Point(0n, 1n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var numTo32bLE = (num) => hexToBytes(padh(assertRange(num, 0n, B256), 64)).reverse();
var bytesToNumberLE = (b) => big("0x" + bytesToHex(u8fr(abytes(b)).reverse()));
var pow2 = (x, power) => {
  let r = x;
  while (power-- > 0n) {
    r = modP(r * r);
  }
  return r;
};
var pow_2_252_3 = (x) => {
  const x2 = modP(x * x);
  const b2 = modP(x2 * x);
  const b4 = modP(pow2(b2, 2n) * b2);
  const b5 = modP(pow2(b4, 1n) * x);
  const b10 = modP(pow2(b5, 5n) * b5);
  const b20 = modP(pow2(b10, 10n) * b10);
  const b40 = modP(pow2(b20, 20n) * b20);
  const b80 = modP(pow2(b40, 40n) * b40);
  const b160 = modP(pow2(b80, 80n) * b80);
  const b240 = modP(pow2(b160, 80n) * b80);
  const b250 = modP(pow2(b240, 10n) * b10);
  const pow_p_5_8 = modP(pow2(b250, 2n) * x);
  return { pow_p_5_8, b2 };
};
var RM1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
var uvRatio = (u, v) => {
  const v3 = modP(v * modP(v * v));
  const v7 = modP(modP(v3 * v3) * v);
  const pow = pow_2_252_3(modP(u * v7)).pow_p_5_8;
  let x = modP(u * modP(v3 * pow));
  const vx2 = modP(v * modP(x * x));
  const root1 = x;
  const root2 = modP(x * RM1);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === M(-u);
  const noRoot = vx2 === M(-u * RM1);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if ((M(x) & 1n) === 1n)
    x = M(-x);
  return { isValid: useRoot1 || useRoot2, value: x };
};
var modL_LE = (hash) => modN(bytesToNumberLE(hash));
var sha512s = (...m) => checkDigest(callHash("sha512")(concatBytes(...m)));
var hashFinishS = (res) => res.finish(sha512s(res.hashable));
var defaultVerifyOpts = { zip215: true };
var _verify = (sig, msg, publicKey, options = defaultVerifyOpts) => {
  sig = abytes(sig, 64);
  msg = abytes(msg);
  publicKey = abytes(publicKey, L);
  const { zip215 = true } = options;
  const r = sig.subarray(0, L);
  const s = bytesToNumberLE(sig.subarray(L, L * 2));
  let A, R, SB;
  let hashable = Uint8Array.of();
  let finished = false;
  try {
    A = Point.fromBytes(publicKey, zip215);
    R = Point.fromBytes(r, zip215);
    SB = G.multiply(s, false);
    hashable = concatBytes(r, publicKey, msg);
    finished = true;
  } catch (error) {
  }
  const finish = (hashed) => {
    if (!finished)
      return false;
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = modL_LE(hashed);
    const RkA = R.add(A.multiply(k, false));
    return RkA.subtract(SB).clearCofactor().is0();
  };
  return { hashable, finish };
};
var verify = (signature, message, publicKey, opts = defaultVerifyOpts) => hashFinishS(_verify(signature, message, publicKey, opts));
var hashes = {
  sha512Async: async (message) => {
    const s = subtle();
    const m = concatBytes(message);
    return u8n(await s.digest("SHA-512", m.buffer));
  },
  sha512: void 0
};
var W = 8;
var scalarBits = 256;
var pwindows = Math.ceil(scalarBits / W) + 1;
var pwindowSize = 2 ** (W - 1);
var precompute = () => {
  const points = [];
  let p = G;
  let b = p;
  for (let w = 0; w < pwindows; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < pwindowSize; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  const pow_2_w = 2 ** W;
  const maxNum = pow_2_w;
  const mask = big(pow_2_w - 1);
  const shiftBy = big(W);
  for (let w = 0; w < pwindows; w++) {
    let wbits = Number(n & mask);
    n >>= shiftBy;
    if (wbits > pwindowSize) {
      wbits -= maxNum;
      n += 1n;
    }
    const off = w * pwindowSize;
    const offF = off;
    const offP = off + Math.abs(wbits) - 1;
    const isEven = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isEven, comp[offF]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n)
    err("invalid wnaf");
  return { p, f };
};

// browser/lib/node_modules/@noble/hashes/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    const message = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    if (!bytes)
      throw new TypeError(message);
    throw new RangeError(message);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes2(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new RangeError('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// browser/lib/node_modules/@noble/hashes/_md.js
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// browser/lib/node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h: h2, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h2, l];
  }
  return [Ah, Al];
}
var shrSH = (h2, _l, s) => h2 >>> s;
var shrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrSH = (h2, l, s) => h2 >>> s | l << 32 - s;
var rotrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrBH = (h2, l, s) => h2 << 64 - s | l >>> s - 32;
var rotrBL = (h2, l, s) => h2 >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// browser/lib/node_modules/@noble/hashes/sha2.js
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA2_64B = class extends HashMD {
  constructor(outputLen) {
    super(128, outputLen, 16, false);
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var _SHA512 = class extends SHA2_64B {
  Ah = SHA512_IV[0] | 0;
  Al = SHA512_IV[1] | 0;
  Bh = SHA512_IV[2] | 0;
  Bl = SHA512_IV[3] | 0;
  Ch = SHA512_IV[4] | 0;
  Cl = SHA512_IV[5] | 0;
  Dh = SHA512_IV[6] | 0;
  Dl = SHA512_IV[7] | 0;
  Eh = SHA512_IV[8] | 0;
  El = SHA512_IV[9] | 0;
  Fh = SHA512_IV[10] | 0;
  Fl = SHA512_IV[11] | 0;
  Gh = SHA512_IV[12] | 0;
  Gl = SHA512_IV[13] | 0;
  Hh = SHA512_IV[14] | 0;
  Hl = SHA512_IV[15] | 0;
  constructor() {
    super(64);
  }
};
var sha512 = /* @__PURE__ */ createHasher(
  () => new _SHA512(),
  /* @__PURE__ */ oidNist(3)
);

// integrations/willow-drop/encoding.ts
var MCL = 4096;
var MCC = 4096;
var MPL = 4096;
var DropError = class extends Error {
  constructor(message, entry) {
    super(entry === void 0 ? message : `Entry ${entry + 1}: ${message}`);
    this.entry = entry;
  }
  entry;
};
var Reader = class {
  constructor(bytes) {
    this.bytes = bytes;
  }
  bytes;
  offset = 0;
  get remaining() {
    return this.bytes.length - this.offset;
  }
  peek() {
    if (this.offset >= this.bytes.length)
      throw new DropError("the drop ends in the middle of an entry");
    return this.bytes[this.offset];
  }
  byte() {
    const value = this.peek();
    this.offset++;
    return value;
  }
  take(count) {
    if (count > this.remaining)
      throw new DropError("the drop ends in the middle of an entry");
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }
  /** A compact U64 whose `width`-bit tag sits at bit `offset` of `tagByte`
   * (bit 0 is the most significant). */
  cu64(tagByte, width, offset) {
    const max = (1 << width) - 1;
    const tag = tagByte >> 8 - offset - width & max;
    const bytes = [8, 4, 2, 1][max - tag];
    if (bytes === void 0) return BigInt(tag);
    let value = 0n;
    for (const b of this.take(bytes)) value = value << 8n | BigInt(b);
    return value;
  }
  /** A compact U64 preceded by its own 8-bit tag byte. */
  cu64Standalone() {
    return this.cu64(this.byte(), 8, 0);
  }
};
function small(value, limit, what) {
  if (value > BigInt(limit)) throw new DropError(`${what} exceeds ${limit}`);
  return Number(value);
}
function decodeComponents(reader, prefix, count, totalLength) {
  const path = [...prefix];
  let accumulated = prefix.reduce((sum, c) => sum + c.length, 0);
  if (count === 0) {
    if (totalLength > accumulated)
      throw new DropError("a path claims more bytes than its components hold");
    return path;
  }
  for (let i = 1; i < count; i++) {
    const length = small(reader.cu64Standalone(), MCL, "a path component");
    accumulated += length;
    path.push(reader.take(length));
  }
  const last = totalLength - accumulated;
  if (last < 0 || last > MCL)
    throw new DropError("a path has an invalid final component length");
  path.push(reader.take(last));
  return path;
}
function decodeRelativePath(reader, previous) {
  const prefixCount = small(reader.cu64Standalone(), MCC, "a path prefix");
  const header = reader.byte();
  const suffixLength = small(reader.cu64(header, 4, 0), MPL, "a path");
  const suffixCount = small(reader.cu64(header, 4, 4), MCC, "a path");
  if (prefixCount > previous.length)
    throw new DropError("a path reuses more components than exist");
  const prefix = previous.slice(0, prefixCount);
  const prefixLength = prefix.reduce((sum, c) => sum + c.length, 0);
  if (prefixLength + suffixLength > MPL || prefixCount + suffixCount > MCC)
    throw new DropError("a path exceeds the Willow25 limits");
  return decodeComponents(
    reader,
    prefix,
    suffixCount,
    prefixLength + suffixLength
  );
}
function tagFor(n, width) {
  const maxInline = BigInt((1 << width) - 4);
  const max = (1 << width) - 1;
  if (n < maxInline) return Number(n);
  if (n < 256n) return max - 3;
  if (n < 65536n) return max - 2;
  if (n < 4294967296n) return max - 1;
  return max;
}
function cu64Bytes(n, width) {
  const size = [8, 4, 2, 1][(1 << width) - 1 - tagFor(n, width)];
  if (size === void 0) return [];
  const out = [];
  for (let i = size - 1; i >= 0; i--)
    out.push(Number(n >> BigInt(i * 8) & 0xffn));
  return out;
}
function encodeCu64Standalone(n) {
  return [tagFor(n, 8), ...cu64Bytes(n, 8)];
}
function encodePath(path) {
  const length = BigInt(path.reduce((sum, c) => sum + c.length, 0));
  const count = BigInt(path.length);
  const out = [tagFor(length, 4) << 4 | tagFor(count, 4)];
  out.push(...cu64Bytes(length, 4), ...cu64Bytes(count, 4));
  path.forEach((component, i) => {
    if (i + 1 < path.length)
      out.push(...encodeCu64Standalone(BigInt(component.length)));
    out.push(...component);
  });
  return out;
}
function utf8Text(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let need = 0, code = b, min = 0;
    if (b >= 194 && b <= 223) [need, code, min] = [1, b & 31, 128];
    else if (b >= 224 && b <= 239) [need, code, min] = [2, b & 15, 2048];
    else if (b >= 240 && b <= 244) [need, code, min] = [3, b & 7, 65536];
    else if (b >= 128) return void 0;
    if (i + need >= bytes.length && need > 0) return void 0;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 192) !== 128) return void 0;
      code = code << 6 | c & 63;
    }
    if (need && code < min || code > 1114111 || code >= 55296 && code <= 57343)
      return void 0;
    out += String.fromCodePoint(code);
    i += need + 1;
  }
  return out;
}
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += BASE64[n >> 18] + BASE64[n >> 12 & 63];
    out += i + 1 < bytes.length ? BASE64[n >> 6 & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}

// integrations/willow-drop/william3.ts
var CHUNK_SIZE = 1024;
var BLOCK_LEN = 64;
var IV = new Uint32Array([
  3364840251,
  1097399282,
  1805854083,
  2969507911,
  2891441277,
  2828210992,
  2037007941,
  1797825518
]);
var MSG_SCHEDULE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
  [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
  [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
  [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
  [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
  [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13]
];
var CHUNK_START = 1;
var CHUNK_END = 2;
var PARENT2 = 4;
var ROOT = 8;
var rotr2 = (x, n) => (x >>> n | x << 32 - n) >>> 0;
function g(s, a, b, c, d, x, y) {
  s[a] = s[a] + s[b] + x >>> 0;
  s[d] = rotr2(s[d] ^ s[a], 16);
  s[c] = s[c] + s[d] >>> 0;
  s[b] = rotr2(s[b] ^ s[c], 12);
  s[a] = s[a] + s[b] + y >>> 0;
  s[d] = rotr2(s[d] ^ s[a], 8);
  s[c] = s[c] + s[d] >>> 0;
  s[b] = rotr2(s[b] ^ s[c], 7);
}
function compress(cv, block, blockLen, counter, flags) {
  const m = new Uint32Array(16);
  for (let i = 0; i < 16; i++)
    m[i] = (block[i * 4] | block[i * 4 + 1] << 8 | block[i * 4 + 2] << 16 | block[i * 4 + 3] << 24) >>> 0;
  const s = new Uint32Array([
    ...cv,
    IV[0],
    IV[1],
    IV[2],
    IV[3],
    Number(counter & 0xffffffffn),
    Number(counter >> 32n & 0xffffffffn),
    blockLen,
    flags
  ]);
  for (const schedule of MSG_SCHEDULE) {
    g(s, 0, 4, 8, 12, m[schedule[0]], m[schedule[1]]);
    g(s, 1, 5, 9, 13, m[schedule[2]], m[schedule[3]]);
    g(s, 2, 6, 10, 14, m[schedule[4]], m[schedule[5]]);
    g(s, 3, 7, 11, 15, m[schedule[6]], m[schedule[7]]);
    g(s, 0, 5, 10, 15, m[schedule[8]], m[schedule[9]]);
    g(s, 1, 6, 11, 12, m[schedule[10]], m[schedule[11]]);
    g(s, 2, 7, 8, 13, m[schedule[12]], m[schedule[13]]);
    g(s, 3, 4, 9, 14, m[schedule[14]], m[schedule[15]]);
  }
  for (let i = 0; i < 8; i++) cv[i] = (s[i] ^ s[i + 8]) >>> 0;
}
function hash1(input, counter, flags, flagsStart, flagsEnd) {
  const cv = new Uint32Array(IV);
  let blockFlags = flags | flagsStart;
  if (input.length === 0) {
    compress(cv, new Uint8Array(BLOCK_LEN), 0, counter, blockFlags | flagsEnd);
  } else {
    for (let offset = 0; offset < input.length; offset += BLOCK_LEN) {
      const rest = input.length - offset;
      const block = new Uint8Array(BLOCK_LEN);
      block.set(input.subarray(offset, offset + Math.min(rest, BLOCK_LEN)));
      if (rest <= BLOCK_LEN) blockFlags |= flagsEnd;
      compress(cv, block, Math.min(rest, BLOCK_LEN), counter, blockFlags);
      blockFlags = flags;
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = cv[i] & 255;
    out[i * 4 + 1] = cv[i] >>> 8 & 255;
    out[i * 4 + 2] = cv[i] >>> 16 & 255;
    out[i * 4 + 3] = cv[i] >>> 24 & 255;
  }
  return out;
}
var hashChunk = (chunk, isRoot) => hash1(chunk, 0n, 0, CHUNK_START, CHUNK_END | (isRoot ? ROOT : 0));
function hashInner(left, right, length, isRoot) {
  const block = new Uint8Array(BLOCK_LEN);
  block.set(left, 0);
  block.set(right, 32);
  return hash1(block, BigInt(length), PARENT2 | (isRoot ? ROOT : 0), 0, 0);
}
function label(bytes, chunks, isRoot) {
  if (chunks <= 1) return hashChunk(bytes, isRoot);
  let left = 1;
  while (left * 2 < chunks) left *= 2;
  const split2 = left * CHUNK_SIZE;
  return hashInner(
    label(bytes.subarray(0, split2), left, false),
    label(bytes.subarray(split2), chunks - left, false),
    bytes.length,
    isRoot
  );
}
function william3(bytes) {
  return label(bytes, Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE)), true);
}

// integrations/willow-drop/drop.ts
hashes.sha512 = sha512;
var MAX_ENTRIES = 1e3;
var hexBytes = (hex2) => new Uint8Array(hex2.match(/../g).map((pair) => parseInt(pair, 16)));
var DEFAULT_ID = hexBytes(
  "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318"
);
var DEFAULT_ENTRY = {
  namespace: DEFAULT_ID,
  subspace: DEFAULT_ID,
  path: [],
  timestamp: 0n,
  payloadLength: 0n,
  payloadDigest: william3(new Uint8Array()),
  capability: { kind: "communal" },
  communal: true
};
var equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
var isCommunal = (namespace) => namespace[31] % 2 === 0;
function signed(key, message, signature) {
  try {
    return verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}
function encodeEntry(entry) {
  return new Uint8Array([
    ...entry.namespace,
    ...entry.subspace,
    ...encodePath(entry.path),
    ...encodeCu64Standalone(entry.timestamp),
    ...encodeCu64Standalone(entry.payloadLength),
    ...entry.payloadDigest
  ]);
}
function decodeToken(reader, previous) {
  const header = reader.byte();
  const shared = reader.cu64(header, 3, 1);
  const delegations = reader.cu64(header, 4, 4);
  if (delegations > 0n)
    throw new DropError(
      "its write capability carries delegations, which this importer does not decode yet"
    );
  if (shared > 1n)
    throw new DropError("its capability reuses delegations that do not exist");
  let capability = { kind: "communal" };
  if (header & 128) {
    if (shared === 0n)
      capability = {
        kind: "owned",
        userKey: reader.take(32),
        initialAuthorisation: reader.take(64)
      };
    else if (previous.kind === "owned") capability = previous;
    else
      throw new DropError(
        "its owned capability claims to repeat a communal one"
      );
  }
  return { capability, signature: reader.take(64) };
}
function decodeDrop(bytes) {
  const reader = new Reader(bytes);
  const entries = [];
  let previous = DEFAULT_ENTRY;
  for (; ; ) {
    const index = entries.length;
    const header = reader.byte();
    if (header === 0) break;
    try {
      if (index >= MAX_ENTRIES)
        throw new DropError(`a drop may hold at most ${MAX_ENTRIES} entries`);
      previous = decodeEntry(reader, header, previous);
    } catch (error) {
      if (error instanceof DropError && error.entry === void 0)
        throw new DropError(error.message, index);
      throw error;
    }
    entries.push(previous);
  }
  if (reader.remaining > 0)
    throw new DropError("there are bytes after the end of the drop");
  return entries;
}
function decodeEntry(reader, header, previous) {
  if ((header & 192) !== 64)
    throw new DropError(
      "it does not start with an entry header; continuation slices are not supported"
    );
  const namespace = header & 32 ? reader.take(32) : previous.namespace;
  const subspace = header & 16 ? reader.take(32) : previous.subspace;
  const path = decodeRelativePath(reader, previous.path);
  const timestamp = reader.cu64(header, 2, 4);
  const payloadLength = reader.cu64Standalone();
  const payloadDigest = reader.take(32);
  const { capability, signature } = decodeToken(reader, previous.capability);
  const fields = {
    namespace,
    subspace,
    path,
    timestamp,
    payloadLength,
    payloadDigest
  };
  const communal = isCommunal(namespace);
  let receiver;
  if (capability.kind === "communal") {
    if (!communal)
      throw new DropError(
        "it uses a communal capability in an owned namespace"
      );
    receiver = subspace;
  } else {
    if (communal)
      throw new DropError(
        "it uses an owned capability in a communal namespace"
      );
    const genesis = new Uint8Array([3, ...capability.userKey]);
    if (!signed(namespace, genesis, capability.initialAuthorisation))
      throw new DropError(
        "its owned capability is not signed by the namespace's key"
      );
    receiver = capability.userKey;
  }
  if (!signed(receiver, encodeEntry(fields), signature))
    throw new DropError("its authorisation signature does not verify");
  const entry = { ...fields, capability, communal };
  const mode = header & 3;
  if (mode === 1) {
    if (payloadLength > BigInt(reader.remaining))
      throw new DropError("the drop ends in the middle of a payload");
    const payload = reader.take(Number(payloadLength));
    if (!equal(william3(payload), payloadDigest))
      throw new DropError("its payload does not match its digest");
    entry.payload = payload;
  } else if (mode === 3) {
    if (reader.remaining > 0 && reader.peek() & 128)
      throw new DropError(
        "it carries partial payload slices, which this importer does not verify yet"
      );
  } else if (mode === 2) {
    throw new DropError(
      `it carries a partial payload prefix (${CHUNK_SIZE}-byte chunks), which this importer does not verify yet`
    );
  }
  return entry;
}

// integrations/willow-drop/mapping.ts
var MAX_STORED_PAYLOAD = 65536;
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var UNRESERVED = /[A-Za-z0-9\-._~]/;
function displayPath(path) {
  return "/" + path.map(
    (component) => Array.from(component, (b) => {
      const char = String.fromCharCode(b);
      return b < 128 && UNRESERVED.test(char) ? char : "%" + b.toString(16).padStart(2, "0");
    }).join("")
  ).join("/");
}
var J2000_TAI_US = 946727967816000n;
var LEAP_SECONDS = [
  [1483228800000000n, 37n],
  // 2017-01-01
  [1435708800000000n, 36n],
  // 2015-07-01
  [1341100800000000n, 35n],
  // 2012-07-01
  [1230768000000000n, 34n],
  // 2009-01-01
  [1136073600000000n, 33n],
  // 2006-01-01
  [0n, 32n]
  // from 1999-01-01, which covers J2000
];
var YEAR_2100_US = 4102444800000000n;
function utcTime(timestamp) {
  const tai = J2000_TAI_US + timestamp;
  const [, offset] = LEAP_SECONDS.find(
    ([start, seconds]) => tai - seconds * 1000000n >= start
  );
  const utc = tai - offset * 1000000n;
  if (utc >= YEAR_2100_US) return void 0;
  const iso = new Date(Number(utc / 1000n)).toISOString();
  return iso.replace("Z", (utc % 1000n).toString().padStart(3, "0") + "Z");
}
var compareBytes = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
function newer(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  const digest = compareBytes(a.payloadDigest, b.payloadDigest);
  if (digest !== 0) return digest > 0;
  return a.payloadLength > b.payloadLength;
}
var sameKeySpace = (a, b) => compareBytes(a.namespace, b.namespace) === 0 && compareBytes(a.subspace, b.subspace) === 0;
var isPrefix = (prefix, path) => prefix.length <= path.length && prefix.every((component, i) => compareBytes(component, path[i]) === 0);
function prune(entries) {
  const kept = entries.filter(
    (entry) => !entries.some(
      (other) => other !== entry && sameKeySpace(other, entry) && isPrefix(other.path, entry.path) && newer(other, entry)
    )
  );
  return { kept, pruned: entries.length - kept.length };
}
var sourceId = (entry) => JSON.stringify([
  "willow25",
  hex(entry.namespace),
  hex(entry.subspace),
  entry.path.map(hex)
]);
function rowValues(entry) {
  const { payload } = entry;
  const stored = payload !== void 0 && payload.length <= MAX_STORED_PAYLOAD;
  const text = stored ? utf8Text(payload) : void 0;
  return {
    "willow-namespace": hex(entry.namespace),
    "willow-subspace": hex(entry.subspace),
    "willow-path": displayPath(entry.path),
    "willow-timestamp": entry.timestamp.toString(),
    "willow-time": utcTime(entry.timestamp) ?? "",
    "willow-payload-length": entry.payloadLength.toString(),
    "willow-payload-digest": hex(entry.payloadDigest),
    "willow-payload-status": stored ? "stored" : payload ? "too-large" : "not-in-drop",
    "willow-payload": text ?? "",
    "willow-payload-base64": stored && text === void 0 ? base64(payload) : "",
    "willow-capability": entry.capability.kind,
    "willow-source-id": sourceId(entry)
  };
}

// integrations/willow-drop/schema.ts
var STRING = "https://atomicdata.dev/datatypes/string";
var FIELDS = [
  [
    "willow-namespace",
    "Namespace",
    "Willow namespace id: a 32-byte ed25519 public key, as 64 lower-case hex digits. Communal when the last byte is even, owned otherwise."
  ],
  [
    "willow-subspace",
    "Subspace",
    "Willow subspace id: a 32-byte ed25519 public key, as 64 lower-case hex digits."
  ],
  [
    "willow-path",
    "Path",
    'Willow path: components joined by "/", each byte outside A-Z a-z 0-9 - . _ ~ percent-encoded (%2f for a slash inside a component).'
  ],
  [
    "willow-timestamp",
    "Timestamp",
    "Exact Willow timestamp as a decimal string of microseconds. The data model recommends, but does not require, TAI since the J2000 epoch (2000-01-01 12:00 TT)."
  ],
  [
    "willow-time",
    "Time (UTC)",
    "The timestamp read as recommended, converted to UTC with the IERS leap seconds up to 2017-01-01, as an ISO 8601 string with microseconds. A leap second announced later would make it one second off. Empty for times after 2099."
  ],
  [
    "willow-payload-length",
    "Payload length",
    "Exact payload length in bytes, as a decimal string."
  ],
  [
    "willow-payload-digest",
    "Payload digest",
    "WILLIAM3 digest of the payload, as 64 lower-case hex digits."
  ],
  [
    "willow-payload",
    "Payload",
    "The payload as text, when its status is stored and it is valid UTF-8; empty otherwise."
  ],
  [
    "willow-payload-base64",
    "Payload (base64)",
    "The payload as standard base64, when its status is stored and it is not valid UTF-8; empty otherwise."
  ],
  [
    "willow-payload-status",
    "Payload status",
    "stored: the drop carried the whole payload, it matched the digest and it is on this row; too-large: verified but longer than 65536 bytes, so not stored; not-in-drop: the drop carried no payload for this entry. Payload fields are empty unless stored."
  ],
  [
    "willow-capability",
    "Capability",
    "Kind of Meadowcap write capability that authorised the entry: communal or owned. Delegated capabilities are not imported yet."
  ],
  [
    "willow-source-id",
    "Source identity",
    "Namespace, subspace and path: the key under which a Willow store keeps only the newest entry."
  ]
];
function willowSchema() {
  return {
    properties: FIELDS.map(([shortname, name, description]) => ({
      shortname,
      name,
      description,
      datatype: STRING
    })),
    classes: [
      {
        shortname: "willow-entry",
        name: "Willow entry",
        description: "An entry imported from a Willow drop, after its Meadowcap authorisation was verified.",
        requires: [
          "willow-namespace",
          "willow-subspace",
          "willow-path",
          "willow-timestamp",
          "willow-payload-length",
          "willow-payload-digest",
          "willow-source-id"
        ],
        recommends: [
          "willow-time",
          "willow-payload-status",
          "willow-payload",
          "willow-payload-base64",
          "willow-capability"
        ]
      }
    ]
  };
}

// integrations/willow-drop/upload.ts
var CP1252_HIGH = [
  8364,
  129,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  141,
  381,
  143,
  144,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  157,
  382,
  376
];
var FROM_CP1252 = new Map(CP1252_HIGH.map((code, i) => [code, 128 + i]));
function utf8Bytes(text) {
  const out = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 128) out.push(code);
    else if (code < 2048) out.push(192 | code >> 6, 128 | code & 63);
    else if (code < 65536)
      out.push(
        224 | code >> 12,
        128 | code >> 6 & 63,
        128 | code & 63
      );
    else
      out.push(
        240 | code >> 18,
        128 | code >> 12 & 63,
        128 | code >> 6 & 63,
        128 | code & 63
      );
  }
  return new Uint8Array(out);
}
function cp1252Bytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code < 128 || code >= 160 && code <= 255 ? code : FROM_CP1252.get(code);
    if (byte === void 0) return void 0;
    out[i] = byte;
  }
  return out;
}
function base64Bytes(text) {
  const clean2 = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean2) || clean2.length % 4 === 1)
    return void 0;
  const body = clean2.replace(/=+$/, "");
  const out = [];
  let bits = 0, value = 0;
  for (const char of body) {
    value = value << 6 | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(value >> bits & 255);
    }
  }
  return new Uint8Array(out);
}
function readUpload(text, parse) {
  const utf8 = utf8Bytes(text);
  const cp1252 = cp1252Bytes(text);
  const base642 = base64Bytes(text);
  const candidates = [
    { encoding: "utf-8", bytes: utf8 }
  ];
  if (cp1252 && utf8Text(cp1252) === void 0)
    candidates.push({ encoding: "windows-1252", bytes: cp1252 });
  if (base642) candidates.push({ encoding: "base64", bytes: base642 });
  const found = [];
  const errors = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    try {
      found.push({ ...candidate, result: parse(candidate.bytes) });
    } catch (error) {
      errors.set(candidate.encoding, error);
    }
  }
  const distinct = found.filter(
    (reading, i) => !found.slice(0, i).some(
      (other) => other.bytes.length === reading.bytes.length && other.bytes.every((b, k) => b === reading.bytes[k])
    )
  );
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1)
    throw new DropError(
      `This file reads as a valid drop in more than one way (${distinct.map((r) => r.encoding).join(", ")}); upload it base64-encoded`
    );
  throw errors.get(
    base642 ? "base64" : errors.has("windows-1252") ? "windows-1252" : "utf-8"
  );
}

// integrations/willow-drop/plugin.ts
var MAX_DROP_BYTES = 5e6;
var PARENT3 = "https://atomicdata.dev/properties/parent";
var NAME = "https://atomicdata.dev/properties/name";
var manifest = {
  schemaVersion: 2,
  name: "willow-drop",
  namespace: "atomic-plugins",
  version: "0.1.0",
  description: "Import entries from a Willow drop file (Willow Drop Format, Willow\u201925 parameters) after verifying their Meadowcap authorisation.",
  operations: [],
  secrets: [],
  config: {
    key: "willowDrop",
    properties: {
      table: {
        type: "string",
        description: "Table the entries are written to"
      },
      rowClass: {
        type: "string",
        description: "Class each imported entry gets"
      },
      properties: {
        type: "object",
        description: "Willow entry properties, by shortname"
      }
    },
    required: ["table", "rowClass", "properties"]
  },
  // The host draws the file picker and hands the file over as text
  // (atomic-server#1653); upload.ts recovers the bytes. `.b64` is a drop
  // uploaded base64-encoded.
  accepts: [
    {
      extensions: [".drop", ".willow", ".b64"],
      mediaTypes: ["application/octet-stream", "text/plain"],
      as: "text",
      maxBytes: MAX_DROP_BYTES
    }
  ],
  destination: {
    schema: willowSchema(),
    table: {
      name: "Willow entries",
      rowClass: "willow-entry",
      columns: [
        "willow-path",
        "willow-time",
        "willow-payload",
        "willow-payload-length",
        "willow-subspace",
        "willow-namespace"
      ]
    }
  }
};
var warning = (message) => ({
  severity: "warning",
  message
});
function run(ctx) {
  const text = ctx.upload?.text;
  if (text === void 0)
    throw new Error(
      "Choose a Willow drop file under Import on this importer's page"
    );
  const { encoding, result: decoded } = readUpload(text, decodeDrop);
  if (ctx.trigger?.payload?.validate) return { intents: [], problems: [] };
  const { table, rowClass, properties: p } = ctx.config ?? {};
  const missing = [
    ["table", table],
    ["rowClass", rowClass],
    ["properties", p]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length)
    throw new Error(
      `Configure this importer before running it: missing ${missing.join(", ")}`
    );
  const absent = FIELDS.map(([shortname]) => shortname).filter((s) => !p[s]);
  if (absent.length)
    throw new Error(
      `Set up this importer again: its config lacks the properties ${absent.join(", ")}`
    );
  const { kept, pruned } = prune(decoded);
  const records = [];
  let older = 0, unstored = 0;
  for (const entry of kept) {
    const identity = sourceId(entry);
    const stored = ctx.query(IMPORT_LOCAL_ID, identity).map((subject) => ctx.read(subject)).find((row) => row[PARENT3] === table);
    const storedTimestamp = stored?.[p["willow-timestamp"]];
    const storedDigest = stored?.[p["willow-payload-digest"]];
    const storedLength = stored?.[p["willow-payload-length"]];
    if (typeof storedTimestamp === "string" && typeof storedDigest === "string" && typeof storedLength === "string" && /^\d+$/.test(storedTimestamp) && /^\d+$/.test(storedLength) && /^[0-9a-f]{64}$/.test(storedDigest) && newer(
      {
        timestamp: BigInt(storedTimestamp),
        payloadDigest: Uint8Array.from(
          storedDigest.match(/../g).map((pair) => parseInt(pair, 16))
        ),
        payloadLength: BigInt(storedLength)
      },
      entry
    )) {
      older++;
      continue;
    }
    const values = rowValues(entry);
    if (values["willow-payload-status"] === "too-large") unstored++;
    records.push({
      sourceId: identity,
      mode: "merge",
      localId: `entry-${records.length}`,
      parent: table,
      isA: [rowClass],
      values: {
        [NAME]: values["willow-path"],
        ...Object.fromEntries(
          Object.entries(values).map(([shortname, value]) => [
            p[shortname],
            value
          ])
        )
      }
    });
  }
  const result = importRecords(ctx, records);
  const notes = [
    `${decoded.length} entries decoded and verified (file read as ${encoding}). ${result.summary.unchanged} previously imported entries unchanged.`
  ];
  if (pruned)
    notes.push(
      `${pruned} entries were left out because a newer entry in the same drop overwrites them (same path or a path prefix).`
    );
  if (older)
    notes.push(
      `${older} entries were left out because the table already holds a newer entry at the same path.`
    );
  if (unstored)
    notes.push(
      `${unstored} payloads are larger than ${MAX_STORED_PAYLOAD} bytes and were verified but not stored.`
    );
  return {
    intents: result.intents,
    problems: [...result.problems, ...notes.map(warning)]
  };
}
export {
  MAX_DROP_BYTES,
  manifest,
  run
};
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)
*/
