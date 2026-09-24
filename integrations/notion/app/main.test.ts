// @vitest-environment jsdom
// @wc-ignore-file
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeStore, fixtureProxy } from './fakeStore.js';
import { view } from './main.js';

describe('view() on a host with the 007869464 store operations', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('applies the host’s colour scheme and follows its changes', async () => {
    const store = fakeStore({ proxy: fixtureProxy(), hostApis: true });
    let change: ((t: { colorScheme: 'light' | 'dark' }) => void) | undefined;
    store.onThemeChange = handler => {
      change = handler;

      return () => {};
    };
    await view({ root: document.getElementById('root')!, store });
    const app = document.querySelector('.pl-app')!;
    expect(app.getAttribute('data-scheme')).toBe('dark');
    change!({ colorScheme: 'light' });
    expect(app.getAttribute('data-scheme')).toBe('light');
  });

  it('opens the data table through openResource', async () => {
    const store = fakeStore({ proxy: fixtureProxy(), hostApis: true });
    await view({ root: document.getElementById('root')!, store });
    // Let the background sync settle so the menu is idle.
    await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector<HTMLButtonElement>('[data-key="menu:More"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
      .find(b => b.textContent === 'Open data table')!
      .click();
    expect(store.hostCalls.filter(c => c.op === 'openResource')).toEqual([
      { op: 'openResource', args: 'atomic:table' },
    ]);
  });

  it('works on an older host without them', async () => {
    const store = fakeStore({ proxy: fixtureProxy() });
    await view({ root: document.getElementById('root')!, store });
    expect(document.querySelector('.pl-app')!.hasAttribute('data-scheme')).toBe(false);
  });
});
