import { endpoint, request } from './adapter.js';
import { trackerAction } from './tracker-actions.js';

/**
 * GitHub issue actions over the integration proxy, through `dispatch`.
 *
 * `dispatch(path, { method, body })` makes one proxy call for a GitHub API
 * path (`/repos/{owner}/{name}/issues…`, query included) and resolves to
 * `{ status, body }`. In the drive app it is the host's
 * `store.proxy.request` (see `app/transport.ts`): since
 * ontola/atomic-plugins#54 phase 2 the plugin frame calls the proxy itself
 * with a capability from the page and a key only it holds, so this module
 * never sees a credential. The direct transport this used to have, which
 * spent a rotating connection code per request (`getCode`/`setCode`), went
 * with the proxy's connection codes.
 *
 * Writes are journalled before they leave (`journal[id]`, persisted by
 * `save`), so a write whose outcome is unknown is never resent. Calls are
 * serialised, one at a time.
 */
export function proxyTransport({ repository, journal, save, dispatch }) {
  if (typeof dispatch !== 'function')
    throw new Error('proxyTransport needs a dispatch function');
  const root = endpoint(repository);
  let pending = Promise.resolve();

  return (action, args, id) => {
    const operation = async () => {
      if (
        action === 'get_issue' &&
        (!Number.isSafeInteger(args.number) || args.number <= 0)
      )
        throw new Error('Invalid issue number');
      if (
        action === 'create_issue' &&
        (typeof args.title !== 'string' ||
          !args.title.trim() ||
          args.title.length > 256 ||
          (args.body !== undefined && typeof args.body !== 'string'))
      )
        throw new Error('Invalid issue title or body');
      const intent =
        trackerAction(repository, action, args) ??
        (action === 'get_issue'
          ? request('get', 'GET', `${root}/${args.number}`, id)
          : action === 'create_issue'
            ? request('create', 'POST', root, id, args)
            : undefined);
      if (!intent) throw new Error('Unsupported GitHub action');
      const writes = intent.method !== 'GET';
      const signature = JSON.stringify({ action, args });
      const old = journal[id];

      if (writes && old) {
        if (old.signature !== signature)
          throw new Error('Operation identity reused with different arguments');
        if (old.receipt) return old.receipt;
        throw new Error(
          `Uncertain GitHub write (${action}). Inspect its outcome before retrying; it will not be resent.`,
        );
      }

      if (writes) {
        journal[id] = { signature };
        await save();
      }

      const target = new URL(intent.url);
      const receipt = await dispatch(`${target.pathname}${target.search}`, {
        method: intent.method,
        ...(intent.body ? { body: intent.body } : {}),
      }).catch(async error => {
        // A dispatcher that knows the request never left (e.g. the host
        // refused to mint a capability, or the browser cannot make the
        // frame key) says so with `notSent`; only then is the journal entry
        // dropped, so the write is not stuck as uncertain. Anything else
        // stays uncertain.
        if (error?.notSent) {
          if (writes) {
            delete journal[id];
            await save();
          }

          throw error;
        }

        throw new Error(
          `Proxy request failed (${error?.message ?? error}). Check CORS and reconnect; an uncertain write will not be resent.`,
        );
      });

      if (writes && receipt.status >= 200 && receipt.status < 300) {
        journal[id].receipt = receipt;
        await save();
      }

      return receipt;
    };

    const next = pending.then(operation);
    pending = next.catch(() => {});

    return next;
  };
}

/** An explicitly labelled GitHub fixture; no network or real GitHub mutations. */
export function fixtureTransport(state, save) {
  state.issues ??= [
    {
      number: 1,
      title: 'Welcome from GitHub',
      body: 'Edit either tracker, then sync again.',
      state: 'open',
      labels: ['demo'],
    },
  ];
  state.comments ??= [];
  state.receipts ??= {};

  return async (action, args, id) => {
    if (state.receipts[id]) return state.receipts[id];
    let value;
    const issue = state.issues.find(r => r.number === args.number);
    const comment = state.comments.find(r => r.id === args.id);

    switch (action) {
      case 'list_issues':
        value = state.issues.slice((args.page - 1) * 100, args.page * 100);
        break;
      case 'get_issue':
        value = issue;
        break;
      case 'create_issue':
        value = {
          number: Math.max(0, ...state.issues.map(r => r.number)) + 1,
          ...args,
          state: 'open',
          labels: [],
        };
        state.issues.push(value);
        break;
      case 'update_issue':
        value = Object.assign(issue, args);
        break;
      case 'add_doing_label':
        issue.labels = [...new Set([...issue.labels, 'atomic:doing'])];
        value = issue;
        break;
      case 'remove_doing_label':
        issue.labels = issue.labels.filter(l => l !== 'atomic:doing');
        value = issue;
        break;
      case 'list_comments':
        value = state.comments
          .filter(c => c.issue_url.endsWith(`/${args.number}`))
          .slice((args.page - 1) * 100, args.page * 100);
        break;
      case 'get_comment':
        value = comment;
        break;
      case 'create_comment':
        value = {
          id: Math.max(0, ...state.comments.map(r => r.id)) + 1,
          body: args.body,
          issue_url: `https://api.github.com/repos/demo/issues/issues/${args.number}`,
          user: { login: 'demo-user' },
        };
        state.comments.push(value);
        break;
      case 'update_comment':
        value = Object.assign(comment, { body: args.body });
        break;
      default:
        throw new Error(`Unsupported fixture action: ${action}`);
    }

    const receipt = {
      status: value ? 200 : 404,
      body: JSON.stringify(value ?? {}),
    };
    if (!action.startsWith('get_') && !action.startsWith('list_'))
      state.receipts[id] = receipt;
    await save();

    return receipt;
  };
}
