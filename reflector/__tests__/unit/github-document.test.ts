import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocumentFrom } from '../../src/sync/document.js';
import { discoverResourceModel } from '../../src/sync/resources.js';

const here = dirname();
const repoRoot = resolve(here, '..', '..');

function dirname(): string {
  return resolve(fileURLToPath(import.meta.url), '..');
}

describe('vendored GitHub Issues document', () => {
  it('loads with its overlays and discovers issue + comment collections', async () => {
    const document = await buildDocumentFrom(
      resolve(repoRoot, 'spec/github-issues.openapi.yaml'),
      resolve(repoRoot, 'spec/overlays/github'),
    );

    const model = discoverResourceModel(document);
    const names = model.collections.map((c) => c.name).sort();
    expect(names).toContain('issues');
    expect(names).toContain('issueComments');

    const issues = model.byName('issues');
    expect(issues?.collectionUrl).toBe('/repos/{owner}/{repo}/issues');
    expect(issues?.itemUrl).toBe('/repos/{owner}/{repo}/issues/{issue_number}');
    // Issues are addressed by `number`, not the global `id`.
    expect(issues?.idField).toBe('number');
    // Server assigns the number; the client does not generate it.
    expect(issues?.generatesId).toBe(false);
    // owner/repo have no enumerable provider — supplied from config.
    expect(issues?.contextParams).toEqual(['owner', 'repo']);
  });

  it('applies the nextLink pagination scheme to the issues list operation', async () => {
    const document = await buildDocumentFrom(
      resolve(repoRoot, 'spec/github-issues.openapi.yaml'),
      resolve(repoRoot, 'spec/overlays/github'),
    );
    const get = document.paths['/repos/{owner}/{repo}/issues']?.get;
    expect(get?.['x-pagination']).toEqual([{ scheme: 'nextLink' }]);
  });
});
