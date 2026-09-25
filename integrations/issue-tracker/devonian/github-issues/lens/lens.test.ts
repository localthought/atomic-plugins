// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  project,
  unproject,
  issuePatch,
  issueExtras,
  type Issue,
} from './index.js';

// Moved from devonian/__tests__/unit/platformLenses.test.ts with the lens.
const issue: Issue & { assignee: string } = {
  number: 42,
  title: 'Before',
  body: null,
  state: 'open',
  labels: ['bug', { name: 'ATOMIC:DOING' }],
  assignee: 'someone',
};

describe('passive GitHub issues lens', () => {
  it.each(['Todo', 'Doing', 'Done'] as const)(
    'round trips GitHub %s without changing unrelated data',
    status => {
      const desired = { title: 'After', body: 'Edited', status };
      const previous = structuredClone(issue);
      const result = unproject(desired, issue);
      expect(project(result)).toEqual(desired);
      expect(result.number).toBe(42);
      expect(result.assignee).toBe('someone');
      expect(result.labels).toContain('bug');
      expect(issue).toEqual(previous);
      expect(unproject(desired, result)).toEqual(result);
    },
  );

  it('keeps the GitHub runtime patch minimal', () => {
    const before = project(issue);
    expect(issuePatch(before, before)).toEqual({});
    expect(issuePatch({ ...before, status: 'Done' }, before)).toEqual({
      state: 'closed',
    });
  });

  it('projects labels, assignees, updated time and comment count read-only', () => {
    const raw = {
      ...issue,
      labels: [
        'bug',
        { name: 'atomic:doing', color: 'ededed' },
        { name: 'design', color: 'E99695' },
        { name: 'not-a-colour', color: 'red;x' },
      ],
      assignees: [{ login: 'alice' }, { login: 'bob' }, {}],
      comments: 3,
      updated_at: '2026-09-24T10:00:00Z',
    };
    expect(issueExtras(raw)).toEqual({
      labels: [
        { name: 'bug' },
        { name: 'design', color: '#e99695' },
        { name: 'not-a-colour' },
      ],
      assignees: ['alice', 'bob'],
      commentCount: 3,
    });
    // Nothing of it reaches GitHub: the patch and the reverse mapping only
    // carry the projection's own fields.
    const before = project(raw);
    const patch = issuePatch({ ...before, title: 'New' }, before);
    expect(Object.keys(patch)).toEqual(['title']);
    expect(project(unproject(before, raw))).toEqual(before);
    expect(issueExtras({ ...issue, labels: [] })).toEqual({
      labels: [],
      assignees: [],
    });
  });
});
