import { expect, it } from 'vitest';
import { proxyTransport } from './proxy.mjs';

it('needs a dispatch function: there is no direct, code-spending transport any more', () => {
  expect(() =>
    proxyTransport({
      repository: 'owner/repo',
      journal: {},
      save: async () => {},
    }),
  ).toThrow('dispatch');
});

it('serializes calls, preserves query strings and checkpoints successful writes', async () => {
  const seen = [];
  const journal = {};
  let saves = 0;
  let inFlight = 0;
  const call = proxyTransport({
    repository: 'owner/repo',
    journal,
    save: async () => {
      saves++;
    },
    dispatch: async (path, init) => {
      expect(inFlight).toBe(0);
      inFlight++;
      seen.push({ path, ...init });
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;

      return { status: 200, body: '{"id":1}' };
    },
  });
  await Promise.all([
    call('list_issues', { page: 2 }, 'read'),
    call('create_comment', { number: 1, body: 'Hello' }, 'write'),
  ]);
  expect(seen[0].path).toContain(
    '/repos/owner/repo/issues?state=all&per_page=100&page=2',
  );
  expect(seen[1].method).toBe('POST');
  expect(saves).toBe(2);
  await call('create_comment', { number: 1, body: 'Hello' }, 'write');
  expect(seen).toHaveLength(2);
  await expect(
    call('create_comment', { number: 1, body: 'Changed' }, 'write'),
  ).rejects.toThrow('different arguments');
});

it('never retries an uncertain create after a lost response or restart', async () => {
  const journal = {};
  let writes = 0;
  const options = {
    repository: 'owner/repo',
    journal,
    save: async () => {},
    dispatch: async () => {
      writes++;
      throw new Error('Failed to fetch');
    },
  };
  await expect(
    proxyTransport(options)('create_issue', { title: 'Title' }, 'create'),
  ).rejects.toThrow('Proxy request failed');
  await expect(
    proxyTransport(options)('create_issue', { title: 'Title' }, 'create'),
  ).rejects.toThrow('Uncertain GitHub write');
  expect(writes).toBe(1);
});

it('passes provider errors through as receipts', async () => {
  const receipt = await proxyTransport({
    repository: 'owner/repo',
    journal: {},
    save: async () => {},
    dispatch: async () => ({ status: 403, body: '{}' }),
  })('get_issue', { number: 1 }, 'read');
  expect(receipt.status).toBe(403);
});

it('dispatches through the host without handling a credential, and journals its writes', async () => {
  const journal = {};
  const sent = [];
  let failure;
  const call = proxyTransport({
    repository: 'owner/repo',
    journal,
    save: async () => {},
    dispatch: async (path, init) => {
      sent.push([init.method, path]);
      if (failure) throw failure;

      return { status: 200, body: '{"number":1}' };
    },
  });
  await call('list_issues', { page: 2 }, 'read');
  expect(sent[0]).toEqual([
    'GET',
    '/repos/owner/repo/issues?state=all&per_page=100&page=2&sort=created&direction=asc',
  ]);
  expect(journal).toEqual({});

  // Refused by the host before anything left: not uncertain, may be retried.
  failure = Object.assign(new Error('No github-issues connection'), {
    notSent: true,
  });
  await expect(call('create_issue', { title: 'T' }, 'c1')).rejects.toThrow(
    'No github-issues connection',
  );
  expect(journal).toEqual({});
  failure = undefined;
  await call('create_issue', { title: 'T' }, 'c1');
  expect(journal.c1.receipt.status).toBe(200);

  // Lost after it may have left: uncertain, never resent.
  failure = new Error('The host did not answer proxy in time.');
  await expect(
    call('update_comment', { id: 5, body: 'x' }, 'u1'),
  ).rejects.toThrow('Proxy request failed (The host did not answer');
  failure = undefined;
  const before = sent.length;
  await expect(
    call('update_comment', { id: 5, body: 'x' }, 'u1'),
  ).rejects.toThrow('Uncertain GitHub write');
  expect(sent.length).toBe(before);
});
