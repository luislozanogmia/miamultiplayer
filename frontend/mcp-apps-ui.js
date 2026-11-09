(function(root){
  'use strict';
  // Your apps in Connected apps: the MCP apps Mia added for you, each with its
  // logo, where its server runs and how you sign in. A key is typed here,
  // into a password field, and sent straight to Mia's own Hermes profiles;
  // it is never shown again or sent through chat.

  var opts = null;

  function esc(value){ return opts.esc(value == null ? '' : String(value)); }

  function statusLabel(app){
    return app.status === 'needs_key' ? 'Needs its key' : app.status === 'sign_in_on_first_use' ? 'Sign in on first use' : 'Ready';
  }

  function rowHtml(app){
    var logo = app.logo ? '<img src="' + esc(app.logo) + '" alt="" />' : '<span class="mcp-app-initial">' + esc(app.name.charAt(0).toUpperCase()) + '</span>';
    return '<div class="mcp-app" data-mcp-app="' + esc(app.id) + '">'
      + '<span class="mcp-app-logo" aria-hidden="true">' + logo + '</span>'
      + '<div class="mcp-app-copy"><div class="mcp-app-name">' + esc(app.name) + '<span class="mcp-app-status is-' + esc(app.status) + '">' + esc(statusLabel(app)) + '</span></div>'
      + (app.description ? '<div class="mcp-app-desc">' + esc(app.description) + '</div>' : '')
      + '<div class="mcp-app-where">' + esc(app.where) + (app.docsUrl ? ' · <a href="' + esc(app.docsUrl) + '" target="_blank" rel="noopener noreferrer">Vendor page</a>' : '') + '</div>'
      + (app.auth === 'key' ? '<form class="mcp-app-key" data-mcp-key="' + esc(app.id) + '"><input type="password" autocomplete="off" spellcheck="false" aria-label="' + esc(app.name + ' key') + '" placeholder="' + (app.status === 'needs_key' ? 'Paste its key' : 'Paste a new key to replace it') + '" /><button type="submit">Save key</button></form>' : '')
      + '<div class="mcp-app-error" role="alert"></div></div>'
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
      render(res.status === 200 && res.data ? res.data.apps : []);
    }, function(){ render([]); });
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
      var remove = event.target.closest('[data-mcp-remove]');
      if(!remove) return;
      var id = remove.getAttribute('data-mcp-remove');
      Promise.resolve(opts.confirm('Remove this app? Mia stops using it, and its key is deleted from this computer.')).then(function(ok){
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

  root.MiaMcpAppsUI = {init: init, load: load, rowHtml: function(app, options){ opts = opts || options; return rowHtml(app); }};
})(typeof window !== 'undefined' ? window : globalThis);
