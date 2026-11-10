(function(root){
  'use strict';
  // Your apps in Connected apps: the MCP apps Mia added for you, each with its
  // logo, where its server runs and how you sign in. A key is typed here,
  // into a password field, and sent straight to Mia's own Hermes profiles;
  // it is never shown again or sent through chat. An app that signs you in
  // itself has a Sign in button: its page opens in your default browser.

  var opts = null, watching = null;
  var STATUS = {needs_key: 'Needs its key', needs_sign_in: 'Needs sign-in', signing_in: 'Signing in…', signed_in: 'Signed in'};
  var SIGN_IN = {needs_sign_in: 'Sign in', signing_in: 'Open sign-in again', signed_in: 'Sign in again'};

  function esc(value){ return opts.esc(value == null ? '' : String(value)); }

  function statusLabel(app){
    return STATUS[app.status] || 'Ready';
  }

  function rowHtml(app){
    var logo = app.logo ? '<img src="' + esc(app.logo) + '" alt="" />' : '<span class="mcp-app-initial">' + esc(app.name.charAt(0).toUpperCase()) + '</span>';
    return '<div class="mcp-app" data-mcp-app="' + esc(app.id) + '">'
      + '<span class="mcp-app-logo" aria-hidden="true">' + logo + '</span>'
      + '<div class="mcp-app-copy"><div class="mcp-app-name">' + esc(app.name) + '<span class="mcp-app-status is-' + esc(app.status) + '">' + esc(statusLabel(app)) + '</span></div>'
      + (app.description ? '<div class="mcp-app-desc">' + esc(app.description) + '</div>' : '')
      + '<div class="mcp-app-where">' + esc(app.where) + (app.docsUrl ? ' · <a href="' + esc(app.docsUrl) + '" target="_blank" rel="noopener noreferrer">Vendor page</a>' : '') + '</div>'
      + (app.auth === 'key' ? '<form class="mcp-app-key" data-mcp-key="' + esc(app.id) + '"><input type="password" autocomplete="off" spellcheck="false" aria-label="' + esc(app.name + ' key') + '" placeholder="' + (app.status === 'needs_key' ? 'Paste its key' : 'Paste a new key to replace it') + '" /><button type="submit">Save key</button></form>' : '')
      + (app.auth === 'oauth' ? '<div class="mcp-app-sign-in"><button type="button" data-mcp-sign-in="' + esc(app.id) + '">' + esc(SIGN_IN[app.status] || 'Sign in') + '</button>'
        + (app.status === 'signing_in' ? '<span>Finish signing in in your browser.</span>' : '') + '</div>' : '')
      + '<div class="mcp-app-error" role="alert">' + (app.signInFailed ? 'The sign-in didn’t finish. Try again.' : '') + '</div></div>'
      + '<button type="button" class="mcp-app-remove" data-mcp-remove="' + esc(app.id) + '" aria-label="' + esc('Remove ' + app.name) + '">Remove</button></div>';
  }

  function render(apps){
    var list = document.getElementById('mcpAppsList');
    if(!list) return;
    list.innerHTML = apps && apps.length ? apps.map(rowHtml).join('')
      : '<p class="mcp-apps-empty">No apps yet. Ask Mia to add one.</p>';
  }

  function load(){
    return opts.api('/api/mcp-apps').then(function(res){
      var apps = res.status === 200 && res.data ? res.data.apps : [];
      render(apps);
      return apps;
    }, function(){ render([]); return []; });
  }

  // While a sign-in is under way in the browser, look again every few
  // seconds so the row turns to Signed in by itself.
  function watch(){
    clearTimeout(watching);
    var left = 250;
    (function again(){
      watching = setTimeout(function(){
        load().then(function(apps){
          if(--left > 0 && apps.some(function(app){ return app.status === 'signing_in'; })) again();
        });
      }, 2500);
    })();
  }

  function openInBrowser(url, proof, popup){
    var desktop = root.miaDesktop && root.miaDesktop.openMcpAppAuth;
    if(desktop) return Promise.resolve(desktop(url, proof)).then(function(opened){ return !!(opened && opened.ok); });
    if(popup){ popup.location = url; return Promise.resolve(true); }
    return Promise.resolve(!!root.open(url, '_blank', 'noopener'));
  }

  // Starts an app's sign-in and opens its page in the default browser.
  // Resolves to an error sentence, or '' when the page opened.
  function signIn(id, popup){
    return opts.api('/api/mcp-apps/' + encodeURIComponent(id) + '/sign-in', {method:'POST'}).then(function(res){
      var data = res.data || {};
      if(res.status !== 200) throw new Error(data.message || 'The sign-in didn’t start. Try again.');
      if(data.state === 'signed_in') return true;
      if(!data.authorizationUrl) throw new Error('The sign-in didn’t start. Try again.');
      return openInBrowser(data.authorizationUrl, data.authorizationProof, popup);
    }).then(function(opened){
      if(!opened) throw new Error('Mia couldn’t open your browser. Try again.');
      watch();
      return load().then(function(){ return ''; });
    }).catch(function(error){
      if(popup){ try { popup.close(); } catch(_){} }
      return load().then(function(){ errorFor(id, error.message); return error.message; });
    });
  }

  function errorFor(id, message){
    var row = document.querySelector('[data-mcp-app="' + id + '"] .mcp-app-error');
    if(row) row.textContent = message;
  }

  function init(options){
    opts = options;
    var section = document.getElementById('mcpApps');
    if(!section) return;
    section.addEventListener('submit', function(event){
      var form = event.target.closest('[data-mcp-key]');
      if(!form) return;
      event.preventDefault();
      var id = form.getAttribute('data-mcp-key'), field = form.querySelector('input'), button = form.querySelector('button');
      var key = field.value.trim();
      if(!key){ errorFor(id, 'Paste the key first.'); return; }
      button.disabled = true; button.textContent = 'Saving…';
      opts.api('/api/mcp-apps/' + encodeURIComponent(id) + '/key', {method:'POST', body:{key: key}}).then(function(res){
        field.value = '';
        if(res.status !== 200) throw new Error(res.data && res.data.message || 'That key didn’t save. Try again.');
        return load();
      }).catch(function(error){
        button.disabled = false; button.textContent = 'Save key';
        errorFor(id, error.message);
      });
    });
    section.addEventListener('click', function(event){
      if(event.target.closest('#mcpAppsAsk')){ opts.askMia('Add the MCP for '); return; }
      var start = event.target.closest('[data-mcp-sign-in]');
      if(start){
        // Outside the desktop app a tab opened after the wait would be
        // blocked, so it opens now and gets its address after.
        var popup = null;
        if(!(root.miaDesktop && root.miaDesktop.openMcpAppAuth)){ try { popup = root.open('about:blank', '_blank'); } catch(_){ popup = null; } }
        start.disabled = true; start.textContent = 'Opening…';
        signIn(start.getAttribute('data-mcp-sign-in'), popup);
        return;
      }
      var remove = event.target.closest('[data-mcp-remove]');
      if(!remove) return;
      var id = remove.getAttribute('data-mcp-remove');
      Promise.resolve(opts.confirm('Remove this app? Mia stops using it, and its key or sign-in is deleted from this computer.')).then(function(ok){
        if(!ok) return;
        remove.disabled = true;
        return opts.api('/api/mcp-apps/' + encodeURIComponent(id), {method:'DELETE'}).then(function(res){
          if(res.status !== 200) throw new Error(res.data && res.data.message || 'Couldn’t remove it. Try again.');
          return load();
        });
      }).catch(function(error){ remove.disabled = false; errorFor(id, error.message); });
    });
    load();
  }

  root.MiaMcpAppsUI = {init: init, load: load, signIn: function(id){ return opts ? signIn(id, null) : Promise.resolve(''); }, rowHtml: function(app, options){ opts = opts || options; return rowHtml(app); }};
})(typeof window !== 'undefined' ? window : globalThis);
