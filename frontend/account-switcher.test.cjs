'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function load(accounts, confirmAnswer = true) {
  const calls = [];
  const made = [];
  globalThis.window = undefined;
  const scope = {
    miaDesktop: accounts ? { accounts: new Proxy(accounts, { get: (target, key) => (...args) => { calls.push([key, ...args]); return target[key](...args); } }) } : undefined,
    confirm: () => confirmAnswer,
    document: { createElement: () => { const item = { setAttribute() {}, addEventListener(_, fn) { item.click = fn; } }; made.push(item); return item; } },
  };
  const source = fs.readFileSync(path.join(__dirname, 'account-switcher.js'), 'utf8');
  new Function('window', 'globalThis', 'module', source)(scope, scope, undefined);
  return { api: scope.MiaAccounts, calls, made };
}
const box = () => ({ hidden: false, children: [], textContent: '', appendChild(child) { this.children.push(child); } });
const list = [{ id: 'default', email: 'a@example.test', active: true }, { id: 'abc', email: 'b@example.test', active: false }];

test('menus offer the other accounts and adding one, never the open one', async () => {
  const { api } = load({ list: async () => list, switchTo: async () => {}, add: async () => {} });
  const menu = box();
  await api.render(menu, { itemClass: 'x' });
  assert.deepEqual(menu.children.map(item => item.textContent), ['Switch to b@example.test', 'Add another account']);
  assert.equal(menu.hidden, false);
});

test('switching asks first and stays put when declined', async () => {
  for (const [answer, expected] of [[false, 0], [true, 1]]) {
    const { api, calls } = load({ list: async () => list, switchTo: async () => {}, add: async () => {} }, answer);
    const menu = box();
    await api.render(menu);
    menu.children[0].click();
    assert.equal(calls.filter(call => call[0] === 'switchTo').length, expected);
  }
});

test('the sign-in screen shows other accounts without an add button', async () => {
  const { api, calls } = load({ list: async () => list, switchTo: async () => {} }, false);
  const menu = box();
  await api.render(menu, { withAdd: false, skipConfirm: true });
  assert.equal(menu.children.length, 1);
  menu.children[0].click();
  assert.deepEqual(calls.at(-1), ['switchTo', 'abc']);
});

test('in a browser there is no switching and the old message still applies', async () => {
  const { api } = load(null);
  const menu = box();
  await api.render(menu);
  assert.equal(menu.hidden, true);
  assert.equal(await api.route('t'), false);
  assert.equal(await api.openOther('t', {}), false);
});

test('sign-in routes before linking and hands a conflict to the desktop app', () => {
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(app.indexOf('window.MiaAccounts.route(token)') < app.indexOf("fetch('/api/clerk/session'"));
  assert.match(app, /window\.MiaAccounts\.openOther\(sessionToken/);
  assert.match(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), /src="account-switcher\.js"/);
});
