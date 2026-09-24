/**
 * A repository that exists with issues from the start, because the mock
 * proxy runs in its own process and a host e2e cannot reach the in-process
 * driver (`createIssue`) to seed one. Used by the issue-tracker drive app's
 * e2e. Every other repository name starts empty, as before.
 */
export const SEEDED_REPOSITORY = 'atomic-fixture/tracker';

/** Stateful provider fixture, shared by the HTTP proxy and its test-side driver. */
export function githubTracker() {
  const repositories = new Map();
  let seeding = false;

  const repo = name => {
    if (!repositories.has(name)) {
      repositories.set(name, { issues: [], comments: [] });

      if (name === SEEDED_REPOSITORY && !seeding) {
        seeding = true;
        api.createIssue(name, {
          title: 'Keep the selected calendar after refresh',
          body: 'Refreshing the page resets the selection to **All calendars**.',
        });
        api.updateIssue(name, 1, { labels: ['bug'] });
        api.createIssue(name, { title: 'Export the board as CSV', body: '' });
        api.updateIssue(name, 2, { labels: ['atomic:doing'] });
        const comment = api.createComment(name, 1, {
          body: 'I can reproduce this in Firefox.',
        });
        repositories
          .get(name)
          .comments.find(c => c.id === comment.id).user.login = 'alice';
        seeding = false;
      }
    }

    return repositories.get(name);
  };

  let id = 0;
  const now = () => new Date().toISOString();
  const api = {
    snapshot: name => structuredClone(repo(name)),
    createIssue(name, input) {
      const state = repo(name);
      const number = state.issues.length + 1;
      const issue = {
        id: ++id,
        number,
        title: input.title,
        body: input.body ?? '',
        state: 'open',
        labels: [],
        url: `https://api.github.com/repos/${name}/issues/${number}`,
        html_url: `https://github.com/${name}/issues/${number}`,
        user: { login: 'mock-user' },
        created_at: now(),
        updated_at: now(),
      };
      state.issues.push(issue);

      return structuredClone(issue);
    },
    updateIssue(name, number, input) {
      const issue = repo(name).issues.find(i => i.number === number);
      if (!issue) return;
      for (const field of ['title', 'body', 'state', 'labels'])
        if (input[field] !== undefined) issue[field] = input[field];
      issue.updated_at = now();

      return structuredClone(issue);
    },
    createComment(name, number, input) {
      if (!repo(name).issues.some(i => i.number === number)) return;
      const comment = {
        id: ++id,
        body: input.body,
        issue_url: `https://api.github.com/repos/${name}/issues/${number}`,
        user: { login: 'mock-commenter' },
        created_at: now(),
        updated_at: now(),
      };
      repo(name).comments.push(comment);

      return structuredClone(comment);
    },
    request(method, url, input = {}) {
      const match = url.pathname.match(
        /^\/proxy\/github-issues\/repos\/([^/]+\/[^/]+)\/issues(?:\/(.*))?$/,
      );
      if (!match) return { status: 404, body: {} };
      const [, name, tail = ''] = match;
      const state = repo(name);
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('per_page') ?? 100);
      const paginate = rows => rows.slice((page - 1) * size, page * size);
      let value;

      if (!tail) {
        if (method === 'GET') value = paginate(state.issues);
        if (method === 'POST') value = api.createIssue(name, input);
      } else if (/^comments\/\d+$/.test(tail)) {
        const comment = state.comments.find(
          c => c.id === Number(tail.split('/')[1]),
        );
        if (method === 'GET') value = comment;
        if (method === 'PATCH' && comment)
          value = Object.assign(comment, {
            body: input.body,
            updated_at: now(),
          });
      } else {
        const [numberText, resource, label] = tail.split('/');
        const number = Number(numberText);
        const issue = state.issues.find(i => i.number === number);

        if (issue && !resource) {
          if (method === 'GET') value = issue;
          if (method === 'PATCH') value = api.updateIssue(name, number, input);
        } else if (issue && resource === 'comments') {
          if (method === 'GET')
            value = paginate(
              state.comments.filter(c => c.issue_url === issue.url),
            );
          if (method === 'POST') value = api.createComment(name, number, input);
        } else if (issue && resource === 'labels') {
          // As GitHub: both answer 200 with the labels now on the issue (as
          // names here, where GitHub sends label objects), and removing a
          // label the issue does not carry is a 404.
          const labelName =
            label === undefined ? undefined : decodeURIComponent(label);

          if (method === 'POST' && labelName === undefined) {
            if (!Array.isArray(input.labels) || !input.labels.length)
              return { status: 422, body: { message: 'Validation Failed' } };
            issue.labels = [...new Set([...issue.labels, ...input.labels])];

            return { status: 200, body: structuredClone(issue.labels) };
          }

          if (method === 'DELETE' && issue.labels.includes(labelName)) {
            issue.labels = issue.labels.filter(l => l !== labelName);

            return { status: 200, body: structuredClone(issue.labels) };
          }
        }
      }

      return {
        status: value === undefined ? 404 : method === 'POST' ? 201 : 200,
        body: structuredClone(value ?? {}),
      };
    },
  };

  // GitHub's GET /user/repos, the issue-tracker drive app's repository
  // picker (overlays/github.com/github-issues/1.1.4/
  // repositories-read-overlay.yaml). Kept outside `request` above so it stays
  // a separate hunk from the issue routes.
  const issueRequest = api.request;
  api.request = (method, url, input) =>
    url.pathname === `${PROXY}/user/repos`
      ? listRepositories(method, url)
      : issueRequest(method, url, input);

  /**
   * Every repository this fixture has seen (the seeded one first), plus one
   * with issues turned off, in that order whatever `sort` asks for. Paged
   * like GitHub: `per_page` (default 30, at most 100) and `page`, with a
   * `Link` header naming the next, last, first and previous pages as
   * absolute api.github.com URLs that keep the other query parameters. The
   * real proxy forwards that header unchanged.
   */
  function listRepositories(method, url) {
    if (method !== 'GET') return { status: 404, body: {} };
    repo(SEEDED_REPOSITORY);
    const all = [
      ...[...repositories.entries()].map(([fullName, state], index) =>
        repository(index + 1, fullName, {
          has_issues: true,
          open_issues_count: state.issues.filter(i => i.state === 'open')
            .length,
        }),
      ),
      repository(repositories.size + 1, NO_ISSUES_REPOSITORY, {
        has_issues: false,
        open_issues_count: 0,
      }),
    ];
    const size = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30),
    );
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const last = Math.max(1, Math.ceil(all.length / size));

    const at = n => {
      const link = new URL('https://api.github.com/user/repos');
      for (const [k, v] of url.searchParams)
        if (k !== 'page') link.searchParams.set(k, v);
      link.searchParams.set('page', String(n));

      return link.href;
    };

    const rels = [
      ...(page < last
        ? [`<${at(page + 1)}>; rel="next"`, `<${at(last)}>; rel="last"`]
        : []),
      ...(page > 1
        ? [
            `<${at(1)}>; rel="first"`,
            `<${at(Math.min(page, last + 1) - 1)}>; rel="prev"`,
          ]
        : []),
    ];

    return {
      status: 200,
      body: all.slice((page - 1) * size, page * size),
      ...(rels.length ? { headers: { Link: rels.join(', ') } } : {}),
    };
  }

  return api;
}

const PROXY = '/proxy/github-issues';

/** Listed by `GET /user/repos` with `has_issues: false`; never has issues. */
export const NO_ISSUES_REPOSITORY = 'atomic-fixture/no-issues';

function repository(id, fullName, fields) {
  const [owner, name] = fullName.split('/');

  return {
    id,
    name,
    full_name: fullName,
    owner: { login: owner },
    private: false,
    html_url: `https://github.com/${fullName}`,
    ...fields,
  };
}

// No `document`: the mock has never served /catalog/github-issues.yaml.
export default {
  title: 'GitHub Issues',
  jsonBody: true,
  create: githubTracker,
  // For the drive app's e2e: someone reading and editing on GitHub itself.
  drivers: ['snapshot', 'updateIssue'],
};
