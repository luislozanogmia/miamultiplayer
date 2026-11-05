/* Switching between the Mia accounts on this computer. The desktop app does the
   work; a browser has no bridge, so everything here is simply absent there. */
(function (root) {
  'use strict';
  function bridge() { return root.miaDesktop && root.miaDesktop.accounts; }
  function label(account) { return account.email || account.name || 'Another account'; }
  function askToSwitch(account) {
    return root.confirm('Switch to ' + label(account) + '?\n\nMia restarts in that account. Bots and automations here pause until you come back.');
  }
  // A sign-in that belongs to another account on this computer opens there.
  function route(token) {
    var accounts = bridge();
    if (!accounts) return Promise.resolve(false);
    return accounts.route(token).then(function (result) { return !!(result && result.switching); });
  }
  function confirmed(token, profile) {
    var accounts = bridge();
    return accounts ? accounts.confirmed(token, profile) : Promise.resolve();
  }
  function openOther(token, conflict) {
    var accounts = bridge();
    if (!accounts) return Promise.resolve(false);
    return accounts.openOther(token, conflict).then(function (result) { return !!(result && result.switching); });
  }
  // Fills a menu with the other accounts and "Add another account".
  function render(container, options) {
    var accounts = bridge();
    if (!container) return Promise.resolve();
    if (!accounts) { container.hidden = true; return Promise.resolve(); }
    var settings = options || {};
    return accounts.list().then(function (list) {
      container.textContent = '';
      var button = function (text, onClick) {
        var item = root.document.createElement('button');
        item.type = 'button';
        item.className = settings.itemClass || '';
        item.setAttribute('role', settings.role || 'menuitem');
        item.textContent = text;
        item.addEventListener('click', onClick);
        container.appendChild(item);
      };
      list.filter(function (account) { return !account.active; }).forEach(function (account) {
        button('Switch to ' + label(account), function () {
          if (askToSwitch(account)) accounts.switchTo(account.id);
        });
      });
      button('Add another account', function () { accounts.add(); });
      container.hidden = !container.children.length;
    }).catch(function () { container.hidden = true; });
  }
  // Which sign-in screen an account folder opens on. A signed-out account signs
  // in as itself, an added one starts empty, and a first install is unchanged.
  function signInView(list) {
    var active = (list || []).filter(function (account) { return account.active; })[0];
    if (active && active.email) return { kind: 'named', email: active.email };
    return (list || []).some(function (account) { return !account.active; }) ? { kind: 'add' } : { kind: 'welcome' };
  }
  function initials(text) {
    return String(text).replace(/@.*/, '').slice(0, 2).toUpperCase();
  }
  // els: { title, subtitle, accounts, form }. mountForm(lockedEmail) puts the
  // sign-in form in els.form.
  function showSignIn(els, mountForm) {
    var accounts = bridge();
    var doc = root.document;
    function button(className, onClick, text, badge) {
      var item = doc.createElement('button');
      item.type = 'button';
      item.className = className;
      if (badge) {
        var mark = doc.createElement('span');
        mark.className = 'login-account-mark';
        mark.textContent = badge;
        item.appendChild(mark);
      }
      item.appendChild(doc.createTextNode(text));
      item.addEventListener('click', onClick);
      els.accounts.appendChild(item);
    }
    function head(title, subtitle) {
      els.title.textContent = title;
      els.subtitle.textContent = subtitle;
      els.accounts.textContent = '';
      els.accounts.hidden = false;
    }
    function showForm(view, list) {
      els.form.hidden = false;
      if (view.kind === 'named') {
        head('Sign in to your account', view.email);
        button('login-account-link', function () { showChooser(view, list); }, 'Use another account');
      } else {
        head('Add a new account', 'Your other accounts stay signed in.');
        button('login-account-link', function () { showChooser(view, list); }, 'Back to your accounts');
      }
    }
    function showChooser(view, list) {
      els.form.hidden = true;
      head('Choose an account', 'Each one has its own bots, chats, and files.');
      list.forEach(function (account) {
        if (!account.email && !account.name) return;
        var name = label(account);
        button('login-account-btn', function () {
          if (account.active) showForm(view, list); else accounts.switchTo(account.id);
        }, name, initials(name));
      });
      button('login-account-btn', function () { accounts.add(); }, 'Add a new account', '+');
    }
    if (!accounts) { mountForm(''); return Promise.resolve(); }
    return accounts.list().catch(function () { return []; }).then(function (list) {
      var view = signInView(list);
      mountForm(view.kind === 'named' ? view.email : '');
      if (view.kind !== 'welcome') showForm(view, list);
    });
  }
  // The account that opened when a sign-in turned out to be someone else's.
  function takeOpenedNotice() {
    var accounts = bridge();
    return accounts && accounts.takeNotice ? accounts.takeNotice().catch(function () { return ''; }) : Promise.resolve('');
  }
  root.MiaAccounts = { route: route, confirmed: confirmed, openOther: openOther, render: render, signInView: signInView, showSignIn: showSignIn, takeOpenedNotice: takeOpenedNotice };
  if (typeof module !== 'undefined') module.exports = root.MiaAccounts;
})(typeof window !== 'undefined' ? window : globalThis);
