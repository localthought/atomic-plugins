/**
 * The `ci` job in .github/workflows/ci.yml is the single context the branch
 * ruleset requires, and it can only speak for jobs it lists in `needs`. A job
 * added later and not wired in would fail while `CI` still reported success —
 * a green gate over a red run. This asserts it stays exhaustive.
 *
 * Parsed with regexes rather than a YAML library: this repo's tooling tests
 * run on plain `node --test` with no dependencies of their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lanes.mjs';

const workflow = readFileSync(
  resolve(root, '.github/workflows/ci.yml'),
  'utf8',
).split('\n');

/** Top-level job keys: exactly two spaces of indent inside `jobs:`. */
function jobNames(lines) {
  const start = lines.findIndex(l => l === 'jobs:');
  assert.notEqual(start, -1, 'ci.yml has no jobs: block');
  const names = [];

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) names.push(m[1]);
  }

  return names;
}

/** The `needs:` list of one job, as written in block-sequence form. */
function needsOf(lines, job) {
  const start = lines.findIndex(l => l === `  ${job}:`);
  assert.notEqual(start, -1, `ci.yml has no ${job} job`);
  const needs = [];
  let inNeeds = false;

  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;

    if (/^ {4}needs:\s*$/.test(line)) {
      inNeeds = true;
      continue;
    }

    if (inNeeds) {
      const m = /^ {6}- ([a-z][a-z0-9-]*)\s*$/.exec(line);

      if (m) {
        needs.push(m[1]);
        continue;
      }

      break;
    }
  }

  return needs;
}

test('the ci gate depends on every other job', () => {
  const jobs = jobNames(workflow);
  assert.ok(jobs.includes('ci'), 'no ci job found');
  const needs = needsOf(workflow, 'ci');
  const uncovered = jobs.filter(j => j !== 'ci' && !needs.includes(j));
  assert.deepEqual(
    uncovered,
    [],
    "add these to the ci job's needs, or a failure in them reports green",
  );
});

test('every job the ci gate names exists', () => {
  const jobs = new Set(jobNames(workflow));
  for (const need of needsOf(workflow, 'ci'))
    assert.ok(jobs.has(need), `ci needs "${need}", which is not a job`);
});

test('the ci gate always reports, even when jobs are skipped', () => {
  const start = workflow.findIndex(l => l === '  ci:');
  const body = workflow.slice(start, start + 12).join('\n');
  assert.match(
    body,
    /if: always\(\)/,
    'without if: always() the gate is skipped when a dependency fails, and a required skipped check never reports',
  );
});
