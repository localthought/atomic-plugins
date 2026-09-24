import { reconcileRecord } from 'devonian';

import {
  properties,
  value as resourceValue,
  propertiesByField as p,
} from './lens/resources.mjs';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => structuredClone(value);

/** Single-writer, checkpointed reconciliation. Ports own transport and durable writes. */
export class Bridge {
  constructor({ devonian, local, remote, base, snapshot, save }) {
    this.api = devonian;
    this.local = local;
    this.remote = remote;
    this.save = save;
    const { AtomicSchema, AtomicStore, AtomicIdentityMap, Datatype } = devonian;
    this.store = new AtomicStore(
      new AtomicSchema()
        .property(p.title, Datatype.STRING)
        .property(p.body, Datatype.MARKDOWN)
        .property(p.status, Datatype.RESOURCEARRAY),
    );
    this.identities = new AtomicIdentityMap(this.store, base);
    this.binding = { base, local: local.scope, remote: remote.scope };
    if (snapshot && !equal(snapshot.binding, this.binding))
      throw new Error('State belongs to another connection');
    if (snapshot?.graph) this.store.loadJSONAD(snapshot.graph);
    this.records = copy(snapshot?.records ?? {});
    /** Writes a port held for review in the last pass, by subject. See review.mjs. */
    this.held = new Map();
  }

  scope(side, entity) {
    return { scope: this[side].scope, entity };
  }
  id(side, entity, subject) {
    return this.identities.externalId(this.scope(side, entity), subject);
  }
  context(side, entity) {
    if (entity === 'issue') return {};
    const parent = entity.slice('comment:'.length);
    const issueId = this.id(side, 'issue', parent);
    if (issueId === undefined)
      throw new Error('Issue must be mapped before comments');

    return { issueId };
  }
  async checkpoint() {
    await this.save({
      version: 1,
      binding: this.binding,
      graph: this.store.toJSONAD(),
      records: copy(this.records),
    });
  }
  properties(value) {
    return properties(value);
  }
  value(resource, entity) {
    return resourceValue(resource, entity);
  }
  lens(side, entity, operation, metadata) {
    const port = this[side],
      context = this.context(side, entity);

    return new this.api.AtomicLens({
      store: this.store,
      identities: this.identities,
      ...this.scope(side, entity),
      connector: {
        id: row => row.id,
        get: id => port.get(entity, id, context),
        create: (row, key) =>
          port.create(entity, row.value, key, metadata, context),
        update: (id, row) =>
          port.update(
            entity,
            id,
            row.value,
            `${operation}:${side}`,
            metadata,
            context,
          ),
        delete: async () => {
          throw new Error('Deletion is outside issue sync');
        },
      },
      read: row => ({ set: this.properties(row.value) }),
      write: (resource, previous) => ({
        ...previous,
        value: this.value(resource, entity),
      }),
    });
  }

  async sync() {
    this.held.clear();
    // Resume saved operations BEFORE discovering their newly-created counterparts.
    for (const [subject, record] of Object.entries(this.records)) {
      // A held write never sent anything (the gate throws before any
      // request), so it is planned again from both sides' current state.
      if (record.pending?.held) delete record.pending;
      else if (record.pending) await this.attempt(subject, record);
    }

    await this.syncEntity('issue');

    for (const [subject, record] of Object.entries(this.records)) {
      if (record.entity !== 'issue') continue;
      // An issue whose create is held has no counterpart yet, so neither
      // have its comments. They follow once the issue exists on both sides.
      if (
        this.id('local', 'issue', subject) === undefined ||
        this.id('remote', 'issue', subject) === undefined
      )
        continue;
      await this.syncEntity(`comment:${subject}`);
    }
  }

  /** `finish`, except that a write held for review is recorded, not thrown. */
  async attempt(subject, record) {
    try {
      await this.finish(subject, record);
      this.held.delete(subject);
    } catch (error) {
      if (error?.name !== 'ReviewRequired') throw error;
      record.pending.held = true;
      await this.checkpoint();
      this.held.set(subject, {
        subject,
        entity: record.entity,
        remoteId: this.id('remote', record.entity, subject),
        before: copy(record.pending.remote),
        after: copy(record.pending.desired),
        key: error.proposal?.key,
      });
    }
  }

  /**
   * Settle a same-field conflict in favour of one side. Only the conflicting
   * fields' baseline moves to the other side's current value, so on the next
   * pass the kept side's value is the only change for those fields; every
   * other field keeps reconciling normally. Nothing is written to either
   * side here. Returns the fields that were settled.
   */
  async resolveConflict(subject, keep) {
    if (keep !== 'local' && keep !== 'remote')
      throw new Error('Keep either the local or the remote side');
    const record = this.records[subject];
    if (!record) throw new Error(`Unknown record: ${subject}`);
    if (record.pending)
      throw new Error(`Finish the saved operation on ${subject} first`);
    const rows = {};

    for (const side of ['local', 'remote']) {
      const id = this.id(side, record.entity, subject);
      if (id === undefined) throw new Error(`Missing ${side} record: ${subject}`);
      rows[side] = await this[side].get(
        record.entity,
        id,
        this.context(side, record.entity),
      );
    }

    const decision = reconcileRecord(
      record.baseline,
      rows.local.value,
      rows.remote.value,
    );
    const other = keep === 'local' ? 'remote' : 'local';
    const baseline = copy(record.baseline ?? {});

    for (const { property } of decision.conflicts) {
      const value = rows[other].value[property];
      if (value === undefined) delete baseline[property];
      else baseline[property] = copy(value);
    }

    record.baseline = baseline;
    await this.checkpoint();

    return decision.conflicts.map(c => c.property);
  }

  async syncEntity(entity) {
    const lists = {};

    for (const side of ['remote', 'local']) {
      const rows = await this[side].list(entity, this.context(side, entity));
      lists[side] = new Map();

      for (const row of rows) {
        if (lists[side].has(row.id))
          throw new Error('Duplicate external identity');
        lists[side].set(row.id, row);
      }
    }

    // An existing pilot's explicit issue-number column is an identity, never a title match.
    for (const row of lists.local.values()) {
      if (row.remoteId === undefined) continue;
      const scope = this.scope('remote', entity);
      const subject = this.identities.subjectFor(scope, row.remoteId);
      this.identities.bind(scope, row.remoteId, subject);
      this.identities.bind(this.scope('local', entity), row.id, subject);
      this.records[subject] ??= { entity };
    }

    for (const side of ['remote', 'local']) {
      for (const row of lists[side].values()) {
        let subject = this.identities.lookup(this.scope(side, entity), row.id);
        if (!subject) subject = await this.lens(side, entity).ingest(row);
        this.records[subject] ??= { entity };
      }
    }

    await this.checkpoint();

    for (const [subject, record] of Object.entries(this.records)) {
      if (record.entity !== entity) continue;
      const rows = {};

      for (const side of ['local', 'remote']) {
        const id = this.id(side, entity, subject);
        rows[side] = id === undefined ? undefined : lists[side].get(id);
        if (id !== undefined && !rows[side])
          throw new Error(`Missing ${side} record: ${subject}`);
      }

      const decision = reconcileRecord(
        record.baseline,
        rows.local?.value,
        rows.remote?.value,
      );
      if (decision.conflicts.length) {
        const fields = decision.conflicts.map(c => c.property);
        const error = new Error(`Conflict on ${subject}: ${fields.join(', ')}`);
        Object.assign(error, { subject, entity, fields });
        throw error;
      }
      const desired = {
        ...(rows.remote?.value ?? rows.local?.value),
        ...decision.remote,
      };
      const metadata = rows.remote?.metadata;

      if (
        rows.local &&
        rows.remote &&
        equal(rows.local.value, rows.remote.value) &&
        equal(rows.local.metadata, metadata)
      ) {
        record.baseline = copy(desired);
        await this.checkpoint();
        continue;
      }

      record.pending = {
        operation: crypto.randomUUID(),
        local: rows.local?.value,
        remote: rows.remote?.value,
        desired,
        metadata,
      };
      this.store.patch(subject, { set: this.properties(desired) });
      await this.checkpoint();
      await this.attempt(subject, record);
    }
  }

  async finish(subject, record) {
    const { pending, entity } = record;

    // A retry accepts only the original observation or this operation's exact result.
    for (const side of ['local', 'remote']) {
      const id = this.id(side, entity, subject);
      if (id === undefined) continue;
      const row = await this[side].get(entity, id, this.context(side, entity));
      if (
        !equal(row.value, pending[side]) &&
        !equal(row.value, pending.desired)
      )
        throw new Error(`Conflict during saved operation on ${subject}`);
    }

    for (const side of ['remote', 'local']) {
      const id = this.id(side, entity, subject);
      const row =
        id === undefined
          ? undefined
          : await this[side].get(entity, id, this.context(side, entity));

      if (
        !row ||
        !equal(row.value, pending.desired) ||
        (side === 'local' && !equal(row.metadata, pending.metadata))
      ) {
        await this.lens(
          side,
          entity,
          pending.operation,
          pending.metadata,
        ).publish(subject);
        await this.checkpoint();
      }
    }

    for (const side of ['local', 'remote']) {
      const row = await this[side].get(
        entity,
        this.id(side, entity, subject),
        this.context(side, entity),
      );
      if (!equal(row.value, pending.desired))
        throw new Error(`Concurrent edit after write on ${subject}`);
    }

    record.baseline = copy(pending.desired);
    delete record.pending;
    await this.checkpoint();
  }
}
