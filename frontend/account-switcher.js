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
          if (settings.skipConfirm || askToSwitch(account)) accounts.switchTo(account.id);
        });
      });
      if (settings.withAdd !== false) button('Add another account', function () { accounts.add(); });
      container.hidden = !container.children.length;
    }).catch(function () { container.hidden = true; });
  }
  root.MiaAccounts = { route: route, confirmed: confirmed, openOther: openOther, render: render };
  if (typeof module !== 'undefined') module.exports = root.MiaAccounts;
})(typeof window !== 'undefined' ? window : globalThis);
