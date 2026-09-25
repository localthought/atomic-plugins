import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from './resolver.mjs';
import { classes, properties } from './terms.mjs';

const NAME = 'https://atomicdata.dev/properties/name';
const ENTRY = classes['time-entry-v1'];
const START = properties['work-start'].subject;
const END = properties['work-end'].subject;

// A Time tracker template table: its own class, per-drive work-* terms with
// the same shortnames as the shared ones (#177 §3.1).
const TEMPLATE = 'https://drive.example/ontology/classes/time-tracker-row';
const T = {
  start: 'https://drive.example/ontology/properties/work-start',
  end: 'https://drive.example/ontology/properties/work-end',
};

const templateLens = {
  from: TEMPLATE,
  to: ENTRY.subject,
  read: row => ({
    [NAME]: row[NAME],
    [START]: row[T.start],
    [END]: row[T.end],
  }),
  write: patch => {
    const out = {};
    if (NAME in patch) out[NAME] = patch[NAME];
    if (START in patch) out[T.start] = patch[START];
    if (END in patch) out[T.end] = patch[END];

    return out;
  },
};

test('accepts exactly the shared classes it renders', () => {
  const r = createResolver({ classes: [ENTRY] });
  assert.deepEqual(r.classes, [ENTRY.subject]);
  assert.equal(r.accepts(ENTRY.subject), true);
  assert.equal(r.accepts(classes['event-v1'].subject), false);
  // No matching by shortname, trailing slash or version-less name.
  assert.equal(r.accepts(`${ENTRY.subject}/`), false);
  assert.equal(r.accepts(TEMPLATE), false);
  assert.equal(r.match(TEMPLATE), null);
});

test('reads fields by exact property subject only', () => {
  const r = createResolver({ classes: [ENTRY] });
  const reading = r.read(
    {
      [NAME]: 'Planning',
      [START]: 1_758_000_000_000,
      // A column with the same shortname but another subject is not a field.
      [T.end]: 1_758_000_360_000,
      'https://drive.example/ontology/properties/clockify-entry-id': 'abc',
    },
    ENTRY.subject,
  );
  assert.deepEqual(reading, {
    class: ENTRY.subject,
    via: 'shared',
    values: { [NAME]: 'Planning', [START]: 1_758_000_000_000 },
    missing: [],
    complete: true,
  });
});

test('a row without a required field is incomplete, not skipped', () => {
  const r = createResolver({ classes: [ENTRY] });
  const reading = r.read({ [NAME]: 'No start', [START]: '' }, ENTRY.subject);
  assert.deepEqual(reading.missing, [START]);
  assert.equal(reading.complete, false);
  assert.deepEqual(reading.values, { [NAME]: 'No start' });
});

test('reading or writing a class it neither renders nor lenses throws', () => {
  const r = createResolver({ classes: [ENTRY] });
  assert.throws(() => r.read({}, TEMPLATE), /not a class this view renders/);
  assert.throws(() => r.write({}, TEMPLATE), /not a class this view renders/);
});

test('writes only the shared class fields', () => {
  const r = createResolver({ classes: [ENTRY] });
  assert.deepEqual(r.write({ [END]: 5 }, ENTRY.subject), { [END]: 5 });
  assert.throws(
    () => r.write({ [T.end]: 5 }, ENTRY.subject),
    /is not a field of .*time-entry-v1/,
  );
});

test('a lens brings another class to the view, both ways', () => {
  const r = createResolver({ classes: [ENTRY], lenses: [templateLens] });
  assert.equal(r.accepts(TEMPLATE), true);
  assert.equal(r.match(TEMPLATE).kind, 'lens');
  const reading = r.read(
    { [NAME]: 'Template row', [T.start]: 10, [T.end]: 20 },
    TEMPLATE,
  );
  assert.deepEqual(reading, {
    class: ENTRY.subject,
    via: 'lens',
    values: { [NAME]: 'Template row', [START]: 10, [END]: 20 },
    missing: [],
    complete: true,
  });
  assert.deepEqual(r.write({ [END]: 30 }, TEMPLATE), { [T.end]: 30 });
});

test('a lens without write is read-only', () => {
  const { write: _, ...readOnly } = templateLens;
  const r = createResolver({ classes: [ENTRY], lenses: [readOnly] });
  assert.equal(r.read({ [T.start]: 1 }, TEMPLATE).complete, true);
  assert.throws(() => r.write({ [END]: 2 }, TEMPLATE), /read-only/);
});

test('refuses lenses that would make matching ambiguous', () => {
  assert.throws(
    () =>
      createResolver({
        classes: [ENTRY],
        lenses: [{ ...templateLens, to: classes['event-v1'].subject }],
      }),
    /which this resolver does not render/,
  );
  assert.throws(
    () =>
      createResolver({
        classes: [ENTRY],
        lenses: [{ ...templateLens, from: ENTRY.subject }],
      }),
    /needs no lens/,
  );
  assert.throws(
    () =>
      createResolver({
        classes: [ENTRY],
        lenses: [templateLens, templateLens],
      }),
    /two lenses map from/,
  );
  assert.throws(
    () =>
      createResolver({
        classes: [ENTRY],
        lenses: [{ from: TEMPLATE, to: ENTRY.subject }],
      }),
    /needs a read function/,
  );
});

test('needs shared classes in the shape terms.mjs exports', () => {
  assert.throws(() => createResolver({ classes: [] }), /at least one/);
  assert.throws(
    () => createResolver({ classes: [{ subject: ENTRY.subject }] }),
    /terms\.mjs/,
  );
});
