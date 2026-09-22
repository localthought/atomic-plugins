import { describe, expect, it } from 'vitest';
import { discoverResources } from '../../../src/resources/discover.js';

describe('discoverResources', () => {
  it('pairs a collection path with its item path', () => {
    const resources = discoverResources({
      '/pets': {},
      '/pets/{petId}': {},
    });

    expect(resources).toEqual([
      {
        collectionPath: '/pets',
        itemPath: '/pets/{petId}',
        itemParam: 'petId',
        updateMethod: 'PUT',
      },
    ]);
  });

  it('uses PATCH as the update method when the item path only offers patch', () => {
    const resources = discoverResources({
      '/repos/{owner}/{repo}/issues': { post: {}, get: {} },
      '/repos/{owner}/{repo}/issues/{issue_number}': { get: {}, patch: {} },
    });

    expect(resources[0]?.updateMethod).toBe('PATCH');
  });

  it('prefers PUT when the item path declares both put and patch', () => {
    const resources = discoverResources({
      '/calendars': {},
      '/calendars/{calendarId}': { put: {}, patch: {} },
    });

    expect(resources[0]?.updateMethod).toBe('PUT');
  });

  it('omits paths that have no matching item path', () => {
    const resources = discoverResources({
      '/health': {},
      '/pets': {},
      '/pets/{petId}': {},
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]?.collectionPath).toBe('/pets');
  });

  it('does not pair paths from unrelated collections', () => {
    const resources = discoverResources({
      '/pets': {},
      '/owners/{ownerId}': {},
    });

    expect(resources).toEqual([]);
  });
});
