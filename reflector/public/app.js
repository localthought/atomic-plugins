'use strict';

const el = (id) => document.getElementById(id);
const state = {
  configured: false,
  connected: false,
  changeStates: {}, // changeId -> last seen state
  storage: { kind: 'local', label: 'Local files', userAddress: null },
  reflection: null, // set when this instance runs an unattended background reflection instead
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toasts').appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

// --- Rendering -------------------------------------------------------------

function reflectionSummary(reflection) {
  const [a, b] = reflection.systems;
  const seconds = Math.round(reflection.intervalMs / 1000);
  const verb =
    reflection.direction === 'a-to-b'
      ? `reflects changes from ${a} to ${b}`
      : `reflects between ${a} and ${b}`;
  return `This Reflector instance ${verb} every ${seconds} seconds.`;
}

function render() {
  const reflecting = Boolean(state.reflection);
  el('topbar-actions').hidden = reflecting;
  el('reflection-view').hidden = !reflecting;
  el('connect-view').hidden = reflecting || state.connected;
  el('app-view').hidden = reflecting || !state.connected;
  if (reflecting) {
    el('reflection-summary').textContent = reflectionSummary(state.reflection);
    return;
  }
  el('disconnect-btn').hidden = !state.connected;
  el('not-configured').hidden = state.configured;
  el('connect-btn').classList.toggle('disabled', !state.configured);
}

// --- Data flow -------------------------------------------------------------

async function loadMe() {
  const me = await api('/api/me');
  state.reflection = me.reflection || null;
  if (state.reflection) {
    render();
    return;
  }
  state.configured = me.configured;
  state.connected = me.connected;
  state.storage = me.storage || state.storage;
  el('account').textContent = me.account?.email || '';
  el('google-account').textContent = me.account?.email || '';
  renderStorage();
  render();
  if (state.connected) {
    startStatusPolling();
  }
}

// --- Storage (local files vs remoteStorage) --------------------------------

function renderStorage() {
  el('storage-btn').textContent = `Storage: ${state.storage.label}`;
  const connected = state.storage.kind === 'remotestorage';
  el('storage-summary').textContent = connected
    ? `remoteStorage (${state.storage.userAddress})`
    : state.storage.label;
  el('storage-current').textContent = connected
    ? `Connected to ${state.storage.userAddress}. Your data is stored in your remoteStorage account.`
    : 'Currently storing data in local files on this server.';
  el('rs-disconnect').hidden = !connected;
}

async function connectRemoteStorage(e) {
  e.preventDefault();
  const address = el('rs-form').address.value.trim();
  if (!address) return;
  try {
    const { authUrl } = await api('/api/remotestorage/connect', {
      method: 'POST',
      body: JSON.stringify({ userAddress: address }),
    });
    // Hand off to the provider's consent screen; it redirects back to
    // /remotestorage/callback, which posts the token and returns here.
    window.location.href = authUrl;
  } catch (err) {
    toast(`Could not connect remoteStorage: ${err.message}`, 'error');
  }
}

async function disconnectRemoteStorage() {
  try {
    await api('/api/remotestorage/disconnect', { method: 'POST' });
    toast('Switched storage back to local files. Sync now to repopulate.', 'success');
    el('storage-dialog').close();
    await loadMe();
  } catch (err) {
    toast(`Could not disconnect: ${err.message}`, 'error');
  }
}

async function fullRead() {
  const btn = el('read-btn');
  btn.disabled = true;
  el('read-summary').textContent = 'Syncing…';
  try {
    const summary = await api('/api/read', { method: 'POST' });
    el('read-summary').textContent = `Synced ${summary.events} events across ${summary.calendars} calendars.`;
    toast('Sync complete', 'success');
  } catch (err) {
    el('read-summary').textContent = '';
    toast(`Sync failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Sync status polling ---------------------------------------------------

function setIndicator(cls, text) {
  const node = el('sync-indicator');
  node.className = `sync-indicator ${cls}`;
  node.textContent = text;
}

let statusTimer = null;
function startStatusPolling() {
  if (statusTimer) return;
  const tick = async () => {
    try {
      const status = await api('/api/status');
      handleStatus(status);
    } catch {
      /* ignore transient errors */
    }
  };
  statusTimer = setInterval(tick, 1500);
  tick();
}

function handleStatus(status) {
  for (const change of status.changes) {
    const previous = state.changeStates[change.changeId];
    if (previous && previous !== change.state) {
      if (change.state === 'synced') {
        toast(`Synced: ${change.summary}`, 'success');
      } else if (change.state === 'failed') {
        toast(`Sync failed, change rolled back: ${change.summary} (${change.error || 'error'})`, 'error');
      }
    }
    state.changeStates[change.changeId] = change.state;
  }

  if (status.syncing > 0) {
    setIndicator('syncing', `Syncing ${status.syncing} change${status.syncing > 1 ? 's' : ''}…`);
  } else if (status.failed > 0) {
    setIndicator('failed', `${status.failed} change${status.failed > 1 ? 's' : ''} failed`);
  } else {
    setIndicator('synced', 'All changes synced');
  }
}

// --- Auto-connect from a #remotestorage=user@host&access_token=... link ----

async function connectFromHash() {
  const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const userAddress = params.get('remotestorage');
  const token = params.get('access_token');
  if (!userAddress || !token) return;
  // Drop the token from the visible URL/history right away, whether or not
  // connecting succeeds below.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await api('/api/remotestorage/connect-with-token', {
      method: 'POST',
      body: JSON.stringify({ userAddress, token }),
    });
    toast(`remoteStorage connected: ${userAddress}`, 'success');
  } catch (err) {
    toast(`Could not connect remoteStorage: ${err.message}`, 'error');
  }
}

// --- Wiring ----------------------------------------------------------------

el('read-btn').onclick = fullRead;
el('download-btn').onclick = () => {
  window.location.href = '/api/download/zip';
};
el('disconnect-btn').onclick = async () => {
  await api('/api/disconnect', { method: 'POST' });
  window.location.reload();
};
el('storage-btn').onclick = () => {
  renderStorage();
  el('rs-form').address.value = '';
  el('storage-dialog').showModal();
};
el('storage-close').onclick = () => el('storage-dialog').close();
el('rs-form').onsubmit = connectRemoteStorage;
el('rs-disconnect').onclick = disconnectRemoteStorage;

connectFromHash()
  .then(loadMe)
  .catch((err) => toast(err.message, 'error'));
