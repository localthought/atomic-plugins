// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { project, unproject, issuePatch, type Issue } from './index.js';

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
});
