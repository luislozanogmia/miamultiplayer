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

test('a signed-out account signs in as itself, an added one starts empty, a first install is unchanged', () => {
  const { api } = load({});
  assert.deepEqual(api.signInView(list), { kind: 'named', email: 'a@example.test' });
  assert.deepEqual(api.signInView([{ id: 'new-1', active: true }, list[1]]), { kind: 'add' });
  assert.deepEqual(api.signInView([{ id: 'default', active: true }]), { kind: 'welcome' });
  assert.deepEqual(api.signInView([]), { kind: 'welcome' });
});

function fakeDoc() {
  const element = () => {
    const node = { children: [], hidden: false, _text: '', appendChild(child) { node.children.push(child); return child; },
      addEventListener(_, fn) { node.click = fn; } };
    Object.defineProperty(node, 'textContent', { get: () => node._text, set(value) { node._text = value; node.children = []; } });
    return node;
  };
  return { createElement: element, createTextNode: text => ({ _text: text }), element };
}
function loadScreen(accounts) {
  const doc = fakeDoc();
  const scope = { miaDesktop: { accounts }, document: doc, confirm: () => true };
  new Function('window', 'globalThis', 'module', fs.readFileSync(path.join(__dirname, 'account-switcher.js'), 'utf8'))(scope, scope, undefined);
  const els = { title: doc.element(), subtitle: doc.element(), accounts: doc.element(), form: doc.element() };
  return { api: scope.MiaAccounts, els };
}
const rowText = row => row.children.map(child => child._text).join('|');

test('the named screen locks the form to that account and leads to the chooser', async () => {
  const switched = [], added = [];
  const { api, els } = loadScreen({ list: async () => list, switchTo: async id => switched.push(id), add: async () => added.push(1) });
  const mounted = [];
  await api.showSignIn(els, email => mounted.push(email));
  assert.deepEqual(mounted, ['a@example.test']);
  assert.equal(els.title._text, 'Sign in to your account');
  assert.equal(els.subtitle._text, 'a@example.test');
  els.accounts.children[0].click();
  assert.equal(els.form.hidden, true);
  assert.equal(els.title._text, 'Choose an account');
  assert.deepEqual(els.accounts.children.map(rowText), ['A|a@example.test', 'B|b@example.test', '+|Add a new account']);
  els.accounts.children[1].click();
  assert.deepEqual(switched, ['abc']);
  els.accounts.children[2].click();
  assert.deepEqual(added, [1]);
  els.accounts.children[0].click();
  assert.equal(els.form.hidden, false, 'the open account goes back to its form');
  assert.equal(els.title._text, 'Sign in to your account');
});

test('an added account has an open form and a way back', async () => {
  const { api, els } = loadScreen({ list: async () => [{ id: 'new-1', active: true }, { ...list[0], active: false }] });
  const mounted = [];
  await api.showSignIn(els, email => mounted.push(email));
  assert.deepEqual(mounted, ['']);
  assert.equal(els.title._text, 'Add a new account');
  els.accounts.children[0].click();
  assert.deepEqual(els.accounts.children.map(rowText), ['A|a@example.test', '+|Add a new account'], 'the empty folder is not offered');
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
