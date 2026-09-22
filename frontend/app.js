(function(){
  "use strict";

  /* The public OSS shell consists of Chat and Manage Bots. */
  var STYLED_SKIN = true;
  var STYLED_ROUTES = ['chat', 'agent-admin', 'integrations'];
  // The local desktop shell opens directly without an authentication gate.
  var STYLED_SKIP_AUTH = false;
  if(STYLED_SKIN) document.body.classList.add('styled-skin');

  /* Mobile browsers expose a layout viewport larger than the visible area
     while their browser chrome is open. Track the visual viewport as a
     fallback for browsers without dynamic viewport units and during rotation
     or toolbar expansion/collapse. The CSS still has 100dvh as its native
     fallback. */
  (function syncMobileViewportHeight(){
    var root = document.documentElement;
    var mobileQuery = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
    var cssVar = '--mia-mobile-viewport-height';
    function sync(){
      if(mobileQuery && !mobileQuery.matches){
        root.style.removeProperty(cssVar);
        return;
      }
      var viewport = window.visualViewport;
      var height = viewport && viewport.height || window.innerHeight;
      if(height > 0) root.style.setProperty(cssVar, Math.round(height) + 'px');
    }
    sync();
    window.addEventListener('resize', sync, {passive:true});
    if(window.visualViewport){
      window.visualViewport.addEventListener('resize', sync, {passive:true});
      window.visualViewport.addEventListener('scroll', sync, {passive:true});
    }
  })();

  /* ============ INSTANCE CONFIG ============
     Client-neutral by default: no client name/domain/company baked in here.
     `companies` (optional) drives the avatar menu's company switcher — each
     entry is {label, path}; when it has fewer than 2 entries the switcher
     just doesn't render (nothing to switch between). `name`/`domains` are
     placeholders only — loadInstanceConfig() below overwrites them from the
     backend's GET /api/instance (the real source of truth, driven by the
     server's INSTANCE_* env vars) as soon as it resolves, falling back to
     these defaults if that fetch fails. A page can override this object
     before app.js loads (e.g. a config.js include) instead of editing here. */
  var INSTANCE = window.INSTANCE || {
    name: 'Mia',
    domains: ['example.com'],
    companies: []
  };
  var AUTH_CONFIG = null;
  var WORKSPACE_OPTIONS = {
    solo: {mode:'solo', label:'Solo'},
    'multiplayer_test': {mode:'multiplayer', label:'Multiplayer Test', switcherLabel:'Multiplayer Test'}
  };
  var WORKSPACE_STORAGE_KEY = 'miaosActiveWorkspace';
  var storedWorkspaceKey = '';
  try { storedWorkspaceKey = localStorage.getItem(WORKSPACE_STORAGE_KEY) || ''; } catch(_workspaceStorageError) {}
  var activeWorkspaceKey = WORKSPACE_OPTIONS[storedWorkspaceKey] ? storedWorkspaceKey : 'solo';
  var appCollaborationMode = WORKSPACE_OPTIONS[activeWorkspaceKey].mode;
  function workspaceLabel(){
    var workspace = WORKSPACE_OPTIONS[activeWorkspaceKey] || WORKSPACE_OPTIONS.solo;
    return workspace.label;
  }
  function renderWorkspaceSwitcher(){
    var companyName = el('#miaCompanyName');
    var workspace = WORKSPACE_OPTIONS[activeWorkspaceKey] || WORKSPACE_OPTIONS.solo;
    if(companyName) companyName.textContent = workspace.switcherLabel || workspace.label;
    els('[data-workspace-key]').forEach(function(option){
      var active = option.getAttribute('data-workspace-key') === activeWorkspaceKey;
      option.classList.toggle('active', active);
      option.setAttribute('aria-current', active ? 'true' : 'false');
    });
  }
  function activateWorkspace(key){
    var workspace = WORKSPACE_OPTIONS[key];
    if(!workspace) return false;
    activeWorkspaceKey = key;
    appCollaborationMode = workspace.mode;
    clearSoloHumanDirectoryState();
    try { localStorage.setItem(WORKSPACE_STORAGE_KEY, key); } catch(_workspaceStorageError) {}
    refreshAppName();
    renderSidebarPins();
    return true;
  }
  function appNameLabel(){
    return (INSTANCE.name || 'Mia') + ' - ' + (appCollaborationMode === 'multiplayer' ? 'Multiplayer' : 'Solo');
  }
  function refreshAppName(){
    var label = appNameLabel();
    document.title = label;
    var legacyLoginName = el('#miaLegacyLoginName');
    var legacyAppName = el('#miaLegacyAppName');
    var loginName = el('#miaLoginName');
    var loginFooterName = el('#miaLoginFooterName');
    if(legacyLoginName) legacyLoginName.textContent = label;
    if(legacyAppName) legacyAppName.textContent = label;
    if(loginName) loginName.textContent = label;
    if(loginFooterName) loginFooterName.textContent = label;
    renderWorkspaceSwitcher();
  }
  function setAppCollaborationMode(humans){
    appCollaborationMode = (WORKSPACE_OPTIONS[activeWorkspaceKey] || WORKSPACE_OPTIONS['multiplayer_test']).mode;
    refreshAppName();
  }
  // Animated Mia mark in the sidebar lockup + login page (assets/mia-mark.js).
  (function mountMiaMarks(){
    if(!window.MiaMark) return;
    var mounted = [];
    function mount(){
      mounted = mounted.filter(function(node){
        if(node.isConnected) return true;
        if(typeof MiaMark.destroy === 'function') MiaMark.destroy(node);
        return false;
      });
      var nodes = document.querySelectorAll('[data-mia-mark]');
      for(var i = 0; i < nodes.length; i++){
        if(nodes[i]._miaMarkMounted) continue;
        nodes[i]._miaMarkMounted = true;
        mounted.push(nodes[i]);
        MiaMark.render(nodes[i], parseInt(nodes[i].getAttribute('data-mia-mark'), 10) || 22, nodes[i].getAttribute('data-mia-mark-mode') || '');
      }
    }
    mount();
    // Chat, roster, and sidebar markup is rebuilt from durable app state. Mount
    // any newly-created orchestrator marks without restarting existing waves.
    if(window.MutationObserver && document.body){
      new MutationObserver(mount).observe(document.body, {childList:true, subtree:true});
    }
  })();
  // Motes are static by default. One visible avatar gets a single blink every
  // 30 seconds, rotating through the rendered roster instead of running an
  // independent SVG animation in every message, sidebar row, and panel.
  (function staggerVisibleMoteAnimations(){
    var active = null;
    var stopTimer = null;
    var cursor = 0;
    function restore(img){
      if(!img) return;
      var staticSrc = img.getAttribute('data-mote-static-src');
      if(staticSrc && img.getAttribute('src') !== staticSrc) img.setAttribute('src', staticSrc);
      img.classList.remove('mote-avatar-animating');
    }
    function visibleMotes(){
      return els('img.mote-avatar-img[data-mote-animated-src]').filter(function(img){
        if(!img.isConnected || !img.getClientRects().length) return false;
        var style = window.getComputedStyle ? window.getComputedStyle(img) : null;
        return !style || (style.visibility !== 'hidden' && style.display !== 'none');
      });
    }
    function pulse(){
      restore(active);
      active = null;
      if(stopTimer) clearTimeout(stopTimer);
      stopTimer = null;
      if(document.hidden) return;
      var motes = visibleMotes();
      if(!motes.length) return;
      active = motes[cursor % motes.length];
      cursor = (cursor + 1) % Math.max(1, motes.length);
      active.classList.add('mote-avatar-animating');
      active.setAttribute('src', active.getAttribute('data-mote-animated-src'));
      stopTimer = setTimeout(function(){ restore(active); active = null; stopTimer = null; }, 5200);
    }
    setInterval(pulse, 30000);
    document.addEventListener('visibilitychange', function(){
      if(document.hidden){
        restore(active);
        active = null;
        if(stopTimer) clearTimeout(stopTimer);
        stopTimer = null;
      }
    });
  })();
  function loadInstanceConfig(){
    return fetch('/api/instance', {credentials:'include'}).then(function(r){ return r.json(); }).then(function(data){
      if(data && typeof data.name === 'string' && data.name) INSTANCE.name = data.name;
      if(data && Array.isArray(data.domains) && data.domains.length) INSTANCE.domains = data.domains;
      if(data && data.localPreview === true) STYLED_SKIP_AUTH = true;
      AUTH_CONFIG = data && data.auth && data.auth.provider === 'clerk' ? data.auth : null;
      refreshAppName();
    }).catch(function(){ /* keep defaults above */ });
  }
  function domainErrorMessage(){
    var list = INSTANCE.domains.map(function(d){ return '@' + d; });
    if(!list.length || (list.length === 1 && list[0] === '@example.com')){
      return 'Please use an email address authorized for this installation.';
    }
    var joined = list.length <= 1 ? (list[0] || '')
      : list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1];
    return 'Please use your ' + joined + ' email address.';
  }

  /* ============ STATE ============ */
  var currentUser = null;
  var currentAccountEmail = null;
  var currentUserLocalProfile = false;
  // From GET /api/me — gates the channel-settings "Reset channel" action.
  // Never trusted client-side alone (the server 403s a non-admin's actual
  // POST too); this only decides whether the UI offers the option at all.
  var isAdmin = false;
  var agentTimer = null;

  var ROUTES = ['chat','agent-admin','integrations'];

  /* ============ HELPERS ============ */
  function el(sel, root){ return (root||document).querySelector(sel); }
  function els(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function appConfirm(message){
    return new Promise(function(resolve){
      var previousFocus = document.activeElement;
      var overlay = document.createElement('div');
      overlay.className = 'app-confirm-overlay open';
      overlay.setAttribute('role', 'presentation');

      var card = document.createElement('div');
      card.className = 'app-confirm-card';
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'appConfirmMessage');

      var copy = document.createElement('div');
      copy.className = 'app-confirm-msg';
      copy.id = 'appConfirmMessage';
      copy.textContent = String(message || 'Are you sure?');

      var actions = document.createElement('div');
      actions.className = 'app-confirm-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      var confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'btn app-confirm-danger';
      confirm.textContent = 'Delete';

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      card.appendChild(copy);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      var settled = false;
      function finish(value){
        if(settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
        if(previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        resolve(value);
      }
      function onKeydown(event){
        if(event.key === 'Escape'){
          event.preventDefault();
          finish(false);
        }
      }
      cancel.addEventListener('click', function(){ finish(false); });
      confirm.addEventListener('click', function(){ finish(true); });
      overlay.addEventListener('click', function(event){ if(event.target === overlay) finish(false); });
      document.addEventListener('keydown', onKeydown);
      confirm.focus();
    });
  }
  function appPrompt(initialText, options){
    options = options || {};
    return new Promise(function(resolve){
      var previousFocus = document.activeElement;
      var overlay = document.createElement('div');
      overlay.className = 'app-prompt-overlay open';
      overlay.setAttribute('role', 'presentation');

      var card = document.createElement('div');
      card.className = 'app-prompt-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');

      var title = document.createElement('h2');
      title.className = 'app-prompt-title';
      title.textContent = String(options.title || 'Edit message');
      var message = document.createElement('p');
      message.className = 'app-prompt-msg';
      message.textContent = String(options.message || 'Update the text, then continue.');
      var input = document.createElement('textarea');
      input.className = 'app-prompt-input';
      input.value = String(initialText || '');
      input.setAttribute('aria-label', String(options.inputLabel || 'Text'));
      var note = document.createElement('p');
      note.className = 'app-prompt-note';
      note.textContent = String(options.note || '');
      note.hidden = !note.textContent;
      var actions = document.createElement('div');
      actions.className = 'app-prompt-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      var submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn app-prompt-submit';
      submit.textContent = String(options.submitLabel || 'Save');
      actions.append(cancel, submit);
      card.append(title, message, input, note, actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      var settled = false;
      function finish(result){
        if(settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
        if(previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        resolve(result);
      }
      function onKeydown(event){
        if(event.key === 'Escape'){
          event.preventDefault();
          finish({ok:false, text:''});
        }
      }
      cancel.addEventListener('click', function(){ finish({ok:false, text:''}); });
      submit.addEventListener('click', function(){ finish({ok:true, text:input.value}); });
      overlay.addEventListener('click', function(event){ if(event.target === overlay) finish({ok:false, text:''}); });
      document.addEventListener('keydown', onKeydown);
      input.focus();
      input.select();
    });
  }
  function firstNameFromEmail(email){
    var local = (email || '').split('@')[0] || '';
    var token = local.split(/[._]/)[0] || local;
    if(!token) return 'Your';
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  function initialsFromEmail(email){
    var local = (email || '').split('@')[0] || '';
    var parts = local.split(/[._]/).filter(Boolean);
    if(parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (local.charAt(0) || '?').toUpperCase();
  }
  // Per-user profile (display name + initials), stored server-side and
  // editable in the Settings drawer. Keyed by lowercased email. Populated
  // from GET /api/me at boot (for the signed-in user) and from every
  // user-directory responses (for everyone
  // else the roster mentions) — see loadMentionRoster and openDmCompose.
  var userProfiles = {};
  function mergeUserProfile(email, profile){
    if(!email || !profile) return;
    var key = email.toLowerCase();
    var displayName = profile.displayName;
    var initials = profile.initials;
    var avatarUrl = profile.avatarUrl || profile.avatar || profile.photoUrl || profile.imageUrl || profile.picture;
    if(typeof avatarUrl !== 'string') avatarUrl = null;
    if(!displayName && !initials && !avatarUrl) return;
    var existing = userProfiles[key] || {};
    userProfiles[key] = {
      displayName: displayName || existing.displayName || null,
      initials: initials || existing.initials || null,
      avatarUrl: avatarUrl || existing.avatarUrl || null
    };
  }
  // Roster rows show a name, not a raw address — a user with a saved profile
  // gets their real name/initials from userProfiles, everyone else falls
  // back to their email's local part title-cased ("jane.doe" -> "Jane
  // Doe"). The full email always still shows in the card's EMAIL row, so
  // nothing here is lossy.
  function displayNameForEmail(email){
    var known = userProfiles[(email || '').toLowerCase()];
    if(known && known.displayName) return known.displayName;
    var local = (email || '').split('@')[0] || '';
    var parts = local.split(/[._]/).filter(Boolean);
    if(!parts.length) return email || '?';
    return parts.map(function(p){ return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }).join(' ');
  }
  function initialsFromDisplayName(displayName){
    var parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
    if(parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return ((parts[0] || '').charAt(0) || '?').toUpperCase();
  }
  function initialsForUser(email){
    var known = userProfiles[(email || '').toLowerCase()];
    // The authoritative profile determines the visible avatar rather than a
    // stale locally saved value.
    if(known && known.initials) return known.initials;
    if(known && known.displayName) return initialsFromDisplayName(known.displayName);
    return initialsFromEmail(email);
  }
  function humanAvatarTone(email){
    var key = String(email || '').trim().toLowerCase();
    var hash = 0;
    for(var i = 0; i < key.length; i++) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0;
    return 'tone-' + (hash % 6);
  }
  function humanAvatarInitialsHtml(email){
    return '<span class="human-avatar-initials human-avatar-' + humanAvatarTone(email) + '">' + esc(initialsForUser(email)) + '</span>';
  }
  function humanAvatarContent(email){
    var known = userProfiles[(email || '').toLowerCase()] || {};
    var src = known.avatarUrl;
    var initials = humanAvatarInitialsHtml(email);
    if(!src) return initials;
    return initials + '<img class="human-avatar-image" src="' + esc(src) + '" alt="" aria-hidden="true" onerror="this.style.display=\'none\'" />';
  }
  function api(path, opts){
    opts = opts || {};
    opts.credentials = 'include';
    opts.headers = Object.assign({'Accept':'application/json', 'X-MiaOS-Workspace':activeWorkspaceKey}, opts.headers || {});
    if(opts.body && typeof opts.body !== 'string'){
      opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function(r){
      return r.text().then(function(raw){
        var data = {};
        if(raw && raw.trim()){
          try {
            data = JSON.parse(raw);
          } catch(parseError){
            var contentType = String(r.headers.get('content-type') || '').toLowerCase();
            var isHtml = contentType.indexOf('text/html') !== -1 || /<(!doctype|html|body)\b/i.test(raw);
            var message = isHtml
              ? 'The Mia backend returned an HTML page instead of the expected JSON API response. Restart the local backend, then try again.'
              : 'The Mia backend returned an invalid JSON response.';
            var responseError = new Error(message);
            responseError.status = r.status;
            throw responseError;
          }
        }
        if(r.status === 401){
          if(!STYLED_SKIP_AUTH && !currentUserLocalProfile) hideApp();
          throw new Error('unauthorized');
        }
        return {status: r.status, data: data, raw: raw};
      });
    });
  }

  /* ============ AUTH ============ */
  var desktopReadySignaled = false;
  var clerkLoadPromise = null;
  var clerkExchangeBusy = false;
  var clerkSigningOut = false;
  var nativeClerkViewDispose = null;
  function desktopClerkAuth(){ return window.miaDesktop && window.miaDesktop.auth; }

  function loadClerkAsset(src, attributes){
    return new Promise(function(resolve, reject){
      var existing = document.querySelector('script[src="' + src + '"]');
      if(existing){
        if(existing.getAttribute('data-loaded') === 'true') return resolve();
        existing.addEventListener('load', resolve, {once:true});
        existing.addEventListener('error', reject, {once:true});
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      Object.keys(attributes || {}).forEach(function(name){ script.setAttribute(name, attributes[name]); });
      script.addEventListener('load', function(){ script.setAttribute('data-loaded', 'true'); resolve(); }, {once:true});
      script.addEventListener('error', reject, {once:true});
      document.head.appendChild(script);
    });
  }

  function ensureClerkLoaded(){
    if(!AUTH_CONFIG || !AUTH_CONFIG.publishableKey) return Promise.reject(new Error('Clerk is not configured'));
    if(clerkLoadPromise) return clerkLoadPromise;
    clerkLoadPromise = loadClerkAsset('/vendor/clerk-ui/ui.browser.js').then(function(){
      return loadClerkAsset('/vendor/clerk-js/clerk.browser.js', {
        'crossorigin':'anonymous',
        'data-clerk-publishable-key':AUTH_CONFIG.publishableKey
      });
    }).then(function(){
      if(!window.Clerk || typeof window.Clerk.load !== 'function') throw new Error('Clerk did not initialize');
      return window.Clerk.load({ui:{ClerkUI:window.__internal_ClerkUICtor}}).then(function(){ return window.Clerk; });
    });
    return clerkLoadPromise;
  }

  function finishClerkLogin(){
    var nativeAuth = desktopClerkAuth();
    if(clerkExchangeBusy || clerkSigningOut || (!nativeAuth && (!window.Clerk || !window.Clerk.session))) return Promise.resolve(false);
    clerkExchangeBusy = true;
    var errEl = el('#loginError');
    if(errEl) errEl.textContent = '';
    var getToken = nativeAuth ? nativeAuth.getSessionToken().then(window.MiaClerkDesktop.unwrap) : window.Clerk.session.getToken();
    return getToken.then(function(token){
      if(!token) throw new Error('Clerk did not return a session token');
      return fetch('/api/clerk/session', {
        method:'POST',
        credentials:'include',
        headers:{'Accept':'application/json', 'Authorization':'Bearer ' + token}
      });
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(data){ return {status:response.status, data:data}; });
    }).then(function(result){
      if(result.status !== 200){
        if(result.status === 409) throw new Error('This Mia installation is already linked to another account.');
        if(result.status === 422) throw new Error('Mia needs the verified email claim enabled in Clerk.');
        throw new Error('Mia could not verify this Clerk session.');
      }
      return api('/api/me').then(function(meRes){
        if(meRes.status !== 200 || !meRes.data || !meRes.data.email) throw new Error('Mia could not open the local session.');
        currentUserLocalProfile = false;
        mergeUserProfile(meRes.data.email, meRes.data);
        isAdmin = !!meRes.data.isAdmin;
        showApp(meRes.data.email, meRes.data.accountEmail);
        return true;
      });
    }).catch(function(error){
      if(errEl) errEl.textContent = error && error.message ? error.message : 'Could not sign in. Try again.';
      return false;
    }).then(function(result){ clerkExchangeBusy = false; return result; }, function(error){ clerkExchangeBusy = false; throw error; });
  }

  function showClerkSignIn(){
    if(!AUTH_CONFIG) return hideApp();
    var form = el('#loginForm');
    var mount = el('#clerkSignIn');
    var wall = el('#loginWall');
    if(form) form.hidden = true;
    if(mount) mount.hidden = false;
    if(wall) wall.classList.add('clerk-active');
    setLoginEnabled(true);
    setAppLoading(false);
    el('#loginWall').classList.remove('hidden');
    el('#appShell').classList.remove('visible');
    signalDesktopReady();
    // Mia owns the hash router after sign-in. Leaving #/chat in place here
    // makes Clerk's embedded router silently render an empty sign-in root.
    // showApp() restores the default chat route after authentication.
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    if(desktopClerkAuth()){
      if(nativeClerkViewDispose) nativeClerkViewDispose();
      nativeClerkViewDispose = window.MiaClerkDesktop.mount(mount, desktopClerkAuth(), finishClerkLogin);
      return;
    }
    ensureClerkLoaded().then(function(clerk){
      if(clerk.user && clerk.session) return finishClerkLogin();
      clerk.mountSignIn(mount, {
        routing:'virtual',
        appearance:{
          variables:{
            colorPrimary:'#171717',
            colorText:'#171717',
            colorTextSecondary:'#737373',
            colorBackground:'#ffffff',
            colorInputBackground:'#ffffff',
            colorInputText:'#171717',
            borderRadius:'12px',
            fontFamily:'Instrument Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
          },
          elements:{
            rootBox:'mia-clerk-root',
            cardBox:'mia-clerk-card-box',
            card:'mia-clerk-card',
            header:'mia-clerk-header',
            socialButtonsBlockButton:'mia-clerk-social-button',
            formButtonPrimary:'mia-clerk-primary-button',
            formFieldInput:'mia-clerk-input',
            footer:'mia-clerk-footer'
          }
        }
      });
      clerk.addListener(function(state){
        if(state && state.user && state.session) finishClerkLogin();
      });
      return false;
    }).catch(function(error){
      var errEl = el('#loginError');
      if(errEl) errEl.textContent = error && error.message ? error.message : 'Could not load sign in. Check your connection.';
    });
  }
  function setAppLoading(loading){
    var overlay = el('#appLoadingOverlay');
    if(!overlay) return;
    overlay.classList.toggle('hidden', !loading);
    overlay.setAttribute('aria-hidden', loading ? 'false' : 'true');
  }
  function signalDesktopReady(){
    if(desktopReadySignaled) return;
    desktopReadySignaled = true;
    if(window.miaDesktop && typeof window.miaDesktop.ready === 'function') window.miaDesktop.ready();
  }
  function signalDesktopHydrated(){
    if(window.miaDesktop && typeof window.miaDesktop.hydrated === 'function') window.miaDesktop.hydrated();
  }

  function syncAdminMenuItem(){
    var adminItem = el('#chatAcctAdmin');
    if(adminItem) adminItem.hidden = !isAdmin || activeWorkspaceKey === 'solo';
  }

  function showApp(email, accountEmail){
    setAppLoading(true);
    currentUser = email;
    currentAccountEmail = accountEmail || email;
    refreshAppName();
    loadChatPinned();
    loadChatAttention();
    loadChatPinnedFromServer();
    setLoginEnabled(false);
    el('#loginWall').classList.add('hidden');
    el('#appShell').classList.add('visible');
    el('#avatarBtn').innerHTML = humanAvatarInitialsHtml(email);
    el('#avatarMenuEmail').textContent = currentUserLocalProfile ? 'Local profile' : currentAccountEmail;
    var chatAcctAvatar = el('#chatAcctAvatar');
    var chatAcctName = el('#chatAcctName');
    if(chatAcctAvatar) chatAcctAvatar.innerHTML = humanAvatarInitialsHtml(email);
    if(chatAcctName) chatAcctName.textContent = displayNameForEmail(email);
    [el('#logoutBtn'), el('#chatAcctLogout'), el('#settingsSignOut')].forEach(function(control){
      if(!control) return;
      control.hidden = currentUserLocalProfile;
      control.style.display = currentUserLocalProfile ? 'none' : '';
    });
    // Once authenticated, remove the credential form from the document.
    // Clearing and hiding it is not enough: password managers still inspect
    // hidden login fields and can pair the saved credential with the composer.
    var loginForm = el('#loginForm');
    if(loginForm) loginForm.remove();
    if(nativeClerkViewDispose){ nativeClerkViewDispose(); nativeClerkViewDispose = null; }
    syncAdminMenuItem();
    if(STYLED_SKIN){
      var styledBootHash = location.hash.replace(/^#\//, '').split('?')[0];
      if(STYLED_ROUTES.indexOf(styledBootHash) === -1) location.hash = '#/chat';
    } else {
      var bootHash = location.hash.replace('#/', '');
      var bootDept = bootHash.indexOf('dept-') === 0 ? findDepartmentBySlug(bootHash.slice(5)) : null;
      if(!location.hash || (!bootDept && ROUTES.indexOf(bootHash) === -1)){
        location.hash = '#/dashboard';
      }
    }
    renderIamTable();
    renderAcpDepartments();
    refreshDepartmentsFromServer();
    var initialRender = route();
    // Reveal the native window behind the dedicated loading gate. The gate
    // remains above both the app shell and credential wall until the first
    // authoritative route hydration finishes.
    signalDesktopReady();
    loadHarnessProviderCatalog();
    loadHarnessSettings(true).then(function(){
      if(chatModelPicker && typeof chatModelPicker.ensureLoaded === 'function'){
        chatModelPicker.ensureLoaded();
      }
      if(harnessSettingsCache.onboardingComplete){
        Promise.resolve(initialRender).then(startMiaOnboardingChat);
      }
    });
    Promise.resolve(initialRender).then(function(){
      startLiveRefreshPolling();
      setAppLoading(false);
      signalDesktopHydrated();
      restoreLocalBrowserAfterBoot();
    }, function(){
      startLiveRefreshPolling();
      setAppLoading(false);
      signalDesktopHydrated();
      restoreLocalBrowserAfterBoot();
    });
  }

  function setLoginEnabled(enabled){
    var form = el('#loginForm');
    var wall = el('#loginWall');
    if(wall){
      wall.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      if(!enabled) wall.setAttribute('inert', '');
      else wall.removeAttribute('inert');
    }
    if(!form) return;
    form.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    if(!enabled) form.setAttribute('inert', '');
    else form.removeAttribute('inert');
    els('input, button', form).forEach(function(field){ field.disabled = !enabled; });
  }

  function appShortcutTargetIsEditable(target){
    if(!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
  }

  // Keep the app shortcuts small and predictable. Text editors own their
  // keystrokes; these commands only run from the shell chrome.
  document.addEventListener('keydown', function(event){
    if(!currentUser || event.defaultPrevented || event.isComposing || appShortcutTargetIsEditable(event.target)) return;
    if(!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if(el('#harnessOnboarding.open') || el('#settingsDrawer.open') || (typeof tour !== 'undefined' && tour.active)) return;
    var key = String(event.key || '').toLowerCase();
    if(key === 'k' && !event.shiftKey){
      event.preventDefault();
      if(location.hash !== '#/chat'){
        location.hash = '#/chat';
        route();
      }
      var search = el('#chatSearch');
      if(search) search.focus();
    } else if(key === 'n' && !event.shiftKey){
      event.preventDefault();
      openDmCompose();
    } else if(key === 'b' && event.shiftKey){
      event.preventDefault();
      startAgentSetupChat();
    }
  });

  function hideApp(){
    currentUser = null;
    currentAccountEmail = null;
    currentUserLocalProfile = false;
    isAdmin = false;
    syncAdminMenuItem();
    // showApp() removes credential fields so they cannot be mistaken for chat
    // inputs. A fresh document restores the login form when re-authentication
    // is actually needed.
    if(!el('#loginForm')){
      window.location.reload();
      return;
    }
    setLoginEnabled(true);
    setAppLoading(false);
    el('#loginWall').classList.remove('hidden');
    el('#appShell').classList.remove('visible');
    var e = el('#loginEmail'), p = el('#loginPassword');
    if(e) e.value = '';
    if(p) p.value = '';
    stopLiveRefreshPolling();
    signalDesktopReady();
  }

  loadInstanceConfig().then(function(){
    if(STYLED_SKIP_AUTH){
    // Let the rest of this IIFE finish declaring the app state before the
    // normal post-login boot touches it (the authenticated path is already
    // asynchronous through /api/me).
    setTimeout(function(){
      // The preview bypass must still hydrate the real owner profile. This
      // keeps the existing Settings profile in charge of the account row
      // instead of inventing "Preview".
      api('/api/me').then(function(res){
        if(res.status === 200 && res.data && res.data.email){
          currentUserLocalProfile = res.data.localProfile === true;
          mergeUserProfile(res.data.email, res.data);
          isAdmin = !!res.data.isAdmin;
          showApp(res.data.email, res.data.accountEmail);
        } else {
          hideApp();
        }
      }).catch(function(error){ console.error('Mia startup failed', error); hideApp(); });
    }, 0);
    } else {
      // Refresh the native Clerk session before trusting a persisted local
      // app cookie. Client JWTs stay in the main process/OS credential store.
      if(AUTH_CONFIG && desktopClerkAuth()) return showClerkSignIn();
      api('/api/me').then(function(res){
        if(res.status === 200 && res.data && res.data.email){
          currentUserLocalProfile = res.data.localProfile === true;
          mergeUserProfile(res.data.email, res.data);
          isAdmin = !!res.data.isAdmin;
          showApp(res.data.email, res.data.accountEmail);
        }
        else { hideApp(); }
      }).catch(function(error){ console.error('Mia startup failed', error); showClerkSignIn(); });
    }
  });

  el('#loginForm').addEventListener('submit', function(e){
    e.preventDefault();
    var email = el('#loginEmail').value.trim();
    var pass = el('#loginPassword').value;
    var errEl = el('#loginError');
    errEl.textContent = '';
    fetch('/api/login', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email: email, password: pass})
    }).then(function(r){
      return r.json().then(function(data){ return {status:r.status, data:data}; });
    }).then(function(res){
      if(res.status === 200 && res.data && res.data.ok){
        var loginEmail = res.data.email || email;
        // Boot-time /api/me is skipped on this path (we already know we're
        // logged in) but isAdmin/profile still need fetching once here —
        // otherwise a freshly-logged-in session would show no admin options
        // until the next full page load.
        api('/api/me').then(function(meRes){
          if(meRes.status === 200 && meRes.data){
            currentUserLocalProfile = meRes.data.localProfile === true;
            mergeUserProfile(loginEmail, meRes.data);
            isAdmin = !!meRes.data.isAdmin;
          }
          showApp(meRes.status === 200 && meRes.data && meRes.data.email ? meRes.data.email : loginEmail,
            meRes.status === 200 && meRes.data ? meRes.data.accountEmail : null);
        }).catch(function(){ showApp(loginEmail); });
      } else if(res.status === 400){
        errEl.textContent = domainErrorMessage();
      } else if(res.status === 401){
        errEl.textContent = 'Incorrect password. Please try again.';
      } else {
        errEl.textContent = 'Could not verify. Try again.';
      }
    }).catch(function(){ errEl.textContent = 'Could not verify. Try again.'; });
  });

  el('#logoutBtn').addEventListener('click', function(){
    clerkSigningOut = true;
    var clerkSignOut = AUTH_CONFIG && desktopClerkAuth() ? desktopClerkAuth().signOut().then(window.MiaClerkDesktop.unwrap) : AUTH_CONFIG ? ensureClerkLoaded().then(function(clerk){
      return clerk && typeof clerk.signOut === 'function' ? clerk.signOut() : null;
    }).catch(function(){}) : Promise.resolve();
    clerkSignOut.then(function(){
      return fetch('/api/logout', {method:'POST', credentials:'include'}).then(function(response){
        if(!response.ok) throw new Error('Could not end the local session. Please try signing out again.');
      });
    }).then(function(){ window.location.reload(); }).catch(function(error){
      clerkSigningOut = false;
      window.alert(error.message || 'Sign-out did not finish. Please try again.');
    });
  });

  /* ============ ROUTER ============ */
  var LAYERS = ['platform','agents'];
  var LAYER_LABELS = {platform:'Chat', agents:'Bots'};
  var WORKSPACE_PANELS = [];
  var LAYER_PANELS = {
    platform: [{route:'chat', label:'Messages'}],
    agents:   [{route:'agent-admin', label:'My Bots'}]
  };
  var PANEL_LAYER = {};
  var PANEL_LABEL = {};
  LAYERS.forEach(function(layer){
    LAYER_PANELS[layer].forEach(function(p){ PANEL_LAYER[p.route] = layer; PANEL_LABEL[p.route] = p.label; });
  });
  /* department tabs are data-driven (editable list, see loadDepartments()) — computed fresh
     on every render instead of baked into the static LAYER_PANELS table above */
  function agentsLayerPanels(){
    return [{route:'agent-admin', label:'My Bots'}].concat(loadDepartments().map(function(d){
      return {route:'dept-' + slugifyDept(d), label:d, deptName:d};
    }));
  }
  function findDepartmentBySlug(slug){
    var list = loadDepartments();
    for(var i = 0; i < list.length; i++){ if(slugifyDept(list[i]) === slug) return list[i]; }
    return null;
  }
  function currentDeptRouteName(){
    var hash = location.hash.replace('#/', '');
    return hash.indexOf('dept-') === 0 ? findDepartmentBySlug(hash.slice(5)) : null;
  }

  function renderPanelTabs(layer, activeHash){
    var wrap = el('#panelTabs');
    var items = layer === 'agents' ? agentsLayerPanels() : (LAYER_PANELS[layer] || []);
    wrap.innerHTML = items.map(function(p){
      return '<a href="#/' + p.route + '" class="panel-tab' + (p.route === activeHash ? ' active' : '') + '" data-route="' + p.route + '">' + esc(p.label) + '</a>';
    }).join('');
  }

  var PREVIEW_ROUTES = [];
  var SCRIPTED_FEED_ROUTES = [];

  function route(){
    // Public builds expose chat plus the standalone Manage Bots bench.
    var rawRoute = location.hash.replace(/^#\//, '');
    var routeParts = rawRoute.split('?');
    var routeHash = routeParts[0] || '';
    if(STYLED_SKIN && STYLED_ROUTES.indexOf(routeHash) === -1){ location.hash = '#/chat'; return; }
    if(STYLED_SKIN) document.body.classList.toggle('styled-integrations-view', routeHash === 'integrations');
    if(STYLED_SKIN) document.body.classList.toggle('styled-agent-admin-view', routeHash === 'agent-admin');
    var hash = location.hash.replace('#/', '') || 'chat';
    if(hash === 'agents'){ location.hash = '#/agent-admin'; return; }
    var deptName = hash.indexOf('dept-') === 0 ? findDepartmentBySlug(hash.slice(5)) : null;
    if(hash.indexOf('dept-') === 0 && !deptName){ location.hash = '#/agent-admin'; return; }
    if(!deptName && ROUTES.indexOf(hash) === -1) hash = 'chat';
    els('.panel').forEach(function(p){ p.classList.remove('active'); });
    var panel = el('#' + (deptName ? 'panel-department' : 'panel-' + hash));
    if(panel) panel.classList.add('active');

    var layer = deptName ? 'agents' : (PANEL_LAYER[hash] || 'platform');
    renderPanelTabs(layer, hash);
    els('.layer-menu-item').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-layer') === layer); });
    el('#wordmarkLayer').textContent = LAYER_LABELS[layer];
    var mainContent = el('#mainContent');
    if(mainContent) mainContent.classList.toggle('chat-mode', hash === 'chat');

    if(agentTimer && SCRIPTED_FEED_ROUTES.indexOf(hash) === -1){
      clearTimeout(agentTimer);
      agentTimer = null;
    }

    var onAgentsLayer = deptName ? true : (PANEL_LAYER[hash] === 'agents');
    el('#configPanelToggle').classList.toggle('hidden', !onAgentsLayer);
    if(!onAgentsLayer){ el('#agentConfigPanel').classList.remove('open'); el('#configPanelToggle').classList.remove('active'); }
    if(hash !== 'chat'){ stopChatPolling(); }
    if(deptName){ renderDepartmentPanel(deptName); }
    else if(hash === 'agent-admin'){ renderAgentAdminPanel(); }
    if(hash === 'chat'){
      var chatReady = renderChatWorkspace();
      return chatReady;
    }
    return Promise.resolve();
  }
  window.addEventListener('hashchange', route);

  /* Layer dropdown: click "· Data" to open a menu of the 3 layers */
  (function(){
    var btn = el('#layerDropdownBtn');
    var menu = el('#layerMenu');
    function closeMenu(){
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggleMenu(){
      var open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      toggleMenu();
    });
    els('.layer-menu-item').forEach(function(t){
      t.addEventListener('click', function(){
        var layer = t.getAttribute('data-layer');
        var items = LAYER_PANELS[layer];
        closeMenu();
        if(items && items.length) location.hash = '#/' + items[0].route;
      });
    });
    document.addEventListener('click', function(e){
      if(!menu.contains(e.target) && e.target !== btn) closeMenu();
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape') closeMenu();
    });
  })();

  /* Avatar dropdown: initials circle -> email / Settings / Sign out */
  (function(){
    var btn = el('#avatarBtn');
    var menu = el('#avatarMenu');
    function closeMenu(){
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggleMenu(){
      var open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      toggleMenu();
    });
    document.addEventListener('click', function(e){
      if(!menu.contains(e.target) && e.target !== btn) closeMenu();
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape') closeMenu();
    });
    el('#openSettingsBtn').addEventListener('click', function(){
      closeMenu();
      openSettingsDrawer();
    });

    /* Company switcher: config-driven (INSTANCE.companies), not hardcoded —
       a single-deployment default has zero/one entries and just renders
       nothing here. Each entry navigates to its own sibling deployment path,
       highlighting whichever one matches the current URL. */
    var switcherWrap = el('#companySwitcher');
    var companies = Array.isArray(INSTANCE.companies) ? INSTANCE.companies : [];
    if(switcherWrap && companies.length > 1){
      switcherWrap.innerHTML = '<div class="avatar-menu-label">Company</div>' + companies.map(function(c, i){
        return '<button type="button" class="avatar-menu-item avatar-menu-company" data-company-path="' + esc(c.path) + '" role="menuitem"><span>' + esc(c.label) + '</span><span class="amc-dot"></span></button>';
      }).join('');
      els('.avatar-menu-company', switcherWrap).forEach(function(cbtn){
        var path = cbtn.getAttribute('data-company-path');
        if(location.pathname.indexOf(path) === 0) cbtn.classList.add('active');
        cbtn.addEventListener('click', function(){
          if(location.pathname.indexOf(path) === 0) { closeMenu(); return; }
          location.href = path;
        });
      });
    }
  })();

  /* ============ SETTINGS DRAWER ============ */
  var HERMES_PROVIDER_LABELS = {
    'claude-subscription-directsdk-experimental': 'Claude subscription (Experimental)',
    'openai-codex': 'ChatGPT subscription',
    'xai-oauth': 'Grok subscription',
    'openai-api': 'OpenAI API',
    'xai': 'xAI API'
  };
  // Subscription choices have their own OAuth flow. The API connection
  // dropdown is populated from the provider catalog exposed by Hermes, with
  // this local catalog as a safe first-paint fallback.
  var harnessApiProviderCatalog = [
    {id:'managed-router', label:'Managed Router'},
    {id:'openai-api', label:'OpenAI'},
    {id:'xai', label:'xAI'},
    {id:'anthropic', label:'Anthropic'},
    {id:'gemini', label:'Google AI Studio'},
    {id:'deepseek', label:'DeepSeek'},
    {id:'alibaba', label:'Qwen Cloud'},
    {id:'alibaba-coding-plan', label:'Alibaba Cloud (Coding Plan)'},
    {id:'openrouter', label:'OpenRouter'},
    {id:'fireworks', label:'Fireworks AI'},
    {id:'novita', label:'NovitaAI'},
    {id:'lmstudio', label:'LM Studio'},
    {id:'nvidia', label:'NVIDIA NIM'},
    {id:'copilot', label:'GitHub Copilot'},
    {id:'huggingface', label:'Hugging Face'},
    {id:'xiaomi', label:'Xiaomi MiMo'},
    {id:'tencent-tokenhub', label:'Tencent TokenHub'},
    {id:'zai', label:'Z.AI / GLM'},
    {id:'kimi-coding', label:'Kimi / Kimi Coding Plan'},
    {id:'kimi-coding-cn', label:'Kimi / Moonshot (China)'},
    {id:'stepfun', label:'StepFun Step Plan'},
    {id:'minimax', label:'MiniMax'},
    {id:'minimax-cn', label:'MiniMax (China)'},
    {id:'ollama-cloud', label:'Ollama Cloud'},
    {id:'arcee', label:'Arcee AI'},
    {id:'gmi', label:'GMI Cloud'},
    {id:'kilocode', label:'Kilo Code'},
    {id:'opencode-zen', label:'OpenCode Zen'},
    {id:'opencode-go', label:'OpenCode Go'},
    {id:'azure-foundry', label:'Azure Foundry'},
    {id:'ai-gateway', label:'Vercel AI Gateway'},
    {id:'deepinfra', label:'DeepInfra'},
    {id:'upstage', label:'Upstage Solar'}
  ];
  var HERMES_AUTH_NAMES = {
    'claude-subscription-directsdk-experimental': 'Claude',
    'openai-codex': 'ChatGPT',
    'xai-oauth': 'Grok'
  };
  var harnessModelCatalog = {
    'openai-codex': {
      defaultModel: 'gpt-5.6-luna',
      options: [
        {id:'fast', model:'gpt-5.6-luna', label:'Fast', fast:true},
        {id:'gpt-6-astra', model:'gpt-6-astra', label:'GPT-6 Astra'},
        {id:'gpt-5.6-sol', model:'gpt-5.6-sol', label:'Sol'},
        {id:'gpt-5.6-terra', model:'gpt-5.6-terra', label:'Terra'},
        {id:'gpt-5.6-luna', model:'gpt-5.6-luna', label:'Luna'}
      ]
    },
    'xai-oauth': {
      defaultModel: 'grok-4.6',
      options: [
        {id:'grok-4.6', model:'grok-4.6', label:'Grok 4.6'},
        {id:'grok-4.5', model:'grok-4.5', label:'Grok 4.5'},
        {id:'grok-4.3', model:'grok-4.3', label:'Grok 4.3'},
        {id:'grok-composer-2.5-fast', model:'grok-composer-2.5-fast', label:'Grok Composer Fast'}
      ]
    }
  };
  var harnessSettingsCache = {provider: null, model: null, fast: false, mode: 'solo', onboardingComplete: false};
  var harnessOnboardingState = {provider: null, model: null, fast: false, apiProvider: 'openai-api', mode: 'solo'};
  var harnessAuthPollTimer = null;
  var harnessAuthGeneration = 0;
  var harnessAuthAwaitingSave = false;
  var harnessAuthSaveInProgress = false;
  var harnessConnectionPending = null;
  var harnessConnectionValidationPending = false;
  var harnessConnectionState = {
    'claude-subscription-directsdk-experimental': false,
    'openai-codex': false,
    'xai-oauth': false
  };
  harnessApiProviderCatalog.forEach(function(provider){ harnessConnectionState[provider.id] = false; });

  // The chat composer receives its model inventory from Hermes' authenticated
  // picker endpoint when opened. Keep this state separate from onboarding so a
  // per-turn choice never rewrites the user's saved provider preference.
  var chatModelPicker = {
    loaded: false,
    loading: false,
    error: '',
    providers: [],
    selection: {provider: null, model: null, family: '', familyKey: '', familyProviderId: '', variant: '', reasoningEffort: '', speed: ''},
    stage: 'family',
    // Transient UI-only flag for the "switch provider" screen — see goBack()
    // and renderOptions() in the composer model picker below.
    showProviderSwitcher: false
  };
  var CHAT_MODEL_SELECTION_CACHE_VERSION = 1;

  function chatModelSelectionCacheKey(workspaceKey){
    var owner = encodeURIComponent(String(currentUser || '').trim().toLowerCase());
    var workspace = WORKSPACE_OPTIONS[workspaceKey] ? workspaceKey : activeWorkspaceKey;
    return 'mia.chat-model-selection.v1:' + owner + ':' + workspace;
  }

  function readCachedChatModelSelection(){
    try {
      var cached = JSON.parse(localStorage.getItem(chatModelSelectionCacheKey()) || 'null');
      if(!cached || cached.version !== CHAT_MODEL_SELECTION_CACHE_VERSION) return null;
      if(!cached.provider || !cached.model) return null;
      return {
        provider: String(cached.provider),
        model: String(cached.model),
        reasoningEffort: String(cached.reasoningEffort || 'high'),
        speed: cached.speed === 'fast' ? 'fast' : 'normal'
      };
    } catch(error){ return null; }
  }

  function cacheChatModelSelection(selection){
    if(!selection || !selection.provider || !selection.model) return;
    try {
      localStorage.setItem(chatModelSelectionCacheKey(), JSON.stringify({
        version: CHAT_MODEL_SELECTION_CACHE_VERSION,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort || 'high',
        speed: selection.speed === 'fast' ? 'fast' : 'normal'
      }));
    } catch(error){}
  }

  function clearCachedChatModelSelection(){
    try { localStorage.removeItem(chatModelSelectionCacheKey()); } catch(error){}
  }

  function normalizeChatModelProviders(providers){
    return (Array.isArray(providers) ? providers : []).map(function(provider){
      return {
        id: String(provider.id || provider.slug || '').trim().toLowerCase(),
        label: String(provider.label || provider.name || provider.id || '').trim(),
        models: Array.isArray(provider.models) ? provider.models.map(function(model){ return String(model || '').trim(); }).filter(Boolean) : [],
        capabilities: provider.capabilities || {}
      };
    }).filter(function(provider){ return provider.id && provider.models.length; });
  }

  function chatModelTitleCase(value){
    return String(value || '').split(/[-_\s]+/).filter(Boolean).map(function(part){
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join(' ');
  }

  function chatModelParts(model){
    var raw = String(model || '').trim().toLowerCase();
    var match = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(raw);
    if(match) return {family:'GPT', variant:'GPT ' + match[1] + (match[2] ? ' ' + chatModelTitleCase(match[2]) : ''), familyKey:'gpt'};
    if(raw.indexOf('gpt-') === 0) return {family:'GPT', variant:chatModelTitleCase(raw.replace(/-latest$/, '').replace(/-/g, ' ')), familyKey:'gpt'};
    match = /^grok-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(raw);
    if(match) return {family:'Grok', variant:match[1] + (match[2] ? ' ' + chatModelTitleCase(match[2]) : ''), familyKey:'grok'};
    // Claude route ids carry a version, an optional snapshot date, and the
    // `[1m]` long-context selector: claude-haiku-4-5-20251001 -> Haiku 4.5.
    match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(raw);
    if(match) return {family:'Claude', variant:chatModelTitleCase(match[1]) + ' ' + match[2] + (match[3] ? '.' + match[3] : ''), familyKey:'claude'};
    match = /^claude-(.+)$/.exec(raw);
    if(match) return {family:'Claude', variant:chatModelTitleCase(match[1].replace(/\[1m\]$/, '')), familyKey:'claude'};
    match = /^deepseek-(.+)$/.exec(raw);
    if(match) return {family:'DeepSeek', variant:chatModelTitleCase(match[1]), familyKey:'deepseek'};
    var pieces = raw.split('-');
    return {family:chatModelTitleCase(pieces.shift() || raw), variant:chatModelTitleCase(pieces.join(' ') || 'Default'), familyKey:raw.split('-')[0] || raw};
  }

  function chatConnectedModelEntries(){
    var result = [];
    (chatModelPicker.providers || []).forEach(function(provider){
      (provider.models || []).forEach(function(model){
        var parts = chatModelParts(model);
        var capability = provider.capabilities && (provider.capabilities[model] || provider.capabilities[String(model).toLowerCase()]);
        result.push({
          provider: provider.id,
          providerLabel: provider.label || provider.id,
          model: model,
          family: parts.family,
          familyKey: provider.id + ':' + parts.familyKey,
          variant: parts.variant,
          fast: !!(capability && capability.fast === true),
          reasoning: !(capability && capability.reasoning === false)
        });
      });
    });
    return result;
  }

  function chatModelSelectionMetadata(){
    var selection = chatModelPicker.selection || {};
    // Inventory hydration can briefly lag the rest of app startup. A cached
    // choice was previously validated against that inventory, so keep using it
    // instead of silently reverting the next message to the harness default.
    if(!selection.provider || !selection.model) selection = readCachedChatModelSelection() || {};
    if(!selection.provider || !selection.model) return null;
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || 'high',
      speed: selection.speed || 'normal',
      fast: selection.speed === 'fast'
    };
  }

  function harnessApiProvider(provider){
    var normalized = String(provider || '').trim().toLowerCase();
    if(normalized === 'openai') normalized = 'openai-api';
    return harnessApiProviderCatalog.filter(function(entry){ return entry.id === normalized; })[0] || null;
  }

  function normalizeHarnessApiProvider(provider){
    var match = harnessApiProvider(provider);
    return match ? match.id : (harnessApiProviderCatalog[0] && harnessApiProviderCatalog[0].id) || 'openai-api';
  }

  function harnessModelOption(provider, model, fast){
    var catalog = harnessModelCatalog[provider];
    if(!catalog || !Array.isArray(catalog.options)) return null;
    var value = String(model || '').trim().toLowerCase();
    var options = catalog.options;
    return options.filter(function(option){
      return option.id === value || (option.model === value && (fast === true ? option.fast === true : option.id !== 'fast'));
    })[0] || null;
  }

  function normalizeHarnessModel(provider, model, fast){
    var catalog = harnessModelCatalog[provider];
    if(!catalog) return {model:null, fast:false};
    var option = harnessModelOption(provider, model, fast);
    if(!option) option = harnessModelOption(provider, catalog.defaultModel, false);
    return {model: option ? option.model : catalog.defaultModel, fast: !!(option && option.fast && (fast === true || option.id === 'fast'))};
  }

  function renderHarnessModelOptions(){
    ['openai-codex', 'xai-oauth'].forEach(function(provider){
      var select = el(provider === 'openai-codex' ? '#harnessChatgptModel' : '#harnessGrokModel');
      var catalog = harnessModelCatalog[provider];
      if(!select || !catalog) return;
      var selected = normalizeHarnessModel(provider, harnessOnboardingState.model, harnessOnboardingState.fast);
      select.innerHTML = catalog.options.map(function(option){
        return '<option value="' + esc(option.id) + '">' + esc(option.label) + '</option>';
      }).join('');
      select.value = selected.fast ? 'fast' : (harnessOnboardingState.model || selected.model);
      if(!select.value) select.value = catalog.options[catalog.options.length - 1].id;
    });
  }

  function setHarnessModelCatalog(value){
    var providers = value && typeof value === 'object' ? value : {};
    ['openai-codex', 'xai-oauth'].forEach(function(provider){
      var incoming = providers[provider];
      if(!incoming || !Array.isArray(incoming.options) || !incoming.options.length) return;
      var options = incoming.options.map(function(option){
        return {
          id: String(option && option.id || '').trim().toLowerCase(),
          model: String(option && option.model || '').trim().toLowerCase(),
          label: String(option && option.label || '').trim(),
          fast: option && option.fast === true
        };
      }).filter(function(option){ return option.id && option.model && option.label; });
      if(options.length) harnessModelCatalog[provider] = {
        defaultModel: String(incoming.defaultModel || options[options.length - 1].model).trim().toLowerCase(),
        options: options
      };
    });
    renderHarnessModelOptions();
    renderHarnessOnboarding();
  }

  function harnessProviderDisplayName(provider){
    return HERMES_AUTH_NAMES[provider]
      || (harnessApiProvider(provider) && harnessApiProvider(provider).label)
      || HERMES_PROVIDER_LABELS[provider]
      || provider
      || 'provider';
  }

  function populateHarnessApiProviderOptions(){
    var select = el('#harnessApiProvider');
    if(!select) return;
    var current = normalizeHarnessApiProvider(harnessOnboardingState.apiProvider);
    harnessOnboardingState.apiProvider = current;
    try {
      select.innerHTML = harnessApiProviderCatalog.map(function(provider){
        return '<option value="' + esc(provider.id) + '">' + esc(provider.label) + '</option>';
      }).join('');
      select.value = current;
    } catch(_) {
      // Keep the server-independent option markup usable if a constrained
      // embedded browser blocks select DOM replacement.
    }
  }

  function setHarnessApiProviderCatalog(value){
    var incoming = Array.isArray(value) ? value : [];
    var next = incoming.map(function(provider){
      return {
        id: String(provider && provider.id || '').trim().toLowerCase(),
        label: String(provider && provider.label || '').trim()
      };
    }).filter(function(provider){ return provider.id && provider.label; });
    if(!next.length) return;
    harnessApiProviderCatalog = next;
    harnessApiProviderCatalog.forEach(function(provider){
      if(typeof harnessConnectionState[provider.id] !== 'boolean') harnessConnectionState[provider.id] = false;
    });
    populateHarnessApiProviderOptions();
    renderHarnessOnboarding();
  }

  function normalizeHarnessSettings(value){
    var input = value && typeof value === 'object' ? value : {};
    var provider = HERMES_PROVIDER_LABELS[input.provider] ? input.provider : null;
    var modelSelection = provider && provider !== 'openai-api'
      ? normalizeHarnessModel(provider, input.model, input.fast === true || input.model === 'fast')
      : {model:null, fast:false};
    return {
      provider: provider,
      model: modelSelection.model,
      fast: modelSelection.fast,
      apiProvider: normalizeHarnessApiProvider(input.apiProvider),
      mode: input.mode === 'multiplayer' ? 'multiplayer' : 'solo',
      onboardingComplete: !!input.onboardingComplete
    };
  }

  function renderHarnessSettings(value){
    harnessSettingsCache = normalizeHarnessSettings(value);
    var provider = el('#settingsHarnessProvider');
    var mode = el('#settingsHarnessMode');
    var providerLabel = harnessSettingsCache.provider === 'openai-api'
      ? (harnessProviderDisplayName(harnessSettingsCache.apiProvider))
      : HERMES_PROVIDER_LABELS[harnessSettingsCache.provider];
    var configured = !!(harnessSettingsCache.provider && harnessSettingsCache.onboardingComplete);
    var modeLabel = harnessSettingsCache.mode === 'multiplayer' ? 'Multiplayer' : 'Solo';
    if(provider){
      provider.className = 'status-pill ' + (configured ? 'live' : 'offline');
      provider.innerHTML = '<span class="dot"></span>' + esc(configured ? String(providerLabel || '').replace(/\bsubscription\b/gi, 'Subscription') : 'Not selected yet');
    }
    if(mode){
      mode.className = 'status-pill ' + (configured ? 'live' : 'offline');
      mode.innerHTML = '<span class="dot"></span>' + esc(configured ? modeLabel : 'Not set up yet');
    }
  }

  function realProfileName(value){
    var name = String(value || '').trim();
    return name && !name.includes('@') && name.toLowerCase() !== 'local user' ? name : '';
  }

  function currentRealProfileName(){
    var profile = userProfiles[String(currentUser || '').toLowerCase()];
    return realProfileName(profile && profile.displayName);
  }

  function renderHarnessConnectionInventory(connections, runtimes){
    var wrap = el('#settingsHarnessConnections');
    var connected = [];
    if(connections && connections['openai-codex'] === true) connected.push({label:'ChatGPT subscription'});
    if(connections && connections['xai-oauth'] === true) connected.push({label:'Grok subscription'});
    harnessApiProviderCatalog.forEach(function(provider){
      if(connections && connections[provider.id] === true){
        connected.push({label:provider.label + ' API key'});
      }
    });
    if(wrap){
      if(!connected.length){
        wrap.innerHTML = '<div class="styled-settings-row"><div><div class="styled-settings-row-label">No connected providers</div><div class="styled-settings-row-desc">Connect a subscription or API provider from setup.</div></div></div>';
      } else {
        wrap.innerHTML = connected.map(function(item){
          return '<div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">' + esc(item.label) + '</div></div><span class="status-pill live"><span class="dot"></span>Connected</span></div>';
        }).join('');
      }
    }
    var runtimesWrap = el('#settingsHarnessRuntimes');
    if(!runtimesWrap || !runtimes) return;
    var hermesConnected = runtimes.hermesAgent === true;
    runtimesWrap.innerHTML = '<div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">Hermes Agent</div></div><span class="status-pill ' + (hermesConnected ? 'live' : 'offline') + '"><span class="dot"></span>' + (hermesConnected ? 'Connected' : 'Not connected') + '</span></div>' +
      '<div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">Grok Build</div></div><span class="status-pill coming-soon">Upcoming</span></div>' +
      '<div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">ChatGPT Codex</div></div><span class="status-pill coming-soon">Upcoming</span></div>';
  }

  // Hoisted so both the boot-time /api/settings load and the drawer's change
  // handler (defined much later in this module) share one renderer.
  function renderOutputSetting(mode){
    var select = el('#settingsOutputMode');
    var note = el('#settingsOutputNote');
    var verbose = mode === 'verbose';
    if(select) select.value = verbose ? 'verbose' : 'concise';
    if(note) note.textContent = verbose
      ? 'Detailed activity is selected — replies include additional execution progress.'
      : 'Concise is selected — replies show only the final answer.';
  }

  function renderInstructionSettings(value){
    var instructions = value && typeof value === 'object' ? value : {};
    var agent = el('#settingsAgentInstructions');
    var bot = el('#settingsBotInstructions');
    if(agent) agent.value = String(instructions.agent || '');
    if(bot) bot.value = String(instructions.bot || '');
  }

  function loadHarnessSettings(showFirstRun){
    return api('/api/settings').then(function(res){
      var harness = res.data && res.data.harness;
      renderHarnessSettings(harness);
      renderOutputSetting(res.data && res.data.chatOutput === 'verbose' ? 'verbose' : 'concise');
      renderInstructionSettings(res.data && res.data.instructions);
      syncHiddenStarterBotsFromServer(res.data && res.data.hiddenStarterBots);
      if(harness && harness.onboardingComplete){
        appCollaborationMode = (WORKSPACE_OPTIONS[activeWorkspaceKey] || WORKSPACE_OPTIONS['multiplayer_test']).mode;
        refreshAppName();
      }
      if(showFirstRun && (!harness || !harness.onboardingComplete)){
        setTimeout(function(){ openHarnessOnboarding(harness); }, 450);
      }
      return harnessSettingsCache;
    }).catch(function(){
      renderHarnessSettings(null);
      return harnessSettingsCache;
    });
  }

  function loadHarnessProviderCatalog(){
    return api('/api/settings/harness/providers').then(function(res){
      var providers = res.data && res.data.providers;
      if(Array.isArray(providers)) setHarnessApiProviderCatalog(providers);
      return harnessApiProviderCatalog;
    }).catch(function(){
      populateHarnessApiProviderOptions();
      return harnessApiProviderCatalog;
    });
  }

  function loadHarnessModelCatalog(){
    return api('/api/settings/harness/models').then(function(res){
      var providers = res.data && res.data.providers;
      if(providers) setHarnessModelCatalog(providers);
      return harnessModelCatalog;
    }).catch(function(){
      renderHarnessModelOptions();
      return harnessModelCatalog;
    });
  }

  function loadSettings(){
    api('/api/settings').then(function(res){
      var s = res.data || {};
      renderHarnessSettings(s.harness);
      renderInstructionSettings(s.instructions);
      var g = s.guardrails || {};
      el('#grAllowedProviders').checked = !!(g.allowedProviders && g.allowedProviders.indexOf('openai') !== -1);
      el('#settingsLastBackup').textContent = s.lastBackup ? new Date(s.lastBackup).toLocaleString() : 'never';
    }).catch(function(){});
    loadProfileSettings();
  }

  function loadProfileSettings(){
    var nameInput = el('#settingsDisplayName'), initialsInput = el('#settingsInitials');
    if(!nameInput || !initialsInput) return;
    el('#settingsProfileSaved').classList.remove('visible');
    api('/api/me').then(function(res){
      if(res.status !== 200 || !res.data) return;
      currentUserLocalProfile = res.data.localProfile === true;
      mergeUserProfile(res.data.email, res.data);
      nameInput.value = res.data.displayName || '';
      initialsInput.value = res.data.initials || '';
      renderSettingsAccount();
    }).catch(function(){});
  }

  el('#settingsProfileSave').addEventListener('click', function(){
    var nameInput = el('#settingsDisplayName'), initialsInput = el('#settingsInitials');
    var body = {displayName: nameInput.value.trim(), initials: initialsInput.value.trim()};
    api('/api/me', {method: 'PUT', body: body}).then(function(res){
      var saved = el('#settingsProfileSaved');
      if(res.status !== 200 || !res.data){
        saved.textContent = res.data && res.data.error ? res.data.error : 'Could not save';
        saved.classList.add('visible');
        return;
      }
      currentUserLocalProfile = res.data.localProfile === true;
      mergeUserProfile(res.data.email, {displayName: res.data.displayName, initials: res.data.initials});
      nameInput.value = res.data.displayName || '';
      initialsInput.value = res.data.initials || '';
      el('#avatarBtn').innerHTML = humanAvatarInitialsHtml(currentUser);
      var chatAcctAvatar = el('#chatAcctAvatar');
      var chatAcctName = el('#chatAcctName');
      if(chatAcctAvatar) chatAcctAvatar.innerHTML = humanAvatarInitialsHtml(currentUser);
      if(chatAcctName) chatAcctName.textContent = displayNameForEmail(currentUser);
      renderChatHeaderBar();
      renderChatThread();
      renderSettingsAccount();
      saved.textContent = 'Saved';
      saved.classList.add('visible');
      setTimeout(function(){ saved.classList.remove('visible'); }, 2500);
    }).catch(function(){
      var saved = el('#settingsProfileSaved');
      saved.textContent = 'Could not save';
      saved.classList.add('visible');
    });
  });

  // Settings is a window-level sheet (left nav + panes). Panes are switched
  // client-side only; every field keeps its id so the save handlers below
  // are untouched by the layout.
  function showSettingsPane(name){
    els('#settingsNav .styled-settings-nav-item').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-pane') === name);
    });
    els('#settingsContent .styled-settings-pane').forEach(function(p){
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
    var content = el('#settingsContent');
    if(content) content.scrollTop = 0;
  }
  function renderSettingsAccount(){
    var avatar = el('#settingsAcctAvatar'), name = el('#settingsAcctName'), email = el('#settingsAcctEmail');
    if(!avatar || !currentUser) return;
    avatar.innerHTML = humanAvatarContent(currentUser);
    name.textContent = displayNameForEmail(currentUser);
    email.textContent = currentUserLocalProfile ? 'Local profile · no email required' : (currentAccountEmail || currentUser);
  }
  // Only the Electron shell can register a protocol handler — degrade
  // honestly on the web build (and any older shell without the bridge) by
  // keeping the row hidden instead of offering a control that can't work.
  function renderSettingsDefaultBrowserState(state){
    var row = el('#settingsDefaultBrowserRow');
    var note = el('#settingsDefaultBrowserNote');
    var btn = el('#settingsDefaultBrowserBtn');
    if(!row) return;
    if(!window.miaDesktop || !window.miaDesktop.defaultBrowser){ row.hidden = true; return; }
    row.hidden = false;
    var isDefault = !!(state && state.http && state.https);
    if(note) note.textContent = isDefault
      ? 'Mia is your default browser for http and https links.'
      : 'Open http and https links in Mia.';
    if(btn) btn.textContent = isDefault ? 'Mia is your default browser' : 'Make Mia your default browser';
    if(btn) btn.disabled = isDefault;
  }
  function loadSettingsDefaultBrowserState(){
    var row = el('#settingsDefaultBrowserRow');
    if(!row) return;
    if(!window.miaDesktop || !window.miaDesktop.defaultBrowser){ row.hidden = true; return; }
    Promise.resolve(window.miaDesktop.defaultBrowser.get()).then(renderSettingsDefaultBrowserState).catch(function(){ row.hidden = true; });
  }
  function openSettingsDrawer(pane){
    // Same constraint as openHarnessOnboarding: the native browser view
    // covers HTML overlays, so close its panel before showing the sheet.
    closeLocalBrowser();
    el('#settingsOverlay').classList.add('open');
    el('#settingsDrawer').classList.add('open');
    showSettingsPane(pane || 'general');
    renderSettingsAccount();
    loadSettings();
    loadHarnessConnectionStatus();
    loadSettingsDefaultBrowserState();
  }
  function closeSettingsDrawer(){
    el('#settingsOverlay').classList.remove('open');
    el('#settingsDrawer').classList.remove('open');
  }

  function stopHarnessAuthPolling(){
    harnessAuthGeneration += 1;
    if(harnessAuthPollTimer){
      clearTimeout(harnessAuthPollTimer);
      harnessAuthPollTimer = null;
    }
  }

  function harnessAuthFlowIsCurrent(generation, provider){
    return generation === harnessAuthGeneration && provider === harnessOnboardingState.provider;
  }

  function cancelHarnessAuthFlow(provider){
    var activeProvider = provider || harnessOnboardingState.provider;
    stopHarnessAuthPolling();
    harnessAuthAwaitingSave = false;
    harnessConnectionPending = null;
    if(activeProvider !== 'claude-subscription-directsdk-experimental'){
      renderHarnessAuth(null);
      return Promise.resolve();
    }
    return api('/api/settings/harness/auth/cancel', {method:'POST', body:{provider:activeProvider}}).then(function(){
      renderHarnessAuth(null);
      renderHarnessConnectionActions();
      renderHarnessOnboarding();
    }).catch(function(){
      var error = el('#harnessOnboardingError');
      if(error) error.textContent = 'Could not cancel sign-in. Try again.';
    });
  }

  function renderHarnessAuth(value){
    var panel = el('#harnessAuthPanel');
    var status = el('#harnessAuthStatus');
    var link = el('#harnessAuthLink');
    var title = el('#harnessAuthTitle');
    var codeWrap = el('#harnessAuthCodeWrap');
    var code = el('#harnessAuthCode');
    var completion = el('#harnessAuthCompletion');
    var completionInput = el('#harnessAuthCompletionCode');
    var completionSubmit = el('#harnessAuthCompletionSubmit');
    var cancel = el('#harnessAuthCancel');
    if(!panel) return;
    var auth = value && typeof value === 'object' ? value : {};
    if(auth.state === 'connected' && auth.provider){
      harnessConnectionState[auth.provider] = true;
      harnessConnectionPending = null;
      renderHarnessConnectionActions();
    }
    var authName = HERMES_AUTH_NAMES[harnessOnboardingState.provider] || 'provider';
    var active = auth.state && auth.state !== 'idle' &&
      ['claude-subscription-directsdk-experimental', 'openai-codex', 'xai-oauth'].indexOf(harnessOnboardingState.provider) !== -1 &&
      (!auth.provider || auth.provider === harnessOnboardingState.provider);
    panel.hidden = !active;
    if(!active){
      if(completion) completion.hidden = true;
      if(completionInput){ completionInput.value = ''; completionInput.disabled = false; }
      if(cancel) cancel.hidden = true;
      return;
    }
    if(title) title.textContent = 'Connect ' + authName;
    if(status){
      status.textContent = auth.state === 'starting'
        ? 'Preparing sign-in…'
        : (auth.state === 'waiting'
          ? (auth.provider === 'claude-subscription-directsdk-experimental'
            ? 'Finish in the sign-in window. Mia will connect automatically.'
            : 'Finish in the sign-in window and enter the code shown below.')
          : (auth.state === 'completing'
            ? 'Verifying sign-in…'
            : (auth.state === 'connected'
              ? authName + ' is connected.'
              : (auth.error || 'Sign-in could not be completed.'))));
    }
    if(link){
      link.hidden = !auth.verificationUrl;
      link.textContent = 'Open ' + authName + ' sign-in';
      if(auth.verificationUrl) link.href = '/api/settings/harness/auth/redirect?provider=' + encodeURIComponent(auth.provider || harnessOnboardingState.provider);
    }
    if(codeWrap){
      codeWrap.hidden = !auth.userCode;
      if(code) code.textContent = auth.userCode || '';
    }
    var claudeWaiting = auth.provider === 'claude-subscription-directsdk-experimental' && ['waiting', 'completing'].indexOf(auth.state) !== -1;
    if(completion) completion.hidden = !claudeWaiting;
    if(completionInput){
      completionInput.disabled = auth.state === 'completing';
      if(!claudeWaiting) completionInput.value = '';
    }
    if(completionSubmit) completionSubmit.disabled = auth.state === 'completing';
    if(cancel) cancel.hidden = auth.provider !== 'claude-subscription-directsdk-experimental' || ['starting', 'waiting', 'completing'].indexOf(auth.state) === -1;
  }

  function pollHarnessAuth(){
    stopHarnessAuthPolling();
    var generation = harnessAuthGeneration;
    var provider = harnessOnboardingState.provider;
    var poll = function(){
      api('/api/settings/harness/auth').then(function(res){
        if(!harnessAuthFlowIsCurrent(generation, provider)) return;
        var auth = res.data && res.data.auth;
        renderHarnessAuth(auth);
        if(auth && auth.state === 'connected'){
          stopHarnessAuthPolling();
          if(harnessAuthAwaitingSave) saveHarnessSelection();
          return;
        }
        if(auth && auth.state === 'error'){
          stopHarnessAuthPolling();
          return;
        }
        harnessAuthPollTimer = setTimeout(poll, 1500);
      }).catch(function(err){
        if(!harnessAuthFlowIsCurrent(generation, provider)) return;
        var error = el('#harnessOnboardingError');
        if(error && err && err.message) error.textContent = err.message;
        harnessAuthPollTimer = setTimeout(poll, 2500);
      });
    };
    poll();
  }

  function loadHarnessAuthState(){
    var generation = harnessAuthGeneration;
    var provider = harnessOnboardingState.provider;
    api('/api/settings/harness/auth').then(function(res){
      if(!harnessAuthFlowIsCurrent(generation, provider)) return;
      var auth = res.data && res.data.auth;
      renderHarnessAuth(auth);
      if(auth && ['starting', 'waiting', 'completing'].indexOf(auth.state) !== -1) pollHarnessAuth();
    }).catch(function(){});
  }

  function harnessActionProvider(button){
    var requestedProvider = button.getAttribute('data-harness-disconnect');
    return requestedProvider === 'api' ? (harnessOnboardingState.apiProvider || 'openai-api') : requestedProvider;
  }

  function selectedHarnessProvider(){
    if(harnessOnboardingState.provider === 'managed-router') return 'openrouter';
    return harnessOnboardingState.provider === 'openai-api'
      ? (harnessOnboardingState.apiProvider || 'openai-api')
      : harnessOnboardingState.provider;
  }

  function setHarnessActionLabel(button, value){
    if(!button) return;
    var label = button.querySelector('.styled-onboarding-connection-label');
    if(label) label.textContent = value;
    else button.textContent = value;
  }

  function renderHarnessConnectionActions(){
    els('[data-harness-disconnect]').forEach(function(button){
      var provider = harnessActionProvider(button);
      var connected = harnessConnectionState[provider] === true;
      var pending = harnessConnectionPending === provider;
      var icon = button.querySelector('.styled-onboarding-connection-icon');
      var label = button.querySelector('.styled-onboarding-connection-label');
      if(icon) icon.textContent = pending ? '…' : (connected ? '×' : '↗');
      if(label) label.textContent = pending ? 'Connecting…' : (connected ? 'Disconnect' : 'Connect');
      button.dataset.connected = connected ? 'true' : 'false';
      button.disabled = pending;
      button.setAttribute('aria-label', (connected ? 'Disconnect ' : 'Connect ') + (HERMES_AUTH_NAMES[provider] || HERMES_PROVIDER_LABELS[provider] || 'provider'));
    });
  }

  function renderHarnessFooterActions(){
    var provider = selectedHarnessProvider();
    var connected = harnessConnectionState[provider] === true;
    var pending = !!harnessConnectionPending || harnessAuthSaveInProgress;
    var disconnect = el('#harnessOnboardingDisconnect');
    if(disconnect){
      var icon = disconnect.querySelector('.styled-onboarding-connection-icon');
      if(icon) icon.textContent = '×';
      setHarnessActionLabel(disconnect, 'Disconnect');
      disconnect.disabled = !connected || pending;
      disconnect.setAttribute('aria-label', 'Disconnect ' + harnessProviderDisplayName(provider));
    }
  }

  function disconnectHarnessProvider(provider, button){
    if(harnessConnectionState[provider] !== true) return;
    var authName = harnessProviderDisplayName(provider);
    var disconnectPrompt = provider === 'claude-subscription-directsdk-experimental'
      ? 'Disconnect ' + authName + ' from Mia? Your Claude Code login remains unchanged. Existing scheduled jobs may continue until you pause them in Automations.'
      : 'Disconnect ' + authName + '? This forgets its stored credentials.';
    if(!window.confirm(disconnectPrompt)) return;
    var icon = button && button.querySelector('.styled-onboarding-connection-icon');
    var label = button && button.querySelector('.styled-onboarding-connection-label');
    if(button) button.disabled = true;
    if(icon) icon.textContent = '…';
    if(label) label.textContent = 'Disconnecting…';
    api('/api/settings/harness/auth/logout', {method:'POST', body:{provider:provider}}).then(function(res){
      if(res.status !== 200 || !res.data || !res.data.ok) throw new Error((res.data && res.data.error) || 'Could not disconnect provider');
      harnessConnectionState[provider] = false;
      harnessConnectionPending = null;
      if(provider === selectedHarnessProvider()){
        stopHarnessAuthPolling();
        harnessAuthAwaitingSave = false;
        renderHarnessAuth(null);
      }
      if(chatModelPicker && typeof chatModelPicker.resetAndReload === 'function') chatModelPicker.resetAndReload();
      renderHarnessOnboarding();
    }).catch(function(err){
      var error = el('#harnessOnboardingError');
      if(error) error.textContent = err.message || 'Could not disconnect provider';
      renderHarnessOnboarding();
    });
  }

  var managedRouterAvailable = false;
  function loadHarnessConnectionStatus(){
    harnessConnectionValidationPending = true;
    renderHarnessOnboarding();
    Promise.all([
      api('/api/settings/harness/auth/status'),
      api('/api/settings/managed-router/status')
    ]).then(function(results){
      var res = results[0];
      var routerRes = results[1];
      var connections = res.data && res.data.connections;
      var runtimes = res.data && res.data.runtimes;
      if(connections && typeof connections === 'object'){
        Object.keys(harnessConnectionState).forEach(function(provider){
          harnessConnectionState[provider] = connections[provider] === true;
        });
      }
      managedRouterAvailable = !!(routerRes.data && routerRes.data.available);
      if(routerRes.data && routerRes.data.provisioned) harnessConnectionState['openrouter'] = true;
      var managedRouterCard = el('[data-harness-provider="managed-router"]');
      if(managedRouterCard) managedRouterCard.closest('.styled-onboarding-provider-row').hidden = !managedRouterAvailable;
      // The card's display name is deployment branding served by the backend.
      var routerLabel = routerRes.data && routerRes.data.label;
      if(routerLabel){
        var labelEl = el('[data-managed-router-label]');
        if(labelEl) labelEl.textContent = routerLabel;
        harnessApiProviderCatalog.forEach(function(entry){
          if(entry.id === 'managed-router') entry.label = routerLabel;
        });
      }
      harnessConnectionValidationPending = false;
      renderHarnessConnectionInventory(connections, runtimes);
      renderHarnessConnectionActions();
      renderHarnessOnboarding();
    }).catch(function(){
      harnessConnectionValidationPending = false;
      Object.keys(harnessConnectionState).forEach(function(provider){ harnessConnectionState[provider] = false; });
      var inventory = el('#settingsHarnessConnections');
      if(inventory) inventory.innerHTML = '<div class="styled-settings-row"><div><div class="styled-settings-row-label">Provider status unavailable</div><div class="styled-settings-row-desc">Try opening Access again.</div></div></div>';
      var runtimes = el('#settingsHarnessRuntimes');
      if(runtimes) runtimes.innerHTML = '<div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">Hermes Agent</div></div><span class="status-pill offline"><span class="dot"></span>Unavailable</span></div><div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">Grok Build</div></div><span class="status-pill coming-soon">Upcoming</span></div><div class="styled-settings-row styled-harness-connection-row"><div><div class="styled-settings-row-label">ChatGPT Codex</div></div><span class="status-pill coming-soon">Upcoming</span></div>';
      renderHarnessConnectionActions();
      renderHarnessOnboarding();
    });
  }

  function renderHarnessOnboarding(){
    var continueBtn = el('#harnessOnboardingContinue');
    var apiKey = el('#harnessApiKey');
    var isManagedRouter = harnessOnboardingState.provider === 'managed-router';
    var selectedApiProvider = harnessOnboardingState.apiProvider || 'openai-api';
    var selectedProvider = harnessOnboardingState.provider === 'openai-api'
      ? selectedApiProvider
      : harnessOnboardingState.provider;
    var selectedProviderConnected = harnessConnectionState[selectedProvider] === true || (isManagedRouter && harnessConnectionState['openrouter'] === true);
    var apiReady = isManagedRouter || harnessOnboardingState.provider !== 'openai-api' || !!(apiKey && apiKey.value.trim()) || harnessConnectionState[selectedApiProvider] === true;
    var busy = harnessConnectionValidationPending || !!harnessConnectionPending || harnessAuthSaveInProgress || harnessAuthAwaitingSave;
    if(continueBtn){
      continueBtn.disabled = busy || !harnessOnboardingState.provider || !harnessOnboardingState.mode || !apiReady;
      setHarnessActionLabel(continueBtn, busy ? 'Loading…' : (selectedProviderConnected ? 'Start with Mia' : 'Connect'));
    }
    els('[data-harness-provider]').forEach(function(choice){
      var choiceProvider = choice.getAttribute('data-harness-provider');
      var selected = choiceProvider === harnessOnboardingState.provider ||
        (choiceProvider === 'openai-api' && harnessOnboardingState.provider === 'xai');
      choice.classList.toggle('selected', selected);
      choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    els('[data-harness-mode]').forEach(function(choice){
      var selected = choice.getAttribute('data-harness-mode') === harnessOnboardingState.mode;
      choice.classList.toggle('selected', selected);
      choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    var sharedBots = el('#harnessSharedBotsSection');
    if(sharedBots) sharedBots.hidden = harnessOnboardingState.mode !== 'multiplayer';
    var apiSection = el('#harnessApiConnectionSection');
    if(apiSection) apiSection.hidden = isManagedRouter || harnessOnboardingState.provider !== 'openai-api';
    var apiCard = el('#harnessApiCard');
    if(apiCard) apiCard.classList.toggle('is-expanded', !isManagedRouter && harnessOnboardingState.provider === 'openai-api');
    var apiCredentialNote = el('#harnessApiCredentialNote');
    if(apiCredentialNote) apiCredentialNote.hidden = isManagedRouter || harnessOnboardingState.provider !== 'openai-api';
    var apiProvider = el('#harnessApiProvider');
    populateHarnessApiProviderOptions();
    if(apiProvider) apiProvider.value = harnessOnboardingState.apiProvider || 'openai-api';
    if(apiKey){
      // A stored key never leaves Hermes, so the field cannot show it; a masked
      // placeholder tells the user this provider is already registered and
      // that pasting a new key replaces it.
      var apiKeyStored = harnessOnboardingState.provider === 'openai-api' && harnessConnectionState[selectedApiProvider] === true;
      apiKey.placeholder = apiKeyStored ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 saved \u00b7 paste a new key to replace' : 'Paste your API key';
      apiKey.classList.toggle('has-stored-key', apiKeyStored);
    }
    var title = el('#harnessOnboardingTitle');
    if(title) title.textContent = 'Connect your AI';
    renderHarnessConnectionActions();
    renderHarnessFooterActions();
  }

  function openHarnessOnboarding(existing){
    // Electron's native browser view is above HTML overlays; the sheet would
    // otherwise be hidden behind it. Saved tabs and sessions remain.
    closeLocalBrowser();
    var onboardingOverlay = el('#harnessOnboardingOverlay');
    var onboardingSheet = el('#harnessOnboarding');
    if(onboardingOverlay) onboardingOverlay.classList.add('open');
    if(onboardingSheet) onboardingSheet.classList.add('open');
    var hasSavedMode = existing && typeof existing.mode === 'string';
    existing = normalizeHarnessSettings(existing || harnessSettingsCache);
    harnessOnboardingState.provider = (existing.provider === 'openai-api' && existing.apiProvider === 'openrouter') ? 'managed-router' : (existing.provider || null);
    var modelSelection = normalizeHarnessModel(harnessOnboardingState.provider, existing.model, existing.fast);
    harnessOnboardingState.model = modelSelection.model;
    harnessOnboardingState.fast = modelSelection.fast;
    harnessOnboardingState.apiProvider = existing.apiProvider || 'openai-api';
    harnessOnboardingState.mode = hasSavedMode ? existing.mode : (appCollaborationMode || 'solo');
    // Multiplayer is upcoming: the card is disabled, so never restore it as the selection.
    if(harnessOnboardingState.mode === 'multiplayer') harnessOnboardingState.mode = 'solo';
    harnessAuthAwaitingSave = false;
    harnessConnectionPending = null;
    harnessConnectionValidationPending = true;
    stopHarnessAuthPolling();
    var error = el('#harnessOnboardingError');
    if(error) error.textContent = '';
    var continueBtn = el('#harnessOnboardingContinue');
    if(continueBtn){ continueBtn.disabled = true; setHarnessActionLabel(continueBtn, 'Loading…'); }
    // Make the sheet visible even if a stale provider payload or a browser
    // extension interrupts one of the optional status renderers. The static
    // two-provider markup remains usable while the catalog refreshes.
    try { renderHarnessOnboarding(); } catch(_) { /* keep the sheet open */ }
    renderHarnessAuth(null);
    loadHarnessAuthState();
    loadHarnessConnectionStatus();
    loadHarnessModelCatalog();
  }

  function closeHarnessOnboarding(){
    if(!harnessSettingsCache.onboardingComplete){
      var setupError = el('#harnessOnboardingError');
      if(setupError) setupError.textContent = 'Connect your AI to continue.';
      var providerChoices = el('#harnessProviderChoices');
      if(providerChoices && typeof providerChoices.scrollIntoView === 'function') providerChoices.scrollIntoView({block:'nearest'});
      return false;
    }
    if(harnessAuthAwaitingSave && harnessOnboardingState.provider === 'claude-subscription-directsdk-experimental') {
      void cancelHarnessAuthFlow(harnessOnboardingState.provider);
    }
    harnessAuthAwaitingSave = false;
    stopHarnessAuthPolling();
    var apiKey = el('#harnessApiKey');
    if(apiKey) apiKey.value = '';
    el('#harnessOnboardingOverlay').classList.remove('open');
    el('#harnessOnboarding').classList.remove('open');
    return true;
  }

  els('[data-harness-provider]').forEach(function(choice){
    choice.addEventListener('click', function(){
      if(harnessAuthAwaitingSave && harnessOnboardingState.provider === 'claude-subscription-directsdk-experimental') {
        void cancelHarnessAuthFlow(harnessOnboardingState.provider);
      }
      stopHarnessAuthPolling();
      harnessAuthAwaitingSave = false;
      harnessConnectionPending = null;
      renderHarnessAuth(null);
      harnessOnboardingState.provider = choice.getAttribute('data-harness-provider');
      var modelSelection = normalizeHarnessModel(harnessOnboardingState.provider, null, false);
      harnessOnboardingState.model = modelSelection.model;
      harnessOnboardingState.fast = modelSelection.fast;
      renderHarnessOnboarding();
    });
  });
  var harnessApiProviderSelect = el('#harnessApiProvider');
  if(harnessApiProviderSelect) harnessApiProviderSelect.addEventListener('change', function(){
    harnessOnboardingState.apiProvider = normalizeHarnessApiProvider(harnessApiProviderSelect.value);
    renderHarnessOnboarding();
  });
  var harnessApiKey = el('#harnessApiKey');
  if(harnessApiKey) harnessApiKey.addEventListener('input', renderHarnessOnboarding);
  els('[data-harness-disconnect]').forEach(function(button){
    button.addEventListener('click', function(event){
      event.preventDefault();
      event.stopPropagation();
      var requestedProvider = button.getAttribute('data-harness-disconnect');
      var provider = harnessActionProvider(button);
      var connected = harnessConnectionState[provider] === true;
      if(!connected){
        harnessOnboardingState.provider = requestedProvider === 'api' ? 'openai-api' : requestedProvider;
        renderHarnessOnboarding();
        if(requestedProvider === 'api'){
          var apiKeyInput = el('#harnessApiKey');
          if(!apiKeyInput || !apiKeyInput.value.trim()){
            if(apiKeyInput) apiKeyInput.focus();
            return;
          }
        }
        harnessConnectionPending = provider;
        renderHarnessConnectionActions();
        el('#harnessOnboardingContinue').click();
        return;
      }
      disconnectHarnessProvider(provider, button);
    });
  });
  var harnessOnboardingDisconnect = el('#harnessOnboardingDisconnect');
  if(harnessOnboardingDisconnect) harnessOnboardingDisconnect.addEventListener('click', function(event){
    event.preventDefault();
    event.stopPropagation();
    disconnectHarnessProvider(selectedHarnessProvider(), harnessOnboardingDisconnect);
  });
  els('[data-harness-mode]').forEach(function(choice){
    choice.addEventListener('click', function(){
      if(choice.disabled || choice.classList.contains('is-upcoming')) return;
      harnessOnboardingState.mode = choice.getAttribute('data-harness-mode');
      renderHarnessOnboarding();
    });
  });
  (function(){
    var info = el('#harnessSharedBotsInfo');
    var tooltip = el('#harnessSharedBotsTooltip');
    if(!info || !tooltip) return;
    info.addEventListener('click', function(event){
      event.stopPropagation();
      var open = info.getAttribute('aria-expanded') !== 'true';
      info.setAttribute('aria-expanded', open ? 'true' : 'false');
      tooltip.classList.toggle('is-open', open);
    });
    document.addEventListener('click', function(event){
      if(!event.target.closest('.styled-onboarding-info-wrap')){
        info.setAttribute('aria-expanded', 'false');
        tooltip.classList.remove('is-open');
      }
    });
  })();
  function saveHarnessSelection(){
    if(harnessAuthSaveInProgress) return;
    var button = el('#harnessOnboardingContinue');
    var error = el('#harnessOnboardingError');
    harnessAuthSaveInProgress = true;
    button.disabled = true;
    setHarnessActionLabel(button, 'Loading…');
    if(error) error.textContent = '';
    api('/api/settings/harness', {method:'POST', body:{
      provider:harnessOnboardingState.provider,
      model:harnessOnboardingState.model,
      fast:harnessOnboardingState.fast,
      apiProvider:harnessOnboardingState.apiProvider,
      mode:harnessOnboardingState.mode
      }}).then(function(res){
      if(res.status !== 200 || !res.data || !res.data.harness) throw new Error((res.data && res.data.error) || 'Could not save setup');
      renderHarnessSettings(res.data.harness);
      // The onboarding mode is the authoritative initial workspace. Reload
      // after persisting it so conversations, headers, sockets, and cached
      // active-room state are all requested in the same scope.
      activateWorkspace(res.data.harness.mode === 'multiplayer' ? 'multiplayer_test' : 'solo');
      localStorage.removeItem('miaosHarnessOnboardingDismissed');
      harnessAuthAwaitingSave = false;
      harnessAuthSaveInProgress = false;
      renderHarnessAuth(null);
      closeHarnessOnboarding();
      setAppLoading(true);
      location.reload();
    }).catch(function(err){
      harnessAuthSaveInProgress = false;
      harnessAuthAwaitingSave = false;
      if(error) error.textContent = err.message || 'Could not save setup';
      renderHarnessOnboarding();
    });
  }
  el('#harnessOnboardingContinue').addEventListener('click', function(){
    var button = el('#harnessOnboardingContinue');
    var error = el('#harnessOnboardingError');
    var authProvider = harnessOnboardingState.provider;
    button.disabled = true;
    setHarnessActionLabel(button, 'Loading…');
    if(error) error.textContent = '';
    if(authProvider === 'openai-api'){
      var apiKeyInput = el('#harnessApiKey');
      var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
      // The visible dropdown is authoritative at submit time. State can be
      // reset to 'openai-api' by settings hydration racing the user's pick,
      // which silently filed DeepSeek keys under OpenAI.
      var apiProviderSelect = el('#harnessApiProvider');
      var apiProvider = normalizeHarnessApiProvider(
        (apiProviderSelect && apiProviderSelect.value) || harnessOnboardingState.apiProvider || 'openai-api');
      harnessOnboardingState.apiProvider = apiProvider;
      if(!apiKey && harnessConnectionState[apiProvider] === true){
        saveHarnessSelection();
        return;
      }
      if(!apiKey){
        if(error) error.textContent = 'Paste an API key to connect.';
        button.disabled = false;
        renderHarnessOnboarding();
        return;
      }
      harnessConnectionPending = apiProvider;
      renderHarnessOnboarding();
      api('/api/settings/harness/api-key', {method:'POST', body:{provider:apiProvider, apiKey:apiKey}}).then(function(res){
        if(res.status !== 200 || !res.data || !res.data.ok) throw new Error((res.data && res.data.error) || 'Could not add API credential');
        if(apiKeyInput) apiKeyInput.value = '';
        harnessConnectionState[apiProvider] = true;
        harnessConnectionPending = null;
        renderHarnessConnectionActions();
        saveHarnessSelection();
      }).catch(function(err){
        if(apiKeyInput) apiKeyInput.value = '';
        harnessAuthAwaitingSave = false;
        harnessConnectionPending = null;
        if(error) error.textContent = err.message || 'Could not add API credential';
        button.disabled = false;
        renderHarnessOnboarding();
      });
      return;
    }
    if(['claude-subscription-directsdk-experimental', 'openai-codex', 'xai-oauth'].indexOf(authProvider) === -1){
      saveHarnessSelection();
      return;
    }
    if(harnessConnectionState[authProvider] === true && !harnessAuthAwaitingSave){
      saveHarnessSelection();
      return;
    }
    harnessAuthAwaitingSave = true;
    harnessConnectionPending = authProvider;
    renderHarnessConnectionActions();
    // Open a same-origin redirect from the user gesture. That route starts
    // the background harness flow and redirects this tab to the real provider
    // URL, avoiding popup blocking in the later polling callback.
    var redirectUrl = '/api/settings/harness/auth/redirect?provider=' + encodeURIComponent(authProvider);
    if(authProvider === 'claude-subscription-directsdk-experimental') redirectUrl += '&reauthenticate=true';
    try { window.open(redirectUrl, '_blank', 'noopener,noreferrer'); } catch(_) { /* visible link remains available */ }
    var authRequestGeneration = harnessAuthGeneration;
    api('/api/settings/harness/auth/start', {method:'POST', body:{provider:authProvider, reauthenticate:authProvider === 'claude-subscription-directsdk-experimental'}}).then(function(res){
      if(!harnessAuthFlowIsCurrent(authRequestGeneration, authProvider)) return;
      var auth = res.data && res.data.auth;
      if(res.status !== 200 || !auth) throw new Error((res.data && res.data.error) || 'Could not start harness sign-in');
      renderHarnessAuth(auth);
      if(auth.state === 'connected'){
        harnessConnectionState[authProvider] = true;
        harnessConnectionPending = null;
        renderHarnessConnectionActions();
        stopHarnessAuthPolling();
        saveHarnessSelection();
        return;
      }
      if(auth.state === 'error') throw new Error(auth.error || 'Could not start harness sign-in');
      setHarnessActionLabel(button, 'Loading…');
      pollHarnessAuth();
    }).catch(function(err){
      if(!harnessAuthFlowIsCurrent(authRequestGeneration, authProvider)) return;
      harnessAuthAwaitingSave = false;
      harnessConnectionPending = null;
      if(error) error.textContent = err.message || 'Could not start harness sign-in';
      renderHarnessConnectionActions();
      renderHarnessOnboarding();
    });
  });
  el('#harnessAuthCompletion').addEventListener('submit', function(event){
    event.preventDefault();
    var input = el('#harnessAuthCompletionCode');
    var error = el('#harnessOnboardingError');
    var code = input ? input.value.trim() : '';
    if(!code){ if(input) input.focus(); return; }
    if(input) input.disabled = true;
    if(error) error.textContent = '';
    var completionGeneration = harnessAuthGeneration;
    var completionProvider = harnessOnboardingState.provider;
    api('/api/settings/harness/auth/complete', {method:'POST', body:{
      provider:'claude-subscription-directsdk-experimental', code:code
    }}).then(function(res){
      if(!harnessAuthFlowIsCurrent(completionGeneration, completionProvider)) return;
      if(input) input.value = '';
      if(res.status !== 202) throw new Error((res.data && res.data.error) || 'Could not submit Claude sign-in');
      renderHarnessAuth(res.data && res.data.auth);
      pollHarnessAuth();
    }).catch(function(err){
      if(!harnessAuthFlowIsCurrent(completionGeneration, completionProvider)) return;
      if(input) input.disabled = false;
      if(error) error.textContent = err.message || 'Could not submit Claude sign-in';
    });
  });
  el('#harnessAuthCancel').addEventListener('click', function(){
    void cancelHarnessAuthFlow(harnessOnboardingState.provider);
  });
  el('#harnessOnboardingClose').addEventListener('click', function(){
    closeHarnessOnboarding();
  });
  el('#harnessOnboardingOverlay').addEventListener('click', function(){
    closeHarnessOnboarding();
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && el('#harnessOnboarding').classList.contains('open')){
      closeHarnessOnboarding();
    }
  });
  el('#settingsOverlay').addEventListener('click', closeSettingsDrawer);
  el('#settingsClose').addEventListener('click', closeSettingsDrawer);
  els('#settingsNav .styled-settings-nav-item').forEach(function(b){
    b.addEventListener('click', function(){ showSettingsPane(b.getAttribute('data-pane')); });
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && el('#settingsDrawer').classList.contains('open')) closeSettingsDrawer();
  });
  var settingsSignOut = el('#settingsSignOut');
  if(settingsSignOut) settingsSignOut.addEventListener('click', function(){
    closeSettingsDrawer();
    el('#logoutBtn').click();
  });
  var settingsCleanSlate = el('#settingsCleanSlate');
  if(settingsCleanSlate) settingsCleanSlate.addEventListener('click', cleanSlateSoloWorkspace);
  var settingsDefaultBrowserBtn = el('#settingsDefaultBrowserBtn');
  if(settingsDefaultBrowserBtn) settingsDefaultBrowserBtn.addEventListener('click', function(){
    settingsDefaultBrowserBtn.disabled = true;
    Promise.resolve(window.miaDesktop.defaultBrowser.set()).then(function(state){
      renderSettingsDefaultBrowserState(state);
    }).catch(function(){
      var note = el('#settingsDefaultBrowserNote');
      if(note) note.textContent = 'Could not set Mia as your default browser.';
    }).then(function(){
      settingsDefaultBrowserBtn.disabled = false;
    });
  });
  // Feedback goes out through the user's own mail client — no backend, no
  // credentials. The Electron shell only opens this exact mailto address.
  var FEEDBACK_EMAIL = 'luislozanog86@gmail.com';
  var settingsFeedbackSend = el('#settingsFeedbackSend');
  if(settingsFeedbackSend) settingsFeedbackSend.addEventListener('click', function(){
    var box = el('#settingsFeedbackText');
    var text = box && box.value ? box.value.trim() : '';
    if(!text){ if(box) box.focus(); return; }
    var url = 'mailto:' + FEEDBACK_EMAIL +
      '?subject=' + encodeURIComponent('Mia feedback') +
      '&body=' + encodeURIComponent(text);
    window.open(url);
    var note = el('#settingsFeedbackSent');
    if(note){
      note.classList.add('visible');
      setTimeout(function(){ note.classList.remove('visible'); }, 4000);
    }
  });
  var settingsInstructionsSave = el('#settingsInstructionsSave');
  if(settingsInstructionsSave) settingsInstructionsSave.addEventListener('click', function(){
    var agent = el('#settingsAgentInstructions');
    var bot = el('#settingsBotInstructions');
    var saved = el('#settingsInstructionsSaved');
    settingsInstructionsSave.disabled = true;
    if(saved) saved.classList.remove('visible');
    api('/api/settings/instructions', {method:'POST', body:{
      agent: agent ? agent.value : '',
      bot: bot ? bot.value : ''
    }}).then(function(res){
      if(res.status !== 200 || !res.data) throw new Error(res.data && res.data.error || 'Could not save instructions.');
      renderInstructionSettings(res.data.instructions);
      if(saved){
        saved.textContent = 'Saved';
        saved.classList.add('visible');
        setTimeout(function(){ saved.classList.remove('visible'); }, 2500);
      }
    }).catch(function(error){
      showBenchToast(error.message || 'Could not save instructions.');
    }).finally(function(){
      settingsInstructionsSave.disabled = false;
    });
  });

  function saveGuardrails(){
    var providers = ['anthropic'];
    if(el('#grAllowedProviders').checked) providers.push('openai');
    api('/api/settings/guardrails', {method:'POST', body:{
      allowedProviders: providers
    }}).catch(function(){});
  }
  els('.gr-toggle').forEach(function(cb){
    cb.addEventListener('change', saveGuardrails);
  });

  /* ============ BOT CONFIG SIDE PANEL ============ */
  var IAM_AGENTS = [];
  var IAM_SCOPES = ['Files','Web','Email','Calendar'];
  var IAM_ACCESS = {};
  var LS_INTER_AGENT = 'hos-inter-agent-messaging';
  var LS_IAM = 'hos-iam-access';

  try{
    var storedIam = JSON.parse(localStorage.getItem(LS_IAM) || 'null');
    if(storedIam){
      IAM_AGENTS.forEach(function(a){
        if(storedIam[a]){ IAM_ACCESS[a] = Object.assign(IAM_ACCESS[a] || {}, storedIam[a]); }
      });
    }
  }catch(e){}

  function renderIamTable(){
    var wrap = el('#iamTableWrap');
    if(!wrap) return;
    var thead = '<thead><tr><th>Bot</th>' + IAM_SCOPES.map(function(s){ return '<th>' + esc(s) + '</th>'; }).join('') + '</tr></thead>';
    var rows = IAM_AGENTS.map(function(a){
      var perms = IAM_ACCESS[a] || {};
      return '<tr><td>' + esc(a) + '</td>' + IAM_SCOPES.map(function(s){
        return '<td><button type="button" class="iam-chip ' + (perms[s] ? 'check' : 'lock') + '" data-agent="' + esc(a) + '" data-scope="' + esc(s) + '" title="Toggle ' + esc(s) + ' access for ' + esc(a) + '">' + (perms[s] ? '&#10003;' : '&#128274;') + '</button></td>';
      }).join('') + '</tr>';
    }).join('');
    wrap.innerHTML = '<table class="iam-table">' + thead + '<tbody>' + rows + '</tbody></table>';
    wrap.onclick = function(ev){
      var chip = ev.target.closest('.iam-chip');
      if(!chip) return;
      var a = chip.getAttribute('data-agent'), s = chip.getAttribute('data-scope');
      if(!IAM_ACCESS[a]) return;
      IAM_ACCESS[a][s] = !IAM_ACCESS[a][s];
      localStorage.setItem(LS_IAM, JSON.stringify(IAM_ACCESS));
      renderIamTable();
    };
  }

  (function(){
    var panel = el('#agentConfigPanel');
    var toggle = el('#interAgentMsgToggle');
    var meshNote = el('#acpMeshNote');
    function setMeshNote(){
      meshNote.textContent = toggle.checked
        ? 'Bots can hand work to each other when a task requires it.'
        : 'Bots work alone. Nothing is passed between them.';
    }
    var toggleBtn = el('#configPanelToggle');
    function setConfigOpen(open){
      panel.classList.toggle('open', open);
      toggleBtn.classList.toggle('active', open);
    }
    toggleBtn.addEventListener('click', function(){ setConfigOpen(!panel.classList.contains('open')); });
    el('#acpCloseBtn').addEventListener('click', function(){ setConfigOpen(false); });
    toggle.checked = localStorage.getItem(LS_INTER_AGENT) !== '0';
    setMeshNote();
    toggle.addEventListener('change', function(){
      localStorage.setItem(LS_INTER_AGENT, toggle.checked ? '1' : '0');
      setMeshNote();
    });
  })();

  /* ============ AGENT FEED COLUMN RESIZE ============ */
  var LS_FEED_W = 'hos-agent-feed-w';
  var FEED_W_MIN = 220;
  var FEED_W_MAX = 560;

  (function(){
    var savedW = parseInt(localStorage.getItem(LS_FEED_W), 10);
    if(savedW && savedW >= FEED_W_MIN && savedW <= FEED_W_MAX){
      document.documentElement.style.setProperty('--agent-feed-w', savedW + 'px');
    }
    document.querySelectorAll('.agent-resize-handle').forEach(function(handle){
      handle.addEventListener('pointerdown', function(downEv){
        downEv.preventDefault();
        var layout = handle.closest('.agent-layout');
        var feedCol = layout ? layout.querySelector('.agent-feed-col') : null;
        if(!feedCol) return;
        var startX = downEv.clientX;
        var startW = feedCol.getBoundingClientRect().width;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        function onMove(moveEv){
          var w = Math.round(startW + (moveEv.clientX - startX));
          w = Math.max(FEED_W_MIN, Math.min(FEED_W_MAX, w));
          document.documentElement.style.setProperty('--agent-feed-w', w + 'px');
        }
        function onUp(){
          handle.classList.remove('dragging');
          document.body.style.userSelect = '';
          var finalW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--agent-feed-w'), 10);
          if(finalW) localStorage.setItem(LS_FEED_W, finalW);
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  })();

  /* ============ AGENT BENCH: server-created bots only ============ */
  var benchAgents = [];
  var benchOpenId = null;
  var benchJustAdded = null;

  var BENCH_COLUMNS = [
    {key:'running', name:'Running now', glyph:'&#9658;', sub:'Actively working', empty:'nothing running', foot:'View all running bots'},
    {key:'watch', name:'On watch', glyph:'&#9673;', sub:'Monitoring data / waiting for triggers', empty:'nothing on watch', foot:'View all bots on watch'},
    {key:'draft', name:'Drafts', glyph:'&#9998;', sub:'Saved setup, not active yet', empty:'no saved drafts', foot:'View saved drafts'}
  ];

  function excerpt(text, max){
    var s = String(text || '');
    return s.length > max ? s.slice(0, max).trim() + '…' : s;
  }
  // Multi-word names use the first two initials; single-word names use their
  // first two characters so every bot keeps a readable two-letter mark.
  function benchMark(name){
    var words = (name || '').split(/\s+/).filter(Boolean);
    if(words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return (words[0] || '').slice(0, 2).toUpperCase();
  }
  // Mia Mote variants: bot avatars stay in the same mascot family, but each
  // bot gets a stable visual identity. Known categories use their named
  // motif; unknown names get a deterministic pseudo-random variant so a
  // rerender never makes an agent jump between colors/forms.
  function moteHash(str){
    var hash = 0;
    for(var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return hash;
  }
  function moteVariantFor(name){
    var lower = String(name || '').toLowerCase();
    if(/inbox|email|triage/.test(lower)) return 'inbox';
    if(/research|researcher|pattern|scout/.test(lower)) return 'research';
    if(/calendar|schedule|meeting/.test(lower)) return 'calendar';
    if(/sales|customer|account|outreach/.test(lower)) return 'sales';
    if(!lower) return 'general';
    var variants = ['general', 'inbox', 'research', 'calendar', 'sales'];
    return variants[moteHash(lower) % variants.length];
  }

  // The motif is a department signal; the body color is an individual
  // identity signal. Keep a larger palette so the current roster does not
  // collapse into the same five colors, and resolve hash collisions instead
  // of assigning the same color twice until the palette is exhausted.
  var MOTE_COLOR_PALETTE = [
    337, 355, 12, 27, 44, 61, 84, 112,
    145, 169, 192, 211, 231, 252, 276, 305
  ];
  var MOTE_BASE_HUES = {general: 34, inbox: 337, research: 272, calendar: 24, sales: 358};
  var moteColorSlots = Object.create(null);
  var moteColorOwners = Object.create(null);
  var AGENT_COLOR_OPTIONS = [
    {label:'Rose', value:'#e83e9a'},
    {label:'Coral', value:'#ed6a5a'},
    {label:'Amber', value:'#e5ae24'},
    {label:'Leaf', value:'#63a64f'},
    {label:'Sky', value:'#4c8ff5'},
    {label:'Blue', value:'#3478d4'},
    {label:'Violet', value:'#8957e5'},
    {label:'Plum', value:'#b968e6'}
  ];
  function normalizeAgentAvatarColor(value){
    var color = String(value || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(color) ? color : '';
  }
  function agentAvatarColorFor(name, agentId){
    var records = [];
    if(typeof benchAgents !== 'undefined' && Array.isArray(benchAgents)) records = records.concat(benchAgents);
    if(typeof chatWs !== 'undefined' && chatWs && Array.isArray(chatWs.allAgents)) records = records.concat(chatWs.allAgents);
    var wantedId = String(agentId || '');
    var wantedName = String(name || '').trim().toLowerCase();
    for(var i = 0; i < records.length; i++){
      var record = records[i];
      if(!record) continue;
      var recordId = String(record.id || record.agentId || '');
      var recordName = String(record.name || '').trim().toLowerCase();
      if((wantedId && (recordId === wantedId || String(record.agentId || '') === wantedId)) ||
         (!wantedId && wantedName && recordName === wantedName) ||
         (wantedId && wantedName && recordName === wantedName)){
        var color = normalizeAgentAvatarColor(record.avatarColor);
        if(color) return color;
      }
    }
    return '';
  }
  function avatarColorHue(value){
    var color = normalizeAgentAvatarColor(value);
    if(!color) return null;
    var r = parseInt(color.slice(1, 3), 16) / 255;
    var g = parseInt(color.slice(3, 5), 16) / 255;
    var b = parseInt(color.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if(!delta) return 0;
    var h;
    if(max === r) h = ((g - b) / delta) % 6;
    else if(max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = Math.round(h * 60);
    return h < 0 ? h + 360 : h;
  }
  function moteColorSlotFor(name){
    var key = String(name || '').trim().toLowerCase() || 'general';
    if(moteColorSlots[key] !== undefined) return moteColorSlots[key];
    var preferred = moteHash('color:' + key) % MOTE_COLOR_PALETTE.length;
    var slot = preferred;
    for(var step = 0; step < MOTE_COLOR_PALETTE.length; step++){
      slot = (preferred + step) % MOTE_COLOR_PALETTE.length;
      if(!moteColorOwners[slot] || moteColorOwners[slot] === key) break;
    }
    // Once there are more Motes than palette entries, a repeat is preferable
    // to failing to render the avatar; normal rosters stay collision-free.
    moteColorSlots[key] = slot;
    moteColorOwners[slot] = key;
    return slot;
  }
  function moteColorFilterFor(name, explicitColor){
    var variant = moteVariantFor(name);
    var source = MOTE_BASE_HUES[variant] === undefined ? MOTE_BASE_HUES.general : MOTE_BASE_HUES[variant];
    var target = avatarColorHue(explicitColor);
    if(target === null) target = MOTE_COLOR_PALETTE[moteColorSlotFor(name)];
    var rotation = ((target - source + 540) % 360) - 180;
    return 'hue-rotate(' + rotation + 'deg) saturate(1.08)';
  }
  // Smile (the envelope crease) comes in three sizes; each bot keeps the
  // same one forever, picked from its name — a different hash mix than the
  // variant so the two don't correlate.
  function moteSmileFor(name){
    var lower = String(name || '').toLowerCase();
    if(!lower) return '';
    var smiles = ['', '-half', '-third'];
    return smiles[moteHash('smile:' + lower) % smiles.length];
  }
  function moteSrcFor(name, isStatic){
    return 'assets/mote/mote-' + moteVariantFor(name) + moteSmileFor(name) + (isStatic ? '-static' : '') + '.svg';
  }
  function isMiaOrchestrator(name, agentId){
    var lower = String(name || '').trim().toLowerCase();
    return agentId === 'gateway' || lower === 'mia' || lower === 'mia os';
  }
  // Chat events carry the agent's display name, while the detail slide-over
  // is keyed by the bench presentation id. Resolve through the live API
  // roster first, then the merged bench list so renamed agents still open
  // their own profile rather than a same-name guess.
  function agentProfileRefFor(name, agentId){
    if(isMiaOrchestrator(name, agentId)) return '';
    var wantedId = String(agentId || '').trim();
    var wantedName = String(name || '').trim().toLowerCase();
    var bench = wantedId && (findBenchAgentByServerId(wantedId) || findBenchAgent(wantedId));
    if(!bench && wantedName){
      bench = benchAgents.filter(function(a){ return String(a.name || '').trim().toLowerCase() === wantedName; })[0] || null;
    }
    if(bench) return bench.id;
    var records = (typeof chatWs !== 'undefined' && chatWs && Array.isArray(chatWs.allAgents)) ? chatWs.allAgents : [];
    var record = records.filter(function(a){
      return (wantedId && String(a.id || '') === wantedId) || (wantedName && String(a.name || '').trim().toLowerCase() === wantedName);
    })[0];
    if(!record) return '';
    bench = findBenchAgentByServerId(record.id);
    return bench ? bench.id : String(record.id || '');
  }
  function miaAvatarHtml(size, extraClass, mode){
    var px = Math.max(16, Math.min(160, parseInt(size, 10) || 28));
    var modeAttr = mode ? ' data-mia-mark-mode="' + esc(mode) + '"' : '';
    return '<span class="mia-avatar-mark' + (extraClass ? ' ' + extraClass : '') + '" style="width:' + px + 'px;height:' + px + 'px" aria-hidden="true"><span data-mia-mark="' + px + '"' + modeAttr + '></span></span>';
  }
  function agentAvatarHtml(name, agentId, size, markMode, colorOverride, profileInteractive){
    if(isMiaOrchestrator(name, agentId)){
      var miaMode = markMode === 'sidebar' ? 'sidebar' : markMode === 'activity' ? 'activity' : 'static';
      return miaAvatarHtml(size || 28, 'mia-avatar-mark--' + miaMode, miaMode);
    }
    var variant = moteVariantFor(name);
    var color = normalizeAgentAvatarColor(colorOverride) || agentAvatarColorFor(name, agentId);
    var profileRef = agentProfileRefFor(name, agentId);
    var profileAttrs = profileRef ? ' data-agent-profile-id="' + esc(profileRef) + '" data-agent-profile-name="' + esc(name) + '"' : '';
    if(profileInteractive && profileRef) profileAttrs += ' role="button" tabindex="0" aria-label="Open ' + esc(name) + ' details"';
    var staticSrc = moteSrcFor(name, true);
    var animatedSrc = moteSrcFor(name, false);
    return '<img src="' + staticSrc + '" data-mote-static-src="' + staticSrc + '" data-mote-animated-src="' + animatedSrc + '" alt="" class="mote-avatar-img mote-avatar-img--' + variant + '" style="filter:' + moteColorFilterFor(name, color) + '"' + profileAttrs + ' draggable="false" />';
  }
  // Chat's own empty-state / onboarding hero — shown before a room is
  // picked, and again for a freshly-opened room with no messages yet.
  // For an agent room the hero is that bot's own Mote variant; elsewhere
  // (no room / channels) it's the plain pink one.
  function chatHeroHtml(message, agentName){
    var hero = agentName && isMiaOrchestrator(agentName) ? miaAvatarHtml(132, 'chat-empty-hero-mia', 'static')
      : '<img src="' + (agentName ? moteSrcFor(agentName, true) : 'assets/mote/mote-static.svg') + '" alt="" class="chat-empty-hero-mote"' + (agentName ? ' style="filter:' + moteColorFilterFor(agentName, agentAvatarColorFor(agentName, null)) + '"' : '') + ' draggable="false" />';
    return '<div class="chat-empty-hero">' + hero +
      '<div class="chat-empty-hero-text">' + message + '</div></div>';
  }
  function miaEmptyGreeting(displayName){
    var name = realProfileName(displayName);
    return (name ? 'Hi ' + name : 'Hi') + ' — what would you like to work on?';
  }
  function apiAgentToBench(a){
    var stateMap = {draft:'draft', running:'running', watch:'watch', active:'running', inactive:'watch'};
    var departments = (Array.isArray(a.departments) && a.departments.length) ? a.departments.slice()
      : (a.department ? [a.department] : guessDepartmentsFor(a.instructions));
    return {
      id: a.id, name: a.name, brief: excerpt(a.instructions, 120),
      state: stateMap[a.status] || 'watch', model: a.model, isBuiltin: a.builtin === true,
      agentId: a.builtin === true ? a.id : null,
      updatedAt: a.updatedAt, createdAt: a.createdAt,
      runs: '—', last: 'never run', instructions: a.instructions,
      instructionsRevision: a.instructionsRevision,
      departments: departments, avatarColor: normalizeAgentAvatarColor(a.avatarColor)
    };
  }
  function syncChatBotRecords(apiAgents){
    var records = Array.isArray(apiAgents) ? apiAgents : [];
    if(typeof chatWs === 'undefined' || !chatWs) return records;
    var existing = Array.isArray(chatWs.allAgents) ? chatWs.allAgents : [];
    chatWs.botRecords = records.slice();
    chatWs.allAgents = records.map(function(record){
      var binding = existing.filter(function(agent){ return String(agent.id || '') === String(record.id || ''); })[0];
      if(!binding) return record;
      return Object.assign({}, record, {
        roomId: binding.roomId || binding.nativeConversationId || null,
        conversationId: binding.conversationId || binding.nativeConversationId || binding.roomId || null,
        nativeConversationId: binding.nativeConversationId || binding.conversationId || binding.roomId || null
      });
    });
    return chatWs.allAgents;
  }
  function loadAgents(){
    return api('/api/bots').then(function(res){
      var agents = ((res.data && res.data.bots) || []).filter(function(agent){
        var status = String(agent.status || '').toLowerCase();
        return status !== 'paused';
      });
      // Native conversation hydration projects bots down to room identity
      // fields in chatWs.allAgents. Keep the complete API records separately
      // so durable configuration such as automation is never lost.
      syncChatBotRecords(agents);
      return agents;
    }).catch(function(){ return []; });
  }
  function loadBenchAgents(){
    return loadAgents().then(function(apiAgents){
      benchAgents = apiAgents.map(apiAgentToBench);
    });
  }

  /* ============ DEPARTMENTS: editable org-chart tags on bots. The backend DB is
     authoritative; deptCache is only the latest server-confirmed snapshot. ============ */
  var deptCache = null;
  function loadDepartments(){
    return Array.isArray(deptCache) ? deptCache : [];
  }
  function saveDepartments(list){
    var previous = loadDepartments().slice();
    var requested = (list || []).slice();
    deptCache = requested;
    return api('/api/departments', {method:'PUT', body:{departments: requested}}).then(function(res){
      var stored = res.status === 200 && res.data && res.data.departments;
      if(!Array.isArray(stored)){
        deptCache = previous;
        return {ok:false, departments:previous};
      }
      deptCache = stored.slice();
      return {ok:true, departments:deptCache.slice()};
    }).catch(function(){
      deptCache = previous;
      return {ok:false, departments:previous};
    });
  }
  function refreshDepartmentsFromServer(){
    return api('/api/departments').then(function(res){
      var list = res.data && res.data.departments;
      if(Array.isArray(list)){
        deptCache = list.slice();
        paintAcpDepartments();
      }
    }).catch(function(){});
  }
  function slugifyDept(name){
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'dept';
  }
  function agentDepartments(a){
    if(Array.isArray(a.departments) && a.departments.length) return a.departments;
    if(a.department) return [a.department];
    return [];
  }
  function departmentAgentCount(name){
    return benchAgents.filter(function(a){ return agentDepartments(a).indexOf(name) !== -1; }).length;
  }
  function addDepartment(name){
    var n = String(name || '').trim();
    if(!n) return false;
    var list = loadDepartments().slice();
    if(list.some(function(d){ return d.toLowerCase() === n.toLowerCase(); })) return false;
    list.push(n);
    saveDepartments(list);
    return true;
  }
  /* Renaming cascades to every server-created bot tagged with the old name. */
  function renameDepartment(oldName, newName){
    var n = String(newName || '').trim();
    if(!n || n === oldName) return Promise.resolve();
    var list = loadDepartments();
    if(list.some(function(d){ return d.toLowerCase() === n.toLowerCase() && d !== oldName; })) return Promise.resolve(); // would collide with an existing department
    var nextDepartments = list.map(function(d){ return d === oldName ? n : d; });
    var swap = function(depts){ return depts.map(function(d){ return d === oldName ? n : d; }); };
    var affected = benchAgents.filter(function(a){ return agentDepartments(a).indexOf(oldName) !== -1 && (!a.isBuiltin || a.agentId); });
    return saveDepartments(nextDepartments).then(function(saved){
      if(!saved.ok) return [];
      return Promise.all(affected.map(function(a){
        var targetId = a.isBuiltin ? a.agentId : a.id;
        return api('/api/bots/' + targetId, {method:'PUT', body:{departments: swap(agentDepartments(a))}}).catch(function(){});
      }));
    });
  }
  function removeDepartment(name){
    if(departmentAgentCount(name) > 0) return false;
    saveDepartments(loadDepartments().filter(function(d){ return d !== name; }));
    return true;
  }
  function guessDepartmentsFor(text){
    var k = matchBenchKind(text);
    var list = loadDepartments();
    if(k && k.department && list.indexOf(k.department) !== -1) return [k.department];
    return list.length ? [list[0]] : [];
  }

  var acpDeptBlockedHint = null; // department name currently showing a "can't remove, still in use" hint
  function renderAcpDepartments(){
    return loadBenchAgents().then(paintAcpDepartments);
  }
  function paintAcpDepartments(){
    var wrap = el('#acpDeptList');
    if(!wrap) return;
    var list = loadDepartments();
    wrap.innerHTML = list.map(function(d){
      var count = departmentAgentCount(d);
      var blocked = acpDeptBlockedHint === d;
      return '<div class="acp-dept-row">' +
        '<button type="button" class="acp-dept-name-btn" data-dept-rename="' + esc(d) + '">' + esc(d) + '</button>' +
        (blocked
          ? '<span class="acp-dept-blocked-hint">in use by ' + count + (count === 1 ? ' bot' : ' bots') + '</span>'
          : '<span class="acp-dept-count">' + count + (count === 1 ? ' bot' : ' bots') + '</span>') +
        '<button type="button" class="acp-dept-remove" data-dept-remove="' + esc(d) + '" title="Remove department">&times;</button>' +
      '</div>';
    }).join('');
  }
  el('#acpDeptList').addEventListener('click', function(e){
    var renameBtn = e.target.closest('[data-dept-rename]');
    var removeBtn = e.target.closest('[data-dept-remove]');
    if(renameBtn){
      var oldName = renameBtn.getAttribute('data-dept-rename');
      var input = document.createElement('input');
      input.type = 'text'; input.className = 'acp-dept-name-input'; input.value = oldName; input.maxLength = 40;
      renameBtn.replaceWith(input);
      input.focus(); input.select();
      var committed = false;
      var commit = function(){
        if(committed) return;
        committed = true;
        var newName = input.value.trim();
        if(newName && newName !== oldName){
          renameDepartment(oldName, newName).then(function(){
            renderAcpDepartments();
            route();
          });
        } else {
          paintAcpDepartments();
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function(ev){
        if(ev.key === 'Enter'){ ev.preventDefault(); input.blur(); }
        else if(ev.key === 'Escape'){ input.value = oldName; input.blur(); }
      });
      return;
    }
    if(removeBtn){
      var name = removeBtn.getAttribute('data-dept-remove');
      if(departmentAgentCount(name) > 0){
        acpDeptBlockedHint = name;
        paintAcpDepartments();
        setTimeout(function(){ if(acpDeptBlockedHint === name){ acpDeptBlockedHint = null; paintAcpDepartments(); } }, 2200);
        return;
      }
      if(removeDepartment(name)){
        var wasCurrent = currentDeptRouteName() === name;
        paintAcpDepartments();
        if(wasCurrent) location.hash = '#/agent-admin'; else route();
      }
    }
  });
  el('#acpDeptAddBtn').addEventListener('click', function(){
    var input = el('#acpDeptNewInput');
    if(addDepartment(input.value)){
      input.value = '';
      paintAcpDepartments();
      route();
    }
  });
  el('#acpDeptNewInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); el('#acpDeptAddBtn').click(); }
  });

  function benchCardHtml(a, pillLabel){
    var openCls = a.id === benchOpenId ? ' open' : '';
    var addedCls = a.id === benchJustAdded ? ' justAdded' : '';
    return '<button type="button" class="bench-card' + openCls + addedCls + '" data-agent-id="' + esc(a.id) + '">' +
      '<span class="bench-mark">' + esc(benchMark(a.name)) + '</span>' +
      '<div class="bench-card-body"><h3>' + esc(a.name) + '</h3><p>' + esc(a.brief) + '</p></div>' +
      '<div class="bench-card-meta"><span class="bench-pill ' + a.state + '">' + esc(pillLabel) + '</span><span style="font-family:var(--mono);font-size:13px;color:#B4AFA8;">&#8942;</span></div>' +
    '</button>';
  }

  function renderBenchColumns(){
    var wrap = el('#benchColumns');
    if(!wrap) return;
    var pillLabel = {running:'RUNNING', watch:'ON WATCH', draft:'DRAFT'};
    wrap.innerHTML = BENCH_COLUMNS.map(function(col){
      var list = benchAgents.filter(function(a){ return a.state === col.key; });
      var cards = list.length
        ? '<div class="bench-cards">' + list.map(function(a){ return benchCardHtml(a, pillLabel[col.key]); }).join('') + '</div>'
        : '<div class="bench-cards"><div class="bench-empty">' + esc(col.empty) + '</div></div>';
      return '<div class="bench-col">' +
        '<div class="bench-col-head"><span class="bench-col-glyph">' + col.glyph + '</span>' +
          '<div style="flex:1;min-width:0;"><div class="bench-col-title-row"><span class="name">' + esc(col.name) + '</span>' +
          '<span class="bench-col-count">' + list.length + '</span></div>' +
          '<div class="bench-col-sub">' + esc(col.sub) + '</div></div></div>' +
        cards +
        '<button type="button" class="bench-col-foot">' + esc(col.foot) + '<span>&rarr;</span></button>' +
      '</div>';
    }).join('');
    els('[data-agent-id]', wrap).forEach(function(card){
      card.addEventListener('click', function(){ openBenchDetail(card.getAttribute('data-agent-id')); });
    });
  }

  function findBenchAgent(id){
    return benchAgents.filter(function(a){ return a.id === id; })[0] || null;
  }
  function findBenchAgentByServerId(id){
    return benchAgents.filter(function(a){ return a.id === id || a.agentId === id; })[0] || null;
  }

  // Chat can paint an agent message before the merged Agent Bench roster has
  // finished loading. Build the same bench-shaped record from the already
  // loaded API row so an avatar click never becomes a no-op during that race.
  function benchAgentFromApiRecord(record){
    if(!record) return null;
    return apiAgentToBench(record);
  }
  function cacheBenchAgent(agent){
    if(!agent) return null;
    var existing = findBenchAgent(agent.id);
    if(existing) return existing;
    benchAgents.push(agent);
    return agent;
  }

  function mkIconBtn(glyph, cls, title, handler){
    var b = document.createElement('button');
    b.className = cls;
    b.innerHTML = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.type = 'button';
    b.addEventListener('click', handler);
    return b;
  }

  function openBenchDetail(id){
    var a = findBenchAgent(id);
    if(!a) return;
    benchOpenId = id;
    refreshAgentsView();
    cancelBenchDetailNameEdit(); // a reopen (e.g. after a prior rename commits) always starts read-only
    var statusLabel = {running:'running', watch:'on watch', draft:'draft'}[a.state] || a.state;
    el('#benchDetailMark').innerHTML = agentAvatarHtml(a.name, a.isBuiltin ? a.agentId : a.id, 34);
    el('#benchDetailName').textContent = a.name;
    el('#benchDetailDot').className = 'bench-status-dot ' + a.state;
    el('#benchDetailStatusLine').textContent = statusLabel;
    el('#benchDetailBrief').textContent = a.brief;
    benchDetailDeptState = {agentId: id, departments: agentDepartments(a).slice()};
    renderDeptDropdown('benchDetailDept', loadDepartments(), benchDetailDeptState.departments);
    var lastRun = a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : 'never';
    el('#benchDetailStats').innerHTML = [
      {label:'STATE', value: statusLabel},
      {label:'RUNS', value: a.runs},
      {label:'LAST RUN', value: lastRun},
      {label:'DEPARTMENTS', value: agentDepartments(a).join(', ') || '—', full:true}
    ].map(function(s){ return '<div class="bench-stat' + (s.full ? ' bench-stat-full' : '') + '"><div class="bench-stat-label">' + s.label + '</div><div class="bench-stat-value">' + esc(s.value) + '</div></div>'; }).join('');

    var logWrap = el('#benchDetailLog');
    function paintLog(log){
      logWrap.innerHTML = (log && log.length)
        ? log.map(function(l){ return '<div class="bench-log-row"><span class="bench-log-when">' + esc(l.when) + '</span><span class="bench-log-what">' + esc(l.what) + '</span></div>'; }).join('')
        : '<div class="no-data">no runs yet</div>';
    }
    paintLog(null);

    var actions = el('#benchDetailActions');
    actions.innerHTML = '';
    actions.appendChild(mkBtn('Edit bot', 'btn primary', function(){ closeBenchDetail(); openEditCinema(a.id); }));
    if(!a.isBuiltin){
      var cycleLabel = {running:'Send to watch', watch:'Start it', draft:'Resume setup'}[a.state] || 'Change status';
      var nextState = {running:'watch', watch:'running', draft:'watch'}[a.state] || 'watch';
      actions.appendChild(mkBtn(cycleLabel, 'btn', function(){
        api('/api/bots/' + a.id, {method:'PUT', body:{status: nextState}}).then(function(res){
          if(res.status === 200){ loadBenchAgents().then(function(){ openBenchDetail(a.id); }); }
        }).catch(function(){});
      }));
    }
    if(!(a.isBuiltin && !a.agentId)){
      actions.appendChild(mkIconBtn(
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        'bench-delete-btn', 'Delete bot',
        function(){ deleteBenchAgent(a, closeBenchDetail); }
      ));
    }
    el('#benchDetail').classList.add('open');
  }
  function closeBenchDetail(){
    benchOpenId = null;
    el('#benchDetail').classList.remove('open');
    refreshAgentsView();
  }
  el('#benchDetailClose').addEventListener('click', closeBenchDetail);

  /* Click-to-rename the detail card's title (#benchDetailName / its sibling
     input, both static in index.html — openBenchDetail only ever updates
     their text/value, so these ids stay valid across every open/reopen and
     the listeners below are bound once). commit/cancel both no-op if the
     input isn't currently the visible one, so a stray blur firing after an
     Enter-triggered commit (or an Escape-triggered cancel) can't double-fire
     the PUT or re-run cleanup. */
  function startBenchDetailNameEdit(){
    var a = findBenchAgent(benchOpenId);
    var titleEl = el('#benchDetailName'), input = el('#benchDetailNameInput');
    if(!a || !titleEl || !input) return;
    input.value = a.name;
    titleEl.classList.add('editing');
    input.classList.add('editing');
    input.focus();
    input.select();
  }
  function cancelBenchDetailNameEdit(){
    var titleEl = el('#benchDetailName'), input = el('#benchDetailNameInput');
    if(!titleEl || !input || !input.classList.contains('editing')) return;
    titleEl.classList.remove('editing');
    input.classList.remove('editing');
  }
  function commitBenchDetailNameEdit(){
    var input = el('#benchDetailNameInput');
    if(!input || !input.classList.contains('editing')) return;
    var id = benchOpenId;
    var a = findBenchAgent(id);
    var name = input.value.trim();
    var targetId = a && (a.isBuiltin ? a.agentId : a.id);
    // Empty or unchanged values revert silently.
    if(!a || !name || name === a.name || !targetId){
      cancelBenchDetailNameEdit();
      return;
    }
    // Renaming does not write instructions: AGENTS.md remains authoritative
    // even if it was edited directly since this card was loaded.
    api('/api/bots/' + targetId, {method:'PUT', body:{name: name, model: a.model, departments: agentDepartments(a)}}).then(function(res){
      if(res.status === 200 && benchOpenId === id){
        loadBenchAgents().then(function(){ openBenchDetail(id); });
      } else {
        cancelBenchDetailNameEdit();
      }
    }).catch(function(){ cancelBenchDetailNameEdit(); });
  }
  el('#benchDetailName').addEventListener('click', startBenchDetailNameEdit);
  el('#benchDetailNameInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); commitBenchDetailNameEdit(); }
    else if(e.key === 'Escape'){ e.preventDefault(); cancelBenchDetailNameEdit(); }
  });
  el('#benchDetailNameInput').addEventListener('blur', commitBenchDetailNameEdit);

  /* whichever agents-layer list is on screen right now — the flat bench columns on My Agents,
     or a single department's card list — repainted from the already-loaded benchAgents */
  function refreshAgentsView(){
    var dept = currentDeptRouteName();
    if(dept) paintDepartmentPanel(dept);
    else renderBenchColumns();
  }
  function renderDepartmentPanel(deptName){
    return loadBenchAgents().then(function(){ paintDepartmentPanel(deptName); });
  }
  function paintDepartmentPanel(deptName){
    el('#deptPanelTitle').textContent = deptName;
    var count = departmentAgentCount(deptName);
    el('#deptPanelTag').textContent = count + (count === 1 ? ' bot' : ' bots');
    var wrap = el('#deptPanelCards');
    var pillLabel = {running:'RUNNING', watch:'ON WATCH'};
    var list = benchAgents.filter(function(a){ return agentDepartments(a).indexOf(deptName) !== -1; });
    wrap.innerHTML = list.length
      ? list.map(function(a){ return benchCardHtml(a, pillLabel[a.state] || a.state); }).join('')
      : '<div class="bench-empty">no bots in this department yet</div>';
    els('[data-agent-id]', wrap).forEach(function(card){
      card.addEventListener('click', function(){ openBenchDetail(card.getAttribute('data-agent-id')); });
    });
  }
  el('#deptNewAgentBtn').addEventListener('click', function(){
    var d = currentDeptRouteName();
    openCinema();
    if(d){ cinema.departments = [d]; cinema.departmentsTouched = true; renderCinema(); }
  });

  /* ---- cinema: compose -> build -> ready ---- */
  var BENCH_KINDS = [
    {key:'research', department:'Research', words:['research','compare','investigate','summarize','sources'],
      name:'Research Bot', access:['Web','Files'], schedule:'On request',
      reads:'approved websites and workspace files', outcome:'return a sourced summary',
      finding:'Completed a safe sample research task and returned a concise summary.',
      sample:{task:'Compare the supplied documents and summarize the important differences', flaggedNow:2, flaggedBefore:3,
        rows:[{score:93, desc:'Primary difference found in the latest document', tag:'review'},
              {score:86, desc:'One supporting source needs confirmation', tag:'source'}],
        footnote:'One duplicate item was omitted from the result.'},
      improvements:[{date:'recently', text:'Started citing the exact file or page behind each finding.'}]},
    {key:'files', department:'Operations', words:['file','folder','document','report','organize'],
      name:'File Assistant', access:['Files'], schedule:'Every weekday, 9:00 AM',
      reads:'the folders you explicitly allow', outcome:'organize files and report changes',
      finding:'Reviewed the test folder and reported the files that changed.',
      sample:{task:'Review this folder and list what changed', flaggedNow:2, flaggedBefore:2,
        rows:[{score:91, desc:'One document was updated since the last run', tag:'changed'},
              {score:84, desc:'One new file is ready for review', tag:'new'}],
        footnote:'Unchanged files were left out.'},
      improvements:[{date:'recently', text:'Stopped reporting files whose contents did not change.'}]},
    {key:'inbox', department:'Operations', words:['email','inbox','mail','message','reply'],
      name:'Inbox Assistant', access:['Email'], schedule:'As messages arrive',
      reads:'messages from a connected account', outcome:'surface messages that need attention',
      finding:'Sorted the sample messages and identified two that need a reply.',
      sample:{task:'Review the sample inbox and flag messages that need a response', flaggedNow:2, flaggedBefore:4,
        rows:[{score:94, desc:'Customer question needs a reply', tag:'reply'},
              {score:88, desc:'Project update needs acknowledgement', tag:'review'}],
        footnote:'Informational messages were filed quietly.'},
      improvements:[{date:'recently', text:'Stopped surfacing newsletters as action items.'}]}
  ];
  var BENCH_FALLBACK_KIND = {name:'New Bot', access:['Files'], schedule:'On request',
    reads:'only the data and connected apps you approve', outcome:'complete the requested job and report the result',
    finding:'Completed a safe test run and returned the result.',
    sample:{task:'Run a harmless sample task using the edited brief', flaggedNow:1, flaggedBefore:1,
      rows:[{score:87, desc:'Sample task completed successfully', tag:'done'}],
      footnote:'No unrelated data was accessed.'},
    improvements:[{date:'recently', text:'Completed a safe test run using only approved data.'}]};
  var BENCH_MODELS = [];

  function syncBenchModelsFromChatInventory(){
    var seen = {};
    var models = chatConnectedModelEntries().map(function(item){ return item.model; }).filter(function(model){
      var key = String(model || '').toLowerCase();
      if(!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
    BENCH_MODELS = models;
  }

  function selectedConnectedBotModel(){
    if(!chatModelPicker.loaded || chatModelPicker.error) return null;
    var selected = chatModelPicker.selection && chatModelPicker.selection.model;
    if(selected && chatConnectedModelEntries().some(function(item){ return item.model === selected; })) return selected;
    return null;
  }

  function styledAgentModelLabel(model){
    return String(chatModelParts(model).variant || model || 'Choose model').replace(/^GPT (\d)/, 'GPT-$1');
  }

  function styledAgentModelMenuOptionsHtml(){
    if(!chatModelPicker.loaded){
      return '<div class="cc-model-selection">' + esc(chatModelPicker.loading ? 'Loading connected models…' : (chatModelPicker.error || 'Connected models unavailable.')) + '</div>';
    }
    var entries = chatConnectedModelEntries();
    if(styledAgentModelPicker.stage === 'variant'){
      var variants = entries.filter(function(item){ return item.familyKey === styledAgentModelPicker.familyKey; });
      return variants.map(function(item){
        return '<button type="button" class="cc-model-option" data-styled-agent-model="' + esc(item.model) + '"><span class="cc-model-option-label">' + esc(item.variant) + '</span><span class="cc-model-option-meta">' + esc(item.providerLabel) + '</span></button>';
      }).join('') || '<div class="cc-model-selection">No connected models are available.</div>';
    }
    var families = {};
    entries.forEach(function(item){
      if(!families[item.familyKey]) families[item.familyKey] = {key:item.familyKey, family:item.family, provider:item.providerLabel};
    });
    return Object.keys(families).map(function(key){
      var item = families[key];
      return '<button type="button" class="cc-model-option" data-styled-agent-family="' + esc(item.key) + '"><span class="cc-model-option-label">' + esc(item.family) + '</span><span class="cc-model-option-meta">' + esc(item.provider) + '</span></button>';
    }).join('') || '<div class="cc-model-selection">No connected models are available.</div>';
  }

  function renderStyledAgentModelPicker(){
    var wrap = el('#styledAgentModelPicker');
    if(!wrap || !editState.agentId) return;
    var label = el('#styledAgentEditModelLabel', wrap);
    var title = el('#styledAgentModelTitle', wrap);
    var back = el('#styledAgentModelBack', wrap);
    var options = el('#styledAgentModelOptions', wrap);
    var summary = el('#styledAgentModelSummary', wrap);
    if(label) label.textContent = styledAgentModelLabel(editState.model);
    if(title) title.textContent = styledAgentModelPicker.stage === 'variant' ? 'Choose a model' : 'Choose a model family';
    if(back) back.hidden = styledAgentModelPicker.stage !== 'variant';
    if(options) options.innerHTML = styledAgentModelMenuOptionsHtml();
    if(summary) summary.textContent = editState.model || 'No model selected';
  }

  function closeStyledAgentModelPickerMenu(){
    var menu = el('#styledAgentModelMenu');
    var button = el('#styledAgentEditModel');
    if(menu) menu.classList.remove('open');
    if(button) button.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('click', function(e){
    var wrap = el('#styledAgentModelPicker');
    if(wrap && !wrap.contains(e.target)) closeStyledAgentModelPickerMenu();
  });

  function refreshStyledAgentModelSelect(){ renderStyledAgentModelPicker(); }
  // Generic fallback shown while workspace-grounded suggestions load.
  var BENCH_EXAMPLES = [
    'Summarize new files every Friday',
    'Research a topic and cite sources',
    'Flag messages that need a reply',
    'Create a weekly project update'
  ];
  var benchExamplesLoaded = null; // fetched pills once GET /api/bots/examples resolves; null/[] means "still use the fallback"
  var benchExamplesFetchStarted = false;
  function currentBenchExamples(){
    return (benchExamplesLoaded && benchExamplesLoaded.length) ? benchExamplesLoaded : BENCH_EXAMPLES;
  }

  // Keep the first bot action concrete for new users. These are prompts, not
  // pre-created bots: clicking one opens the normal setup conversation with
  // the prompt ready to edit and send.
  var CHAT_STARTER_BOTS = [
    {name:'Weekly project update', prompt:'Create a bot that prepares a concise project update every Friday from the files I approve.', avatarColor:'#e83e9a'},
    {name:'Inbox triage', prompt:'Create a bot that reviews new messages and flags the ones that need a reply.', avatarColor:'#3478d4'},
    {name:'Research brief', prompt:'Create a bot that researches a topic, cites its sources, and sends me a short brief.', avatarColor:'#63a64f'}
  ];
  var CHAT_STARTER_BOTS_HIDDEN_KEY = 'miaHiddenStarterBots';
  function hiddenChatStarterBots(){
    try {
      var value = JSON.parse(localStorage.getItem(CHAT_STARTER_BOTS_HIDDEN_KEY) || '[]');
      return Array.isArray(value) ? value.filter(function(name){ return typeof name === 'string'; }) : [];
    } catch(error){ return []; }
  }
  function hideChatStarterBot(name){
    var hidden = hiddenChatStarterBots();
    if(hidden.indexOf(name) === -1) hidden.push(name);
    try { localStorage.setItem(CHAT_STARTER_BOTS_HIDDEN_KEY, JSON.stringify(hidden)); } catch(error) {}
    // Dismissal is durable: the server copy survives desktop profile
    // switches and reinstalls; localStorage is only the fast local cache.
    api('/api/settings/starter-bots', {method:'POST', body:{hidden:hidden}}).catch(function(){});
    renderChatStarterBots();
  }
  // Merge the server-side dismissal list into the local cache at startup so
  // a dismissal made under another desktop profile still hides the row.
  function syncHiddenStarterBotsFromServer(serverHidden){
    if(!Array.isArray(serverHidden)) return;
    var hidden = hiddenChatStarterBots();
    var merged = hidden.slice();
    serverHidden.forEach(function(name){
      if(typeof name === 'string' && merged.indexOf(name) === -1) merged.push(name);
    });
    if(merged.length !== hidden.length){
      try { localStorage.setItem(CHAT_STARTER_BOTS_HIDDEN_KEY, JSON.stringify(merged)); } catch(error) {}
    }
    // Local-only dismissals (made while the server was unreachable) flow up.
    if(merged.length !== serverHidden.length){
      api('/api/settings/starter-bots', {method:'POST', body:{hidden:merged}}).catch(function(){});
    }
    renderChatStarterBots();
  }
  function renderChatStarterBots(){
    var wrap = el('#chatStarterBots');
    if(!wrap) return;
    var hidden = hiddenChatStarterBots();
    var visible = CHAT_STARTER_BOTS.filter(function(template){ return hidden.indexOf(template.name) === -1; });
    var group = el('#chatStarterBotsGroup');
    if(group) group.hidden = visible.length === 0;
    wrap.innerHTML = visible.map(function(template){
      return '<div class="chat-starter-bot-row"><button type="button" class="chat-starter-bot" data-starter-bot="' + esc(template.name) + '">' +
        '<span class="chat-starter-bot-icon" aria-hidden="true">' + agentAvatarHtml(template.name, null, 28, null, template.avatarColor) + '</span>' +
        '<span class="chat-starter-bot-copy"><strong>' + esc(template.name) + '</strong><small>Start from this example</small></span></button>' +
        '<button type="button" class="chat-starter-bot-dismiss" data-dismiss-starter-bot="' + esc(template.name) + '" aria-label="Remove ' + esc(template.name) + ' preview">×</button></div>';
    }).join('');
    els('[data-starter-bot]', wrap).forEach(function(button){
      button.addEventListener('click', function(){
        var template = CHAT_STARTER_BOTS.filter(function(item){ return item.name === button.getAttribute('data-starter-bot'); })[0];
        if(!template) return;
        startAgentSetupChat();
        var input = el('#ccInput');
        if(input){
          input.value = template.prompt;
          input.dispatchEvent(new Event('input', {bubbles:true}));
          input.focus();
        }
      });
    });
    els('[data-dismiss-starter-bot]', wrap).forEach(function(button){
      button.addEventListener('click', function(event){
        event.preventDefault();
        event.stopPropagation();
        hideChatStarterBot(button.getAttribute('data-dismiss-starter-bot'));
      });
    });
  }
  // Fires once per page load (roster/department changes invalidate the
  // server-side cache, not this client-side latch) — cheap enough to call
  // from every agents-view render; the guard just avoids a redundant fetch.
  function fetchBenchExamplesOnce(){
    if(benchExamplesFetchStarted) return;
    benchExamplesFetchStarted = true;
    api('/api/bots/examples').then(function(res){
      var list = res.status === 200 && res.data && Array.isArray(res.data.examples) ? res.data.examples : [];
      if(!list.length) return; // keep showing BENCH_EXAMPLES
      benchExamplesLoaded = list;
      renderHeroExamples();
      if(cinema.mode === 'compose') renderCinema();
    }).catch(function(){});
  }

  // origin tracks where the cinema was opened from — 'chat' when launched via
  // #chatNewAgentBtn (Messages' "+ New chat" -> "Build an agent"), 'bench'
  // for every other trigger (bench composer, department drilldown, hero
  // examples). finishBenchCreate() below branches on it: a chat-origin
  // create should land the user back in Messages inside a live conversation
  // with the new agent, not on the bench.
  var BENCH_BUILD_TIMEOUT_MS = 30000;
  var cinema = {mode:'idle', prompt:'', name:'', modelIx:0, departments:[], departmentsTouched:false, timers:[], created:null,
    origin: 'bench', nameSuggestTimer: null, nameSuggestKey: null, buildAttempt: 0,
    buildController: null, buildTimeoutTimer: null, buildTimedOut: false, buildStatus: 'idle', buildError: ''};
  var editState = {agentId:null, isBuiltin:false, instructions:'', instructionsRevision:null, model:'', modelIx:0, departments:[], avatarColor:'', suggestion:'', suggestDismissed:false,
    testScopes:[], testRuns:[], testBusy:false, removedImprovements:[]};
  var styledAgentModelPicker = {stage:'family', familyKey:''};
  // Whichever element opened the bot editor (an avatar/mote click, most
  // often) — restored on close so Escape/close never strands keyboard
  // focus at document.body, especially over the browser overlay where
  // there's no other obvious tab stop to land on.
  var agentEditFocusReturn = null;
  function returnAgentEditFocus(){
    var target = agentEditFocusReturn;
    agentEditFocusReturn = null;
    if(target && document.contains(target) && typeof target.focus === 'function') target.focus();
  }
  // Bench-detail header department selector: unlike cinema/editState, this one has no
  // separate "save" step — each toggle PUTs immediately (see the bindDeptDropdown call
  // near the bottom of this file). agentId here is the *card* id (openBenchDetail's id
  // param), reset fresh every time openBenchDetail paints.
  var benchDetailDeptState = {agentId:null, departments:[]};

  /* shared department control: a single dropdown (button + checkbox panel), reused by
     both the compose and edit cinema so departments live in exactly one place per card */
  function toggleDeptSelection(arr, d){
    var ix = arr.indexOf(d);
    if(ix !== -1){
      if(arr.length <= 1) return false; /* at least one department must stay checked */
      arr.splice(ix, 1);
      return true;
    }
    arr.push(d);
    return true;
  }
  function deptDropdownLabel(active){
    if(!active.length) return 'Departments';
    return 'Departments · ' + active.length;
  }
  function renderDeptDropdown(prefix, list, active){
    var label = el('#' + prefix + 'BtnLabel');
    if(label) label.textContent = deptDropdownLabel(active);
    var panel = el('#' + prefix + 'Panel');
    if(!panel) return;
    panel.innerHTML = '<div class="bench-dept-dropdown-label">DEPARTMENTS</div>' +
      list.map(function(d){
        var checked = active.indexOf(d) !== -1;
        return '<label class="bench-dept-dropdown-option"><input type="checkbox" data-dept="' + esc(d) + '"' + (checked ? ' checked' : '') + '/>' + esc(d) + '</label>';
      }).join('') +
      '<div class="bench-dept-dropdown-divider"></div>' +
      '<div class="bench-dept-dropdown-add">' +
        '<input type="text" class="bench-dept-dropdown-add-input" id="' + prefix + 'AddInput" placeholder="New department&hellip;" maxlength="40"/>' +
        '<button type="button" class="bench-dept-dropdown-add-btn" id="' + prefix + 'AddBtn">Add</button>' +
      '</div>' +
      '<div class="bench-dept-dropdown-hint" id="' + prefix + 'Hint">Keep at least one department checked</div>';
  }
  function showDeptHint(prefix, message){
    var hint = el('#' + prefix + 'Hint');
    if(!hint) return;
    hint.textContent = message || 'Keep at least one department checked';
    hint.classList.add('show');
    clearTimeout(hint._deptHintTimer);
    hint._deptHintTimer = setTimeout(function(){ hint.classList.remove('show'); }, 1600);
  }
  /* panel positions fixed off the button's own rect so it always escapes an ancestor
     card's overflow:hidden (the compose/edit cards clip for their rounded corners) */
  function positionDeptPanel(btn, panel){
    var r = btn.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + 'px';
    panel.style.left = 'auto';
    panel.style.right = (window.innerWidth - r.right) + 'px';
  }
  function bindDeptDropdown(prefix, getActive, onToggle, rerender){
    var wrap = el('#' + prefix + 'Dropdown');
    var btn = el('#' + prefix + 'Btn');
    var panel = el('#' + prefix + 'Panel');
    if(!wrap || !btn || !panel) return;
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var opening = !wrap.classList.contains('open');
      wrap.classList.toggle('open');
      if(opening) positionDeptPanel(btn, panel);
    });
    panel.addEventListener('change', function(e){
      var cb = e.target.closest('input[type=checkbox][data-dept]');
      if(!cb) return;
      var d = cb.getAttribute('data-dept');
      var ok = onToggle(d);
      rerender();
      if(!ok) showDeptHint(prefix);
    });
    // "+ Add department" row: listeners are delegated on the panel (not the input/
    // button directly) because renderDeptDropdown replaces panel.innerHTML on every
    // rerender, which would otherwise orphan a directly-bound listener.
    var submitNewDept = function(){
      var input = el('#' + prefix + 'AddInput');
      if(!input) return;
      var name = input.value.trim();
      if(!name) return;
      var ok = addDepartment(name);
      if(ok){
        onToggle(name);
        rerender();
        // The rerender rebuilt the add input — refocus the fresh one so
        // adding several departments in a row stays fluid.
        var fresh = el('#' + prefix + 'AddInput');
        if(fresh) fresh.focus();
      } else {
        showDeptHint(prefix, 'Already exists');
      }
    };
    panel.addEventListener('click', function(e){
      if(e.target.closest('#' + prefix + 'AddBtn')) submitNewDept();
    });
    panel.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && e.target.closest('#' + prefix + 'AddInput')){
        e.preventDefault();
        submitNewDept();
      }
    });
  }
  document.addEventListener('click', function(e){
    // A click the panel itself consumed (the "+ Add" button) re-renders the
    // panel, detaching e.target before this bubbled handler runs — contains()
    // then reads false and slammed the dropdown shut on every successful add,
    // which read as "adding a department does nothing". Detached target =
    // the dropdown already handled it; never treat that as an outside click.
    if(e.target && !e.target.isConnected) return;
    els('.bench-dept-dropdown.open').forEach(function(dd){
      if(!dd.contains(e.target)) dd.classList.remove('open');
    });
  });

  function matchBenchKind(text){
    var p = String(text || '').toLowerCase();
    var best = null, hits = 0;
    BENCH_KINDS.forEach(function(k){
      var h = k.words.filter(function(w){ return p.indexOf(w) !== -1; }).length;
      if(h > hits){ best = k; hits = h; }
    });
    return hits > 0 ? best : null;
  }
  function benchKind(){
    return matchBenchKind(cinema.prompt) || BENCH_FALLBACK_KIND;
  }
  function suggestedInstructionsFor(text){
    var k = matchBenchKind(text);
    if(k) return k.schedule + ', review ' + k.reads + ' and ' + k.outcome + '. Flag anything that needs a human.';
    var t = String(text || '').trim();
    if(!t) return 'Review the relevant records on a regular schedule and flag anything that needs a human.';
    var s = t.charAt(0).toUpperCase() + t.slice(1);
    if(!/[.!?]$/.test(s)) s += '.';
    return s + ' Flag anything that needs a human.';
  }
  function benchShortPrompt(){
    var p = cinema.prompt.trim();
    return p.length > 64 ? p.slice(0, 64).replace(/\s+\S*$/, '') + '…' : p;
  }
  function benchStepDefs(){
    var k = benchKind();
    return [
      {label:'Reading what you asked for', detail:'Understood: ' + benchShortPrompt(), ms:750},
      {label:'Choosing the data it needs', detail:k.reads, ms:950},
      {label:'Setting permissions', detail:k.access.join(' · ') + ' — read only', ms:800},
      {label:'Writing its instructions', detail:'14 rules, including when to stay quiet', ms:1000},
      {label:'Running a first test', detail:'Live against your Q3 data', ms:1250}
    ];
  }

  function clearCinemaTimers(){ cinema.timers.forEach(clearTimeout); cinema.timers = []; }

  function clearCinemaBuildDeadline(){
    if(cinema.buildTimeoutTimer) clearTimeout(cinema.buildTimeoutTimer);
    cinema.buildTimeoutTimer = null;
  }

  function cancelCinemaBuildRequest(){
    clearCinemaBuildDeadline();
    if(cinema.buildController){
      try { cinema.buildController.abort(); } catch(error) {}
      cinema.buildController = null;
    }
  }

  function styledAgentEditPaneAvailable(){
    return STYLED_SKIN && location.hash.replace('#/', '') === 'chat';
  }

  // Styled chat uses a dedicated compact editor surface in the same right-
  // side slot as Manage Agents. The legacy bench DOM stays in its own modal
  // so the two skins never share stale ids, dark controls, or full-screen
  // test-bench chrome.
  function styledAgentStatusLabel(a){
    return {running:'Running', watch:'On watch'}[a.state] || a.state || 'Unknown';
  }

  function styledAgentStatusMeta(a){
    return [a.runs, a.last].filter(function(value){
      var text = String(value || '').trim();
      return text && text !== '—' && text.toLowerCase() !== 'never run';
    }).join(' · ');
  }

  function botRecordForStyledAgent(a){
    var serverId = String(a && (a.agentId || a.id) || '');
    return (chatWs.botRecords || []).filter(function(record){
      return String(record && record.id || '') === serverId;
    })[0] || null;
  }

  function styledAgentAutomationMarkup(a){
    var record = botRecordForStyledAgent(a);
    var automations = botAutomationList(record);
    var canAdd = !!record && automations.length < 10;
    var rows = automations.map(function(automation){
      var task = String(automation.prompt || '').trim();
      return '<button type="button" class="styled-agent-edit-automation" data-bot-id="' + esc(record.id) + '" data-automation-id="' + esc(automation.id) + '">' +
        '<span class="styled-agent-edit-automation-copy"><strong>' + esc(automation.name || 'Automation') + '</strong>' +
        '<span>' + esc(automationScheduleText(automation)) + '</span>' +
        (task ? '<span class="styled-agent-edit-automation-task">' + esc(task) + '</span>' : '') + '</span>' +
        '<span class="styled-agent-edit-automation-arrow" aria-hidden="true">&#8250;</span></button>';
    }).join('');
    if(!rows) rows = '<div class="styled-agent-edit-automation-empty">No automations yet</div>';
    return '<section class="styled-agent-edit-section styled-agent-edit-automation-section"><div class="styled-agent-edit-section-label styled-agent-edit-automation-head"><span>AUTOMATIONS · ' + automations.length + '/10</span>' +
      (canAdd ? '<button type="button" class="styled-agent-edit-automation-add" id="styledAgentAddAutomation" data-bot-id="' + esc(record.id) + '">+ Add</button>' : '') + '</div>' + rows + '</section>';
  }

  function styledAgentEditMarkup(a){
    var avatarId = a.isBuiltin ? a.agentId : a.id;
    var statusMeta = styledAgentStatusMeta(a);
    var colorMarkup = agentColorSwatchesHtml(editState.avatarColor, 'styledAgentEditColorInput', 'styled-agent-color');
    return '<div class="styled-agent-edit-surface" id="styledAgentEditSurface">' +
      '<div class="styled-agent-edit-header">' +
      '<div class="styled-agent-edit-header-copy"><span class="styled-agent-edit-eyebrow">BOT PROFILE</span>' +
          '<div class="styled-agent-edit-title-row"><span class="styled-agent-edit-avatar" id="styledAgentEditAvatar">' + agentAvatarHtml(editState.name || a.name, avatarId, 42, null, editState.avatarColor) + '</span>' +
            '<div class="styled-agent-edit-title-copy"><input type="text" id="styledAgentEditName" class="styled-agent-edit-name" maxlength="40" value="' + esc(editState.name || a.name) + '" aria-label="Bot name" />' +
              '<div class="styled-agent-edit-status"><span class="styled-agent-status-dot ' + esc(a.state) + '"></span>' + esc(styledAgentStatusLabel(a)) + (statusMeta ? '<span class="styled-agent-edit-meta">' + esc(statusMeta) + '</span>' : '') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="cip-pane-btn styled-agent-edit-close" id="styledAgentEditClose" aria-label="Close agent editor" title="Close agent editor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg></button>' +
      '</div>' +
      '<div class="styled-agent-edit-body">' +
        '<section class="styled-agent-edit-section"><div class="styled-agent-edit-label-row"><span class="styled-agent-edit-section-label">BRIEF</span><span class="styled-agent-edit-info-wrap"><button type="button" class="styled-agent-edit-info" data-agent-info-trigger aria-expanded="false" aria-controls="styledAgentEditBriefInfo" aria-label="Brief information" title="Brief information">i</button><span class="styled-agent-edit-info-popover" id="styledAgentEditBriefInfo" role="tooltip">Describe what this bot should do and when it should flag something for a human.</span></span></div><textarea id="styledAgentEditInstructions" class="styled-agent-edit-textarea" aria-label="Bot brief"></textarea></section>' +
        styledAgentAutomationMarkup(a) +
        '<section class="styled-agent-edit-section"><div class="styled-agent-edit-label-row"><span class="styled-agent-edit-section-label">WORKPLACES</span><span class="styled-agent-edit-info-wrap"><button type="button" class="styled-agent-edit-info" data-agent-info-trigger aria-expanded="false" aria-controls="styledAgentEditWorkplacesInfo" aria-label="Workplaces information" title="Workplaces information">i</button><span class="styled-agent-edit-info-popover" id="styledAgentEditWorkplacesInfo" role="tooltip">The workplace this bot belongs to. In multiplayer you can share it with the people in your workplace.</span></span></div><div class="styled-agent-edit-select styled-agent-edit-workspace" id="styledAgentEditWorkspace">' + esc(workspaceLabel()) + '</div></section>' +
        '<section class="styled-agent-edit-section"><div class="styled-agent-edit-label-row"><span class="styled-agent-edit-section-label">AVATAR COLOR</span><span class="styled-agent-edit-info-wrap"><button type="button" class="styled-agent-edit-info" data-agent-info-trigger aria-expanded="false" aria-controls="styledAgentEditAvatarInfo" aria-label="Avatar color information" title="Avatar color information">i</button><span class="styled-agent-edit-info-popover" id="styledAgentEditAvatarInfo" role="tooltip">Automatic follows the bot identity.</span></span></div><div class="styled-agent-edit-color-control"><div class="styled-agent-color-options" id="styledAgentEditColorOptions" role="group" aria-label="Bot avatar color">' + colorMarkup + '</div></div></section>' +
        '<section class="styled-agent-edit-section styled-agent-edit-model-section"><div class="styled-agent-edit-section-label">MODEL</div>' +
          '<div class="styled-agent-model-picker" id="styledAgentModelPicker"><button type="button" class="styled-agent-edit-model" id="styledAgentEditModel" aria-haspopup="dialog" aria-expanded="false" aria-label="Choose bot model"><span id="styledAgentEditModelLabel">' + esc(styledAgentModelLabel(editState.model || a.model)) + '</span><span aria-hidden="true">&#8250;</span></button>' +
            '<div class="cc-model-menu styled-agent-model-menu" id="styledAgentModelMenu"><div class="cc-model-menu-head"><button type="button" class="cc-model-back" id="styledAgentModelBack" aria-label="Back" title="Back" hidden>&#8249;</button><div class="cc-model-menu-title" id="styledAgentModelTitle">Choose a model family</div></div><div class="cc-model-options" id="styledAgentModelOptions">' + styledAgentModelMenuOptionsHtml() + '</div><div class="cc-model-selection" id="styledAgentModelSummary">' + esc(editState.model || a.model || 'No model selected') + '</div></div></div></section>' +
      '</div>' +
      '<div class="styled-agent-edit-footer"><button type="button" class="styled-agent-edit-delete" id="styledAgentEditDelete">Delete bot</button><span class="styled-agent-edit-footer-spacer"></span><button type="button" class="styled-agent-edit-cancel" id="styledAgentEditCancel">Cancel</button><button type="button" class="styled-agent-edit-save" id="styledAgentEditSave">Save changes</button></div>' +
    '</div>';
  }

  function renderStyledAgentEditColorControls(){
    var options = el('#styledAgentEditColorOptions');
    if(!options) return;
    options.innerHTML = agentColorSwatchesHtml(editState.avatarColor, 'styledAgentEditColorInput', 'styled-agent-color');
  }

  function wireStyledAgentEditControls(pane){
    var name = el('#styledAgentEditName', pane);
    var instructions = el('#styledAgentEditInstructions', pane);
    var close = el('#styledAgentEditClose', pane);
    var cancel = el('#styledAgentEditCancel', pane);
    var save = el('#styledAgentEditSave', pane);
    var remove = el('#styledAgentEditDelete', pane);
    var model = el('#styledAgentEditModel', pane);
    var modelWrap = el('#styledAgentModelPicker', pane);
    var modelMenu = el('#styledAgentModelMenu', pane);
    var modelBack = el('#styledAgentModelBack', pane);
    var modelOptions = el('#styledAgentModelOptions', pane);
    var automations = els('[data-bot-id][data-automation-id]', pane);
    var addAutomation = el('#styledAgentAddAutomation', pane);
    els('[data-agent-info-trigger]', pane).forEach(function(trigger){
      trigger.addEventListener('click', function(e){
        e.stopPropagation();
        var wrap = trigger.closest('.styled-agent-edit-info-wrap');
        var shouldOpen = wrap && !wrap.classList.contains('open');
        els('.styled-agent-edit-info-wrap', pane).forEach(function(other){
          other.classList.remove('open');
          var otherTrigger = el('[data-agent-info-trigger]', other);
          if(otherTrigger) otherTrigger.setAttribute('aria-expanded', 'false');
        });
        if(wrap){
          wrap.classList.toggle('open', shouldOpen);
          trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        }
      });
    });
    var colors = el('#styledAgentEditColorOptions', pane);
    if(name) name.addEventListener('input', function(e){
      editState.name = e.target.value;
      var avatar = el('#styledAgentEditAvatar', pane);
      var a = findBenchAgent(editState.agentId);
      if(avatar && a) avatar.innerHTML = agentAvatarHtml(editState.name || a.name, a.isBuiltin ? a.agentId : a.id, 42, null, editState.avatarColor);
    });
    if(instructions) instructions.addEventListener('input', function(e){ editState.instructions = e.target.value; });
    if(close) close.addEventListener('click', closeCinema);
    if(cancel) cancel.addEventListener('click', closeCinema);
    if(save) save.addEventListener('click', saveEditCinema);
    if(remove) remove.addEventListener('click', deleteEditCinemaAgent);
    if(model) model.addEventListener('click', function(e){
      e.stopPropagation();
      var opening = modelMenu && !modelMenu.classList.contains('open');
      if(modelMenu) modelMenu.classList.toggle('open', opening);
      model.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if(opening) renderStyledAgentModelPicker();
    });
    if(modelBack) modelBack.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      styledAgentModelPicker.stage = 'family';
      styledAgentModelPicker.familyKey = '';
      renderStyledAgentModelPicker();
    });
    if(modelOptions) modelOptions.addEventListener('click', function(e){
      var family = e.target.closest('[data-styled-agent-family]');
      var choice = e.target.closest('[data-styled-agent-model]');
      if(family){
        styledAgentModelPicker.stage = 'variant';
        styledAgentModelPicker.familyKey = family.getAttribute('data-styled-agent-family');
        renderStyledAgentModelPicker();
      } else if(choice){
        editState.model = choice.getAttribute('data-styled-agent-model');
        editState.modelIx = Math.max(0, BENCH_MODELS.indexOf(editState.model));
        styledAgentModelPicker.stage = 'family';
        styledAgentModelPicker.familyKey = '';
        renderStyledAgentModelPicker();
        closeStyledAgentModelPickerMenu();
      }
    });
    if(modelWrap){
      modelWrap.addEventListener('click', function(e){ e.stopPropagation(); });
      modelWrap.addEventListener('keydown', function(e){ if(e.key === 'Escape'){ e.preventDefault(); closeStyledAgentModelPickerMenu(); model.focus(); } });
    }
    if(chatModelPicker && typeof chatModelPicker.ensureLoaded === 'function') chatModelPicker.ensureLoaded();
    automations.forEach(function(automation){ automation.addEventListener('click', function(){
      var botId = automation.getAttribute('data-bot-id');
      var automationId = automation.getAttribute('data-automation-id');
      if(botId && automationId) openAutomationDetail(botId, automationId);
    }); });
    if(addAutomation) addAutomation.addEventListener('click', function(){
      var botId = addAutomation.getAttribute('data-bot-id');
      if(botId) openAutomationDetail(botId, null, true);
    });
    if(colors) {
      colors.addEventListener('click', function(e){
        var button = e.target.closest('[data-agent-color]');
        if(!button) return;
        editState.avatarColor = normalizeAgentAvatarColor(button.getAttribute('data-agent-color'));
        renderStyledAgentEditColorControls();
        var a = findBenchAgent(editState.agentId), avatar = el('#styledAgentEditAvatar', pane);
        if(avatar && a) avatar.innerHTML = agentAvatarHtml(editState.name || a.name, a.isBuiltin ? a.agentId : a.id, 42, null, editState.avatarColor);
      });
      colors.addEventListener('change', function(e){
        if(!e.target || e.target.id !== 'styledAgentEditColorInput') return;
        editState.avatarColor = normalizeAgentAvatarColor(e.target.value);
        renderStyledAgentEditColorControls();
        var a = findBenchAgent(editState.agentId), avatar = el('#styledAgentEditAvatar', pane);
        if(avatar && a) avatar.innerHTML = agentAvatarHtml(editState.name || a.name, a.isBuiltin ? a.agentId : a.id, 42, null, editState.avatarColor);
      });
    }
  }

  function renderStyledAgentEditPane(pane){
    var a = findBenchAgent(editState.agentId);
    if(!pane || !a) return;
    pane.setAttribute('aria-label', 'Edit bot');
    pane.classList.remove('plugins-open', 'agents-open', 'bot-store-open');
    pane.classList.add('open', 'agent-edit-open');
    if(!el('#styledAgentEditSurface', pane)){
      pane.innerHTML = styledAgentEditMarkup(a);
      var instructions = el('#styledAgentEditInstructions', pane);
      if(instructions) instructions.value = editState.instructions || '';
      var remove = el('#styledAgentEditDelete', pane);
      if(remove) remove.style.display = (a.isBuiltin && !a.agentId) ? 'none' : '';
      wireStyledAgentEditControls(pane);
    }
  }

  function openCinema(origin){
    cinema.mode = 'compose';
    cinema.origin = origin || 'bench';
    fetchBenchExamplesOnce();
    // Every open starts a fresh setup. State was already reset by
    // closeCinema, but the DOM fields kept their old values (nothing ever
    // wrote state back into them on open) — so the previous prompt/name
    // reappeared on the next "New agent".
    cinema.prompt = ''; cinema.name = '';
    cinema.departments = guessDepartmentsFor('');
    cinema.departmentsTouched = false;
    el('#benchComposeTextarea').value = '';
    el('#benchNameInput').value = '';
    renderCinema();
    document.body.classList.add('cinema-open');
    el('#benchCinema').classList.add('open');
    el('#benchComposeTextarea').focus();
  }
  function closeCinema(){
    if(cinema.mode === 'building'){
      cancelBenchBuild(true);
      return;
    }
    cancelCinemaBuildRequest();
    var styledEditOpen = STYLED_SKIN && chatInfo.mode === 'agent-edit';
    if(styledEditOpen){
      chatInfo.mode = 'automations';
      chatInfo.open = false;
      document.body.classList.remove('cinema-open');
      var infoPane = el('#chatInfoPane');
      if(infoPane){ infoPane.classList.remove('open', 'agent-edit-open'); infoPane.innerHTML = ''; }
      syncSidebarToolButtons();
      returnAgentEditFocus();
    }
    clearCinemaTimers();
    clearTimeout(cinema.nameSuggestTimer);
    cinema.nameSuggestTimer = null; cinema.nameSuggestKey = null;
    cinema.mode = 'idle'; cinema.prompt = ''; cinema.name = ''; cinema.created = null;
    cinema.origin = 'bench';
    cinema.buildAttempt += 1; cinema.buildStatus = 'idle'; cinema.buildError = ''; cinema.buildTimedOut = false;
    cinema.departments = []; cinema.departmentsTouched = false;
    editState = {agentId:null, isBuiltin:false, instructions:'', instructionsRevision:null, model:'', modelIx:0, departments:[], avatarColor:'', suggestion:'', suggestDismissed:false,
      testScopes:[], testRuns:[], testBusy:false, removedImprovements:[]};
    el('#benchCinemaInner').classList.remove('wide');
    if(typeof document !== 'undefined' && document.body) document.body.classList.remove('cinema-open');
    el('#benchCinema').classList.remove('open');
  }

  // Debounced LLM name suggestion for the create cinema: fires once ~1.5s
  // after typing settles, never blocks Create. Keyed to the settled prompt
  // text (same "stale response" guard shape as updateChatSuggestions' key)
  // so a response that lands after the user kept typing — or after they
  // closed/reopened the cinema — is dropped rather than clobbering newer
  // state. Only applies when #benchNameInput is still empty: that's true
  // both when nothing has landed yet and when the user has typed their own
  // name (an earlier applied suggestion, or a manual name, both leave the
  // field non-empty), so no separate "user touched it" flag is needed.
  var BENCH_NAME_SUGGEST_DEBOUNCE_MS = 1500;
  function scheduleNameSuggestion(){
    clearTimeout(cinema.nameSuggestTimer);
    var text = cinema.prompt.trim();
    if(!text) return;
    cinema.nameSuggestTimer = setTimeout(function(){
      var key = text;
      cinema.nameSuggestKey = key;
      api('/api/bots/suggest-name', {method:'POST', body:{instructions: key}}).then(function(res){
        if(cinema.mode !== 'compose' || cinema.nameSuggestKey !== key) return;
        var name = res.status === 200 && res.data && res.data.name;
        if(!name) return;
        var input = el('#benchNameInput');
        if(!input || input.value.trim()) return;
        cinema.name = name;
        input.value = name;
        // Never steal focus/selection from wherever the user actually is
        // (in practice: still composing in the textarea) — just flash the
        // field so the suggestion is noticed without yanking the cursor.
        input.classList.remove('bench-name-suggested');
        void input.offsetWidth; // restart the animation if it fired before
        input.classList.add('bench-name-suggested');
        renderCinema();
      }).catch(function(){});
    }, BENCH_NAME_SUGGEST_DEBOUNCE_MS);
  }

  function openEditCinema(id){
    var a = findBenchAgent(id);
    if(!a) return;
    var text = a.instructions || (a.isBuiltin ? a.brief : '') || '';
    text = String(text).replace(/\n?\s*Automation:\s*[^\n]*$/i, '').trim();
    var modelIx = BENCH_MODELS.indexOf(a.model);
    var k = matchBenchKind(text) || BENCH_FALLBACK_KIND;
    var currentDepts = agentDepartments(a);
    styledAgentModelPicker = {stage:'family', familyKey:''};
    editState = {
      agentId: id, isBuiltin: a.isBuiltin, name: a.name,
      instructions: text, instructionsRevision: a.instructionsRevision, model: a.model || selectedConnectedBotModel(), modelIx: modelIx === -1 ? 0 : modelIx,
      departments: currentDepts.length ? currentDepts.slice() : guessDepartmentsFor(text),
      avatarColor: normalizeAgentAvatarColor(a.avatarColor),
      suggestion: suggestedInstructionsFor(text), suggestDismissed: false,
      testScopes: k.access.slice(), testRuns: [], testBusy: false, removedImprovements: []
    };
    editState.testRuns.push(buildTestRun(k, k.sample.task, editState.testScopes));
    cinema.mode = 'edit';
    if(styledAgentEditPaneAvailable()){
      prepareChatUtilityPane('agent-edit');
      renderChatInfoPane();
      document.body.classList.add('cinema-open');
      var styledInstructions = el('#styledAgentEditInstructions');
      if(styledInstructions) styledInstructions.focus();
      return;
    }
    renderCinema();
    el('#benchEditTextarea').value = text;
    renderBenchTest();
    el('#benchCinemaInner').classList.add('wide');
    document.body.classList.add('cinema-open');
    el('#benchCinema').classList.add('open');
    el('#benchEditTextarea').focus();
  }

  function saveEditCinema(){
    var a = findBenchAgent(editState.agentId);
    if(!a) return;
    var instructions = editState.instructions.trim();
    if(!instructions) return;
    var model = editState.model || BENCH_MODELS[editState.modelIx];
    if(!model){ showBenchToast('Connect and choose a model before saving'); return; }
    var name = String(editState.name || '').trim() || a.name;
    var styledEditOpen = STYLED_SKIN && chatInfo.mode === 'agent-edit';
    var reopenAndClose = function(){
      closeCinema();
      loadBenchAgents().then(function(){
        renderChatSidebar();
        refreshChatMain();
        // Saving is a completed action: close the drawer and confirm with
        // the standard bottom toast instead of reopening the editor.
        if(styledEditOpen) showBenchToast('Changes to Bot "' + name + '" saved');
        else openBenchDetail(a.id);
      });
    };
    var targetId = a.isBuiltin ? a.agentId : a.id;
    if(!targetId) return;
    // The styled editor no longer edits departments (a MiaOS leftover); the
    // stored value stays untouched by omitting the key from the update.
    api('/api/bots/' + targetId, {method:'PUT', body:{name: name, instructions: instructions, expectedInstructionsRevision: editState.instructionsRevision, model: model, avatarColor: editState.avatarColor || null}}).then(function(res){
      if(res.status === 200) reopenAndClose();
      else if(res.status === 409) showBenchToast('Instructions changed on disk. Reload the bot before saving.');
    }).catch(function(){});
  }

  // Shared swatch-grid markup for the Edit-agent cinema and compact Manage
  // Agents menu. The palette and data attributes stay identical so both
  // surfaces use the same validated color values.
  function agentColorSwatchesHtml(currentColor, colorInputId, classPrefix){
    classPrefix = classPrefix || 'bench-agent-color';
    var current = normalizeAgentAvatarColor(currentColor);
    var html = '<button type="button" class="' + classPrefix + '-swatch automatic' + (!current ? ' selected' : '') + '" data-agent-color="" aria-label="Use automatic color" aria-pressed="' + (!current ? 'true' : 'false') + '" title="Automatic color">' +
      '<span class="' + classPrefix + '-auto-mark">A</span></button>';
    html += AGENT_COLOR_OPTIONS.map(function(option){
      var selected = current === option.value;
      return '<button type="button" class="' + classPrefix + '-swatch' + (selected ? ' selected' : '') + '" data-agent-color="' + option.value + '" aria-label="' + esc(option.label) + '" aria-pressed="' + (selected ? 'true' : 'false') + '" title="' + esc(option.label) + '" style="--agent-color:' + option.value + '"></button>';
    }).join('');
    html += '<label class="' + classPrefix + '-custom" title="Choose a custom color"><span>Custom</span><input type="color" id="' + colorInputId + '" value="' + (current || AGENT_COLOR_OPTIONS[0].value) + '" aria-label="Custom agent color" /></label>';
    return html;
  }

  function renderAgentColorPicker(){
    var wrap = el('#benchEditColorOptions');
    if(!wrap) return;
    wrap.innerHTML = agentColorSwatchesHtml(editState.avatarColor, 'benchEditColorInput');
  }

  function removeDeletedBotChatState(botId){
    if(typeof chatWs === 'undefined' || !chatWs) return false;
    var targetId = String(botId || '');
    var deletedRoomIds = [];
    (chatWs.nativeConversations || []).forEach(function(conversation){
      var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
        ? conversation.metadata : {};
      if(conversation && conversation.type === 'bot' && String(metadata.botId || '') === targetId){
        deletedRoomIds.push(String(conversation.id));
      }
    });
    (chatWs.allAgents || []).forEach(function(agent){
      if(String(agent && agent.id || '') !== targetId) return;
      var roomId = agent.roomId || agent.nativeConversationId || agent.conversationId;
      if(roomId && deletedRoomIds.indexOf(String(roomId)) === -1) deletedRoomIds.push(String(roomId));
    });
    var wasActive = deletedRoomIds.indexOf(String(chatWs.activeRoomId || '')) !== -1;
    deletedRoomIds.forEach(function(roomId){
      var state = chatWs.byRoom && chatWs.byRoom[roomId];
      if(state && state.thinkingTimer) clearTimeout(state.thinkingTimer);
      if(chatWs.byRoom) delete chatWs.byRoom[roomId];
      delete chatAttentionRooms[roomId];
    });
    chatWs.nativeConversations = (chatWs.nativeConversations || []).filter(function(conversation){
      return deletedRoomIds.indexOf(String(conversation && conversation.id || '')) === -1;
    });
    chatWs.hiddenChats = (chatWs.hiddenChats || []).filter(function(key){ return key !== 'agent:' + targetId; });
    delete chatPinnedKeys['agent:' + targetId];
    saveChatAttention();
    saveChatPinned();
    applyNativeConversationList(chatWs.nativeConversations);
    if(chatNavigation.back && deletedRoomIds.indexOf(String(chatNavigation.back.roomId || '')) !== -1) clearChatBack();
    if(wasActive){
      closeNativeChatSocket();
      closeChatThread();
      clearChatBack();
      chatWs.activeRoomId = null;
      chatWs.activeKind = null;
      chatWs.activeLabel = '';
      saveActiveChatLocation(null);
      refreshChatMain();
    }
    renderChatSidebar();
    return wasActive;
  }

  function deleteBenchAgent(a, onDeleted){
    if(!a){ showBenchToast('Bot details are still loading'); return; }
    // Legacy builtin records are ordinary persisted bots and remain deletable.
    var targetId = a.isBuiltin ? a.agentId : a.id;
    if(!targetId){ showBenchToast('This bot has no server record to delete'); return; }
    appConfirm('Delete ' + a.name + '?').then(function(ok){
      if(!ok) return;
      api('/api/bots/' + targetId, {method:'DELETE'}).then(function(res){
        if(res.status === 200){
          removeDeletedBotChatState(targetId);
          if(onDeleted) onDeleted();
          loadBenchAgents().then(refreshAgentsView);
        }
        else showBenchToast('Delete failed (' + res.status + ')');
      }).catch(function(){ showBenchToast('Delete failed — network error'); });
    });
  }

  function duplicateBenchAgent(a){
    if(!a) return;
    var instructions = String(a.instructions || a.brief || '').trim();
    if(!instructions){ showBenchToast('This bot has no brief to duplicate'); return; }
    var name = (String(a.name || 'Bot').trim() || 'Bot') + ' copy';
    api('/api/bots', {method:'POST', body:{
      name: name.slice(0, 40), instructions: instructions,
      model: a.model || selectedConnectedBotModel(), departments: agentDepartments(a),
      status: 'watch', automation: {enabled:false, frequency:'none', day:'', time:''},
      replyAlways: false
    }}).then(function(res){
      if(res.status !== 201 || !res.data || !res.data.bot) throw new Error('duplicate failed');
      return loadBenchAgents();
    }).then(function(){
      return loadAgents();
    }).then(function(apiAgents){
      syncChatBotRecords(apiAgents);
      renderChatSidebar();
      refreshAgentsView();
      showBenchToast('Duplicated ' + a.name + ' on watch');
    }).catch(function(){ showBenchToast('Could not duplicate ' + a.name); });
  }

  function copySidebarText(value, successMessage){
    var text = String(value || '');
    if(!text) return Promise.resolve(false);
    function done(copied){
      if(copied && successMessage) showBenchToast(successMessage);
      return copied;
    }
    function legacyCopy(){
      var input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch(err) {}
      input.remove();
      return done(copied);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text).then(function(){ return done(true); }).catch(legacyCopy);
    }
    return Promise.resolve(legacyCopy());
  }

  function deleteEditCinemaAgent(){
    var a = findBenchAgent(editState.agentId);
    if(!a) return;
    deleteBenchAgent(a, closeCinema);
  }

  function renderEditCinema(){
    var a = findBenchAgent(editState.agentId);
    if(!a) return;
    renderDeptDropdown('benchEditDept', loadDepartments(), editState.departments);
    renderAgentColorPicker();
    el('#benchEditTitle').textContent = 'Tune ' + a.name;
    var statusLabel = {running:'running', watch:'on watch'}[a.state] || a.state;
    var currentModel = editState.model || BENCH_MODELS[editState.modelIx] || 'No connected model';
    // The name in the snapshot pill IS the rename field (there was nowhere to
    // "name it later" until this) — editState.name survives re-renders; the
    // input is re-created each render so its value comes from state, and the
    // input listener is delegated on the pill container (bound once, below).
    el('#benchEditSnapshot').innerHTML =
      '<span class="bench-mark bench-edit-avatar-preview">' + agentAvatarHtml(editState.name || a.name, a.isBuiltin ? a.agentId : a.id, 26, null, editState.avatarColor) + '</span>' +
      '<input type="text" class="bench-edit-snap-pill-name bench-edit-name-input" id="benchEditNameInput" maxlength="40" value="' + esc(editState.name || a.name) + '" title="Click to rename" />' +
      '<span class="bench-pill ' + a.state + '">' + esc(statusLabel.toUpperCase()) + '</span>' +
      '<span class="bench-edit-snap-pill-meta">' + esc(a.runs) + ' &middot; ' + esc(a.last) + '</span>';
    el('#benchEditModelLabel').textContent = currentModel;
    el('#benchEditModelRecTag').innerHTML = '';
    // Builtins are deletable now too — hide the button only when there's no
    // server row behind the card (nothing to delete; pre-seed edge case).
    el('#benchEditDeleteBtn').style.display = (a.isBuiltin && !a.agentId) ? 'none' : '';

    var suggestEl = el('#benchEditSuggest');
    if(editState.suggestDismissed){
      suggestEl.style.display = 'none';
    } else {
      suggestEl.style.display = '';
      var fromRuns = a.runs && a.runs !== '—' ? ' &middot; FROM ' + esc(a.runs.toUpperCase()) : '';
      suggestEl.innerHTML =
        '<div class="bench-suggest-label">MIA SUGGESTS' + fromRuns + '</div>' +
        '<div class="bench-suggest-text">' + esc(editState.suggestion) + '</div>' +
        '<div class="bench-suggest-actions">' +
          '<button type="button" class="bench-suggest-use-btn" id="benchEditUseSuggestBtn">Apply to brief</button>' +
          '<button type="button" class="bench-suggest-dismiss-btn" id="benchEditDismissSuggestBtn">Dismiss</button>' +
        '</div>';
      el('#benchEditUseSuggestBtn').addEventListener('click', function(){
        editState.instructions = editState.suggestion;
        el('#benchEditTextarea').value = editState.suggestion;
      });
      el('#benchEditDismissSuggestBtn').addEventListener('click', function(){
        editState.suggestDismissed = true;
        renderEditCinema();
      });
    }
  }

  /* honest simulation only — nothing here actually executes the agent, everything below is canned */
  function buildTestRun(k, task, scopes){
    return {task: task, scopes: scopes.slice(), flaggedNow: k.sample.flaggedNow, flaggedBefore: k.sample.flaggedBefore,
      rows: k.sample.rows, footnote: k.sample.footnote};
  }
  function renderTestRun(run){
    return '<div class="bench-test-run">' +
      '<div class="bench-test-task-row"><span class="bench-test-task-icon">&rsaquo;</span>' +
      '<span class="bench-test-task-text">' + esc(run.task) + ' &mdash; used ' + esc(run.scopes.join(', ')) + '</span></div>' +
      '<div class="bench-test-result">' +
        '<div class="bench-test-result-stats">' +
          '<div class="bench-test-result-stat now"><div class="lbl">FLAGGED NOW</div><div class="val">' + esc(run.flaggedNow) + '</div></div>' +
          '<div class="bench-test-result-stat before"><div class="lbl">BEFORE YOUR EDIT</div><div class="val">' + esc(run.flaggedBefore) + '</div></div>' +
        '</div>' +
        '<div class="bench-test-result-body">' +
          run.rows.map(function(r){
            return '<div class="bench-test-result-row"><span class="bench-test-result-score">' + esc(r.score) + '</span>' +
              '<span class="bench-test-result-desc">' + esc(r.desc) + '</span>' +
              '<span class="bench-test-result-tag">' + esc(r.tag) + '</span></div>';
          }).join('') +
          '<div class="bench-test-result-footnote"><span class="bench-test-result-footnote-bar"></span>' +
          '<span class="bench-test-result-footnote-text">' + esc(run.footnote) + '</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function renderTestImprovements(k){
    var rows = k.improvements.filter(function(_, ix){ return editState.removedImprovements.indexOf(ix) === -1; });
    if(!rows.length) return '';
    return '<div class="bench-test-improve">' +
      '<div class="bench-test-improve-label">SELF-IMPROVEMENT OF LAST 7 DAYS</div>' +
      k.improvements.map(function(imp, ix){
        if(editState.removedImprovements.indexOf(ix) !== -1) return '';
        return '<div class="bench-test-improve-row" data-improve-ix="' + ix + '">' +
          '<span class="bench-test-improve-date">' + esc(imp.date) + '</span>' +
          '<span class="bench-test-improve-text">' + esc(imp.text) + '</span>' +
          '<button type="button" class="bench-test-improve-undo" data-undo-ix="' + ix + '">Undo</button>' +
        '</div>';
      }).join('') +
    '</div>';
  }
  function renderBenchTest(){
    var k = matchBenchKind(editState.instructions) || BENCH_FALLBACK_KIND;
    var wrap = el('#benchTestMessages');
    var html = editState.testRuns.map(renderTestRun).join('');
    if(editState.testBusy) html += '<div class="bench-test-thinking">Mia is thinking&hellip;</div>';
    html += renderTestImprovements(k);
    wrap.innerHTML = html || '<div class="bench-test-empty">Type a sample task to preview how this bot would respond.</div>';
    wrap.scrollTop = wrap.scrollHeight;
  }
  function runBenchTest(){
    var input = el('#benchTestInput');
    var text = input.value.trim();
    if(!text || editState.testBusy) return;
    input.value = '';
    editState.testBusy = true;
    el('#benchTestSendBtn').disabled = true;
    renderBenchTest();
    setTimeout(function(){
      var k = matchBenchKind(editState.instructions) || BENCH_FALLBACK_KIND;
      editState.testRuns.push(buildTestRun(k, text, editState.testScopes));
      editState.testBusy = false;
      el('#benchTestSendBtn').disabled = false;
      renderBenchTest();
    }, 900);
  }

  function renderCinema(){
    var isCompose = cinema.mode === 'compose', isBuilding = cinema.mode === 'building', isBuildError = cinema.mode === 'build-error', isReady = cinema.mode === 'ready', isEdit = cinema.mode === 'edit';
    el('#benchComposeStep').style.display = isCompose ? '' : 'none';
    el('#benchBuildStep').style.display = (isBuilding || isBuildError) ? '' : 'none';
    el('#benchReadyStep').style.display = isReady ? '' : 'none';
    el('#benchEditStep').style.display = isEdit ? '' : 'none';
    if(isEdit) renderEditCinema();
    if(isBuildError) renderBuildRecovery();

    if(isCompose){
      var k = benchKind();
      var hasPrompt = cinema.prompt.trim().length > 3;
      if(!cinema.departmentsTouched) cinema.departments = guessDepartmentsFor(cinema.prompt);
      renderDeptDropdown('benchDept', loadDepartments(), cinema.departments);
      // Do not guess access scopes before the user explicitly configures them.
      el('#benchScopesRow').innerHTML = '';
      el('#benchNameInput').placeholder = hasPrompt ? k.name : 'Name your bot';
      var model = selectedConnectedBotModel();
      el('#benchModelLabel').textContent = model || 'No connected model';
      var createBtn = el('#benchCreateBtn');
      var canCreate = hasPrompt && !!cinema.name.trim() && !!model;
      createBtn.disabled = !canCreate;
      createBtn.style.background = canCreate ? 'var(--dk-orange)' : 'var(--dk-border)';
      createBtn.style.color = canCreate ? '#FFFFFF' : 'var(--dk-faint)';
      el('#benchCinemaExamples').innerHTML = currentBenchExamples().map(function(label){
        return '<button type="button" class="bench-cinema-chip" data-example="' + esc(label) + '">' + esc(label) + '</button>';
      }).join('');
      els('[data-example]', el('#benchCinemaExamples')).forEach(function(chip){
        chip.addEventListener('click', function(){
          cinema.prompt = chip.getAttribute('data-example');
          el('#benchComposeTextarea').value = cinema.prompt;
          renderCinema();
        });
      });
    }

    if(isReady && cinema.created){
      var c = cinema.created;
      el('#benchReadyTitle').textContent = c.name + ' is ready';
      el('#benchReadyRows').innerHTML = [
        {label:'WHAT IT WATCHES', value:c.reads},
        {label:'WHEN IT RUNS', value:c.schedule},
        {label:'DATA ACCESS', value:c.access.join(', ') + ' · read only'},
        {label:'MODEL', value:c.model}
      ].map(function(r){ return '<div class="bench-ready-row"><div class="bench-ready-row-label">' + r.label + '</div><div class="bench-ready-row-value">' + esc(r.value) + '</div></div>'; }).join('');
      el('#benchReadyFinding').textContent = c.finding;
    }
  }

  function renderBuildStep(step, defs){
    var done = step >= defs.length;
    el('#benchBuildTitle').textContent = done ? 'Almost there' : 'Building your bot';
    el('#benchBuildSub').textContent = done ? 'Finishing the first test run' : (defs[Math.max(step, 0)] || {}).label || '';
    el('#benchBuildCounter').textContent = Math.min(step + 1, defs.length) + ' / ' + defs.length;
    el('#benchBuildProgressBar').style.width = Math.round(Math.min(step / defs.length, 1) * 100) + '%';
    el('#benchSteps').innerHTML = defs.map(function(s, i){
      var stepDone = i < step, working = i === step, pending = i > step;
      var iconHtml = stepDone ? '<span class="bench-step-icon-done">&#10003;</span>'
        : working ? '<span class="bench-step-icon-working"></span>'
        : '<span class="bench-step-icon-pending"></span>';
      var detailHtml = stepDone ? '<span class="bench-step-detail">' + esc(s.detail) + '</span>' : '';
      var progressHtml = working ? '<span class="bench-step-progress"><span></span></span>' : '';
      return '<div class="bench-step-row" style="opacity:' + (pending ? '0.4' : '1') + ';">' +
        '<span class="bench-step-icon-wrap">' + iconHtml + '</span>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;">' +
          '<span class="bench-step-label" style="font-weight:' + (working ? '600' : '500') + ';color:' + (pending ? 'var(--dk-muted)' : 'var(--dk-ink)') + ';">' + esc(s.label) + '</span>' +
          detailHtml +
        '</div>' + progressHtml +
      '</div>';
    }).join('');
    var cancel = el('#benchBuildCancelBtn');
    var retry = el('#benchBuildRetryBtn');
    var back = el('#benchBuildBackBtn');
    if(cancel){ cancel.hidden = false; cancel.disabled = false; cancel.textContent = 'Cancel'; }
    if(retry) retry.hidden = true;
    if(back) back.hidden = true;
  }

  function renderBuildRecovery(){
    var timedOut = cinema.buildStatus === 'timed-out';
    el('#benchBuildTitle').textContent = timedOut ? 'This is taking too long' : 'Couldn’t create your bot';
    el('#benchBuildSub').textContent = timedOut
      ? 'Nothing was created. You can try again or return to setup.'
      : (cinema.buildError || 'Nothing was created. Check the setup and try again.');
    el('#benchBuildCounter').textContent = 'Recovery';
    el('#benchBuildProgressBar').style.width = '100%';
    var cancel = el('#benchBuildCancelBtn');
    var retry = el('#benchBuildRetryBtn');
    var back = el('#benchBuildBackBtn');
    if(cancel) cancel.hidden = true;
    if(retry) retry.hidden = false;
    if(back) back.hidden = false;
  }

  function finishBenchBuildFailure(attempt, timedOut, message){
    if(attempt !== cinema.buildAttempt || cinema.mode !== 'building') return;
    cinema.buildAttempt += 1;
    clearCinemaTimers();
    cancelCinemaBuildRequest();
    cinema.buildTimedOut = timedOut;
    cinema.buildStatus = timedOut ? 'timed-out' : 'failed';
    cinema.buildError = timedOut ? '' : String(message || 'The request could not be completed.');
    cinema.mode = 'build-error';
    renderCinema();
  }

  function cancelBenchBuild(closeAfter){
    if(cinema.mode !== 'building' && cinema.mode !== 'build-error') return;
    cinema.buildAttempt += 1;
    clearCinemaTimers();
    cancelCinemaBuildRequest();
    cinema.mode = 'compose';
    cinema.buildStatus = 'idle';
    cinema.buildTimedOut = false;
    cinema.buildError = '';
    renderCinema();
    if(closeAfter) closeCinema();
  }

  function startBenchBuild(){
    if(cinema.prompt.trim().length <= 3 || !cinema.name.trim()) return;
    var selectedModel = selectedConnectedBotModel();
    if(!selectedModel){ showBenchToast('Connect and choose a model before creating a bot'); return; }
    var defs = benchStepDefs();
    cinema.buildAttempt += 1;
    var attempt = cinema.buildAttempt;
    clearCinemaTimers();
    cancelCinemaBuildRequest();
    cinema.buildTimedOut = false;
    cinema.buildStatus = 'building';
    cinema.buildError = '';
    cinema.mode = 'building';
    renderCinema();
    var step = 0;
    renderBuildStep(step, defs);
    var t = 0;
    defs.forEach(function(s, i){
      t += s.ms;
      cinema.timers.push(setTimeout(function(){ step = i + 1; renderBuildStep(step, defs); }, t));
    });
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    cinema.buildController = controller;
    cinema.buildTimeoutTimer = setTimeout(function(){
      if(attempt !== cinema.buildAttempt || cinema.mode !== 'building') return;
      if(controller) controller.abort();
      finishBenchBuildFailure(attempt, true);
    }, BENCH_BUILD_TIMEOUT_MS);
    if(cinema.buildTimeoutTimer && typeof cinema.buildTimeoutTimer.unref === 'function') cinema.buildTimeoutTimer.unref();
    cinema.timers.push(setTimeout(function(){
      if(attempt !== cinema.buildAttempt || cinema.mode !== 'building') return;
      var k = benchKind();
      var name = cinema.name.trim() || k.name;
      var instructions = cinema.prompt.trim();
      var model = selectedModel;
      var departments = cinema.departmentsTouched ? cinema.departments : guessDepartmentsFor(instructions);
      api('/api/bots', {
        method:'POST',
        ...(controller ? {signal:controller.signal} : {}),
        body:{name:name, instructions:instructions, model:model, status:'running', departments:departments}
      }).then(function(res){
        if(attempt !== cinema.buildAttempt || cinema.mode !== 'building') return;
        var createdAgent = res.data && res.data.bot;
        if(res.status !== 201 || !createdAgent) throw new Error(res.data && res.data.error || 'Bot creation failed');
        clearCinemaBuildDeadline();
        cinema.buildController = null;
        cinema.buildStatus = 'ready';
        cinema.created = Object.assign({}, k, {
          name: name, apiId: createdAgent && createdAgent.id, model: model
        });
        cinema.mode = 'ready';
        renderCinema();
      }).catch(function(error){
        if(attempt !== cinema.buildAttempt || cinema.mode !== 'building') return;
        finishBenchBuildFailure(attempt, cinema.buildTimedOut || !!(error && error.name === 'AbortError'), error && error.message);
      });
    }, t + 450));
  }

  // Minimal fixed-position toast — there's no shared toast helper elsewhere in
  // app.js yet, so this is it. Auto-dismisses; a second call replaces any toast
  // still showing rather than stacking.
  function showBenchToast(message){
    var existing = document.getElementById('benchToast');
    if(existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'benchToast';
    toast.className = 'bench-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function(){ toast.classList.add('show'); });
    setTimeout(function(){
      toast.classList.remove('show');
      setTimeout(function(){ toast.remove(); }, 250);
    }, 3200);
  }

  // Shared tail of both ready-step actions: close the cinema, reload the bench,
  // then make the new agent's landing spot unmistakable — scrolled into view,
  // pulsed, and called out in a toast. addedId is missing only if the create
  // POST itself failed (see startBenchBuild's .catch), in which case there's
  // nothing to highlight and this just closes out quietly.
  function finishBenchCreate(addedId){
    var origin = cinema.origin;
    var createdRoomId = cinema.created && cinema.created.roomId;
    var createdName = cinema.created && cinema.created.name;
    closeCinema();
    if(origin === 'chat'){
      landChatOriginAgent(addedId, createdName, createdRoomId);
      return;
    }
    loadBenchAgents().then(function(){
      refreshAgentsView();
      if(!addedId) return;
      benchJustAdded = addedId;
      refreshAgentsView();
      var card = document.querySelector('[data-agent-id="' + addedId + '"]');
      if(card) card.scrollIntoView({behavior:'smooth', block:'center'});
      showBenchToast('Bot created — find it in your bench');
      setTimeout(function(){ benchJustAdded = null; refreshAgentsView(); }, 2600);
    });
  }

  // Messages-first landing: a chat-origin create (see cinema.origin) never
  // touches the bench — it stays on #chat, refreshes the sidebar so the new
  // agent's row exists, and opens its native conversation directly when it is
  // already present in the refreshed conversation list.
  function landChatOriginAgent(addedId, name, createdRoomId){
    // The cinema is a modal overlay opened from #chatNewAgentBtn, which only
    // exists on the Messages route — so the user never left #chat while it
    // was open. No navigation needed; this just refreshes what's underneath.
    loadAgents().then(function(apiAgents){
      syncChatBotRecords(apiAgents);
      renderChatSidebar();
      if(!addedId){
        showBenchToast("Bot created — it'll appear in your Direct messages shortly");
        return;
      }
      var agent = chatWs.allAgents.filter(function(item){ return item.id === addedId; })[0];
      var roomId = createdRoomId || (agent && (agent.roomId || agent.nativeConversationId));
      if(roomId){
        clearChatActive();
        loadChatRoom(roomId, 'agent', name);
        var row = el('.chat-recent-row[data-agent-id="' + addedId + '"]');
        if(row) row.classList.add('active');
        showBenchToast('Bot created — say hi');
        return;
      }
      showBenchToast("Bot created — it'll appear in your Direct messages shortly");
    }).catch(function(){
      showBenchToast("Bot created — it'll appear in your Direct messages shortly");
    });
  }

  function startBenchAgent(){
    var addedId = cinema.created && cinema.created.apiId;
    finishBenchCreate(addedId);
  }

  el('#benchComposeTrigger').addEventListener('click', openCinema);
  var benchNewAgentBtn = el('#benchNewAgentBtn');
  if(benchNewAgentBtn) benchNewAgentBtn.addEventListener('click', openCinema);
  el('#benchCinemaScrim').addEventListener('click', function(){ closeCinema(); });
  el('#benchComposeTextarea').addEventListener('input', function(e){ cinema.prompt = e.target.value; renderCinema(); scheduleNameSuggestion(); });
  el('#benchComposeTextarea').addEventListener('keydown', function(e){
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); startBenchBuild(); }
  });
  el('#benchNameInput').addEventListener('input', function(e){ cinema.name = e.target.value; renderCinema(); });
  el('#benchModelBtn').addEventListener('click', function(){ if(BENCH_MODELS.length) cinema.modelIx = (cinema.modelIx + 1) % BENCH_MODELS.length; renderCinema(); });
  el('#benchCreateBtn').addEventListener('click', startBenchBuild);
  el('#benchBuildCancelBtn').addEventListener('click', function(){ cancelBenchBuild(false); });
  el('#benchBuildRetryBtn').addEventListener('click', startBenchBuild);
  el('#benchBuildBackBtn').addEventListener('click', function(){ cancelBenchBuild(false); });
  el('#benchStartBtn').addEventListener('click', startBenchAgent);
  el('#benchAdjustBtn').addEventListener('click', function(){ cinema.mode = 'compose'; cinema.created = null; renderCinema(); });
  el('#benchEditTextarea').addEventListener('input', function(e){ editState.instructions = e.target.value; });
  el('#benchEditModelBtn').addEventListener('click', function(){ if(BENCH_MODELS.length){ editState.modelIx = (editState.modelIx + 1) % BENCH_MODELS.length; editState.model = BENCH_MODELS[editState.modelIx]; } renderEditCinema(); });
  // Rename field lives inside the snapshot pill, whose innerHTML is replaced
  // every renderEditCinema() — delegate so the listener survives re-renders.
  el('#benchEditSnapshot').addEventListener('input', function(e){
    if(e.target && e.target.id === 'benchEditNameInput') editState.name = e.target.value;
  });
  el('#benchEditColorOptions').addEventListener('click', function(e){
    var button = e.target.closest('[data-agent-color]');
    if(!button) return;
    editState.avatarColor = normalizeAgentAvatarColor(button.getAttribute('data-agent-color'));
    renderEditCinema();
  });
  // Native color inputs emit `input` while the picker is open. Listen for
  // `change` so choosing a color does not replace the input underneath the
  // browser's open picker and interrupt selection.
  el('#benchEditColorOptions').addEventListener('change', function(e){
    if(!e.target || e.target.id !== 'benchEditColorInput') return;
    editState.avatarColor = normalizeAgentAvatarColor(e.target.value);
    renderEditCinema();
  });
  el('#benchEditSaveBtn').addEventListener('click', saveEditCinema);
  el('#benchEditDeleteBtn').addEventListener('click', deleteEditCinemaAgent);
  el('#benchTestSendBtn').addEventListener('click', runBenchTest);
  el('#benchTestInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); runBenchTest(); }
  });
  bindDeptDropdown('benchDept', function(){ return cinema.departments; }, function(d){
    cinema.departmentsTouched = true;
    return toggleDeptSelection(cinema.departments, d);
  }, function(){ renderDeptDropdown('benchDept', loadDepartments(), cinema.departments); });
  bindDeptDropdown('benchEditDept', function(){ return editState.departments; }, function(d){
    return toggleDeptSelection(editState.departments, d);
  }, function(){ renderDeptDropdown('benchEditDept', loadDepartments(), editState.departments); });
  // Detail-panel selector persists on every toggle (no separate save step) — PUTs the
  // full updated list, then reopens the panel from fresh data so DEPARTMENTS/bench list
  // and this dropdown itself all reflect what the server actually saved.
  bindDeptDropdown('benchDetailDept', function(){ return benchDetailDeptState.departments; }, function(d){
    var ok = toggleDeptSelection(benchDetailDeptState.departments, d);
    if(ok){
      var a = findBenchAgent(benchDetailDeptState.agentId);
      var targetId = a && (a.isBuiltin ? a.agentId : a.id);
      if(targetId){
        api('/api/bots/' + targetId, {method:'PUT', body:{departments: benchDetailDeptState.departments.slice()}}).then(function(res){
          if(res.status === 200 && benchOpenId === benchDetailDeptState.agentId){
            loadBenchAgents().then(function(){ openBenchDetail(benchDetailDeptState.agentId); });
          }
        }).catch(function(){});
      }
    }
    return ok;
  }, function(){ renderDeptDropdown('benchDetailDept', loadDepartments(), benchDetailDeptState.departments); });
  el('#benchTestMessages').addEventListener('click', function(e){
    var btn = e.target.closest('[data-undo-ix]');
    if(!btn) return;
    editState.removedImprovements.push(parseInt(btn.getAttribute('data-undo-ix'), 10));
    renderBenchTest();
  });
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    var openDropdown = el('.bench-dept-dropdown.open');
    if(openDropdown){ openDropdown.classList.remove('open'); return; }
    if(el('#benchCinema').classList.contains('open') || chatInfo.mode === 'agent-edit') closeCinema();
    else if(el('#agentConfigPanel').classList.contains('open')){ el('#agentConfigPanel').classList.remove('open'); el('#configPanelToggle').classList.remove('active'); }
    else if(benchOpenId) closeBenchDetail();
  });

  function renderHeroExamples(){
    var wrap = el('#benchHeroExamples');
    if(!wrap) return;
    wrap.innerHTML = currentBenchExamples().map(function(label){
      return '<button type="button" class="bench-example-chip" data-hero-example="' + esc(label) + '"><span class="glyph">&#8623;</span>' + esc(label) + '</button>';
    }).join('');
    els('[data-hero-example]', wrap).forEach(function(chip){
      chip.addEventListener('click', function(){
        cinema.prompt = chip.getAttribute('data-hero-example');
        openCinema();
        el('#benchComposeTextarea').value = cinema.prompt;
        renderCinema();
      });
    });
  }

  function renderAgentAdminPanel(){
    renderHeroExamples();
    fetchBenchExamplesOnce();
    loadBenchAgents().then(renderBenchColumns);
  }

  /* ============ CHAT: native multi-agent workspace ============ */
  /* Sidebar: CHANNELS / DEPARTMENTS (persona-switching coordinator rooms — one topic, multiple agents
     addressed by name) / AGENTS (one native conversation per custom agent).
     Selecting a row switches the main thread to that conversation. State
     (messages, an in-flight guard, the thinking hint) lives PER ROOM
     in chatWs.byRoom so switching threads never bleeds messages or pending
     state across rooms. */
  // Set by the message right-click context-menu IIFE below, once its
  // closeMenu() exists — the shared Escape handler (much further down)
  // calls through this so Esc can close the menu without the two IIFEs
  // needing to know about each other's internals.
  var chatCtxMenuClose = null;
  var chatSidebarCtxMenuClose = null;
  var chatWs = {
    configured: null,      // null = not checked yet, false = 503'd, true = live
    rooms: {home: null, departments: [], dms: []},   // rooms the server already knows about (kind:'home'/'department'/'dm'/'group' entries)
    humans: [],            // known people for the persistent Direct messages roster
    allDepartments: [],    // channel names projected only from authoritative conversation rows
    allAgents: [],         // every task bot (GET /api/bots)
    botRecords: [],        // complete GET /api/bots records, including durable automation config
    automationRuns: [],    // active Hermes cron sessions only
    gatewayAgent: null,        // Mia's real private orchestrator room, exposed as an independent agent row
    activeRoomId: null,
    activeKind: null,      // 'home' | 'agent' | 'department' | 'dm' | 'group'
    activeLabel: '',
    pollTimer: null,
    attentionTimer: null,
    byRoom: {},
    tasks: [],         // reserved for native durable work indicators
    hiddenChats: [],   // per-user hidden sidebar keys; hide, do not delete
    showHiddenChats: false,  // whether the sidebar's "hidden" section is expanded
    native: false,
    nativeConversations: [],
    nativeSocket: null,
    nativeSocketConversationId: null,
    nativeReconnectTimer: null
  };
  var localChatTyping = {roomId: null, active: false, timer: null};
  var chatSearchDirectory = {humans: [], agents: [], loaded: false, loading: false, request: null};

  function activeChatLocationStorageKey(){
    return 'miaChatActive:' + String(currentUser || 'preview').toLowerCase() + ':' + activeWorkspaceKey;
  }

  function saveActiveChatLocation(roomId){
    var key = activeChatLocationStorageKey();
    try {
      if(window.miaDesktop && window.miaDesktop.state && typeof window.miaDesktop.state.set === 'function'){
        window.miaDesktop.state.set(key, roomId ? String(roomId) : null);
      }
    } catch(_activeChatDesktopStateError) {}
    try {
      if(roomId) localStorage.setItem(key, String(roomId));
      else localStorage.removeItem(key);
    } catch(_activeChatStorageError) {}
  }

  function storedActiveChatLocation(){
    var key = activeChatLocationStorageKey();
    try {
      if(window.miaDesktop && window.miaDesktop.state && typeof window.miaDesktop.state.get === 'function'){
        var desktopRoomId = window.miaDesktop.state.get(key);
        if(typeof desktopRoomId === 'string' && desktopRoomId) return desktopRoomId;
      }
    } catch(_activeChatDesktopStateError) {}
    try { return localStorage.getItem(key) || ''; } catch(_activeChatStorageError) { return ''; }
  }

  function restorableNativeConversation(conversations, roomId){
    if(!roomId || !Array.isArray(conversations)) return null;
    return conversations.filter(function(conversation){
      return conversation && String(conversation.id) === String(roomId);
    })[0] || null;
  }

  function preferredStartupConversation(conversations, roomId, workspaceKey){
    var restored = roomId && Array.isArray(conversations) ? conversations.filter(function(conversation){
      return conversation && String(conversation.id) === String(roomId);
    })[0] || null : null;
    if(restored) return restored;
    if(workspaceKey !== 'solo' || !Array.isArray(conversations)) return null;
    return conversations.filter(function(conversation){
      var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
        ? conversation.metadata : {};
      return !!conversation && conversation.type === 'agent' && metadata.agentId === 'gateway';
    })[0] || null;
  }

  function restoreActiveChatLocation(){
    if(chatWs.activeRoomId) return false;
    var roomId = storedActiveChatLocation();
    var conversation = preferredStartupConversation(chatWs.nativeConversations, roomId, activeWorkspaceKey);
    if(!conversation){
      if(roomId) saveActiveChatLocation(null);
      return false;
    }
    if(roomId && String(conversation.id) !== String(roomId)) saveActiveChatLocation(null);
    var room = nativeConversationToRoom(conversation);
    var label = room.kind === 'department' ? (room.department || room.name)
      : (room.kind === 'dm' || room.kind === 'group') ? dmLabel(room)
      : room.name;
    loadChatRoom(room.roomId, room.kind, label);
    return true;
  }

  function humanDirectoryUsersForWorkspace(workspaceKey, users){
    return workspaceKey === 'solo' ? [] : (Array.isArray(users) ? users : []);
  }

  function clearSoloHumanDirectoryState(){
    if(activeWorkspaceKey !== 'solo') return;
    chatWs.humans = [];
    chatSearchDirectory.humans = [];
    Object.keys(chatWs.byRoom || {}).forEach(function(roomId){
      var roster = chatWs.byRoom[roomId] && chatWs.byRoom[roomId].mentionRoster;
      if(roster) roster.humans = [];
    });
    if(typeof dmCompose !== 'undefined' && dmCompose){
      dmCompose.humans = [];
      Object.keys(dmCompose.selected || {}).forEach(function(key){
        if(key.indexOf('human:') === 0) delete dmCompose.selected[key];
      });
    }
    if(typeof chatDmAdd !== 'undefined' && chatDmAdd) chatDmAdd.humans = [];
  }

  function loadHumanDirectoryResponse(){
    var requestedWorkspaceKey = activeWorkspaceKey;
    if(requestedWorkspaceKey === 'solo'){
      clearSoloHumanDirectoryState();
      return Promise.resolve({status:200, data:{users:[]}});
    }
    return api('/api/users').then(function(res){
      if(activeWorkspaceKey !== requestedWorkspaceKey || activeWorkspaceKey === 'solo'){
        clearSoloHumanDirectoryState();
        return {status:200, data:{users:[]}};
      }
      return res;
    });
  }

  clearSoloHumanDirectoryState();

  function nativeConversationPath(conversationId, suffix){
    var path = '/api/conversations/' + encodeURIComponent(conversationId) + (suffix || '');
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'workspace=' + encodeURIComponent(activeWorkspaceKey);
  }

  function nativeConversationKind(type){
    if(type === 'home') return 'home';
    if(type === 'agent') return 'agent';
    if(type === 'bot') return 'agent';
    if(type === 'group') return 'group';
    if(type === 'dm') return 'dm';
    return 'department';
  }

  var NATIVE_RASTER_PREVIEW_MIMES = {
    'image/gif': true,
    'image/jpeg': true,
    'image/png': true,
    'image/webp': true
  };
  var NATIVE_SAFE_PREVIEW_MIMES = {
    'application/json': true,
    'application/pdf': true,
    'image/gif': true,
    'image/jpeg': true,
    'image/png': true,
    'image/svg+xml': true,
    'image/webp': true,
    'text/csv': true,
    'text/html': true,
    'text/markdown': true,
    'text/plain': true
  };
  function nativeAttachmentCanPreview(mimeType){
    return !!NATIVE_SAFE_PREVIEW_MIMES[String(mimeType || '').toLowerCase()];
  }
  function nativeAttachmentIsRaster(mimeType){
    return !!NATIVE_RASTER_PREVIEW_MIMES[String(mimeType || '').toLowerCase()];
  }
  function chatMessageHasAttachments(message){
    return !!(message && Array.isArray(message.attachments) && message.attachments.length);
  }

  function nativeConversationToRoom(conversation){
    var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata : {};
    var kind = nativeConversationKind(conversation.type);
    // The native home conversation is the official Multiplayer Test channel. Its
    // stored slug is an implementation detail, not the owner's display identity.
    var name = kind === 'home' ? workspaceLabel() : (conversation.name || metadata.name || 'New conversation');
    return {
      id: conversation.id,
      roomId: conversation.id,
      conversationId: conversation.id,
      kind: kind,
      roomType: conversation.type,
      name: name,
      roomName: name,
      agentName: kind === 'home' ? name : null,
      department: kind === 'department' ? (metadata.department || name) : null,
      agentId: metadata.botId || metadata.agentId || null,
      members: metadata.members || [],
      metadata: metadata,
      createdAt: conversation.createdAt || null,
      nativeConversation: conversation
    };
  }

  function isNativeMiaConversation(conversation){
    var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata : {};
    return !!conversation && conversation.type === 'agent' && metadata.agentId === 'gateway';
  }

  var nativeMiaEnsurePromise = null;
  function ensureNativeMiaConversation(conversations, requestOptions){
    var existing = (conversations || []).filter(isNativeMiaConversation)[0];
    if(existing) return Promise.resolve(conversations);
    if(nativeMiaEnsurePromise) return nativeMiaEnsurePromise;
    nativeMiaEnsurePromise = api('/api/conversations', Object.assign({}, requestOptions || {}, {method:'POST', body:{
      type: 'agent',
      name: 'Mia',
      metadata: {agentId: 'gateway', departments: [], source: 'native-ui'}
    }})).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
        throw new Error(res.data && (res.data.message || res.data.error) || 'Could not connect Mia.');
      }
      return (conversations || []).concat([res.data.conversation]);
    }).catch(function(){
      // Mia's row is additive; a transient failure must not hide the rest of
      // the native conversation list or turn the chat surface offline.
      return conversations || [];
    }).then(function(result){
      nativeMiaEnsurePromise = null;
      return result;
    });
    return nativeMiaEnsurePromise;
  }

  function nativeEventToChatMessage(event){
    var content = event && event.content && typeof event.content === 'object' ? event.content : {};
    var body = '';
    if(typeof content.text === 'string') body = content.text;
    else if(typeof content.body === 'string') body = content.body;
    else if(typeof content.message === 'string') body = content.message;
    // A deleted transient progress row (a stopped dispatch's "working…"
    // status) disappears entirely — a "Message deleted" tombstone is only
    // for real messages someone removed.
    var deletedIsProgress = !!(event && event.metadata && event.metadata.progress === true);
    if(!body && event && event.deletedAt && !deletedIsProgress) body = 'Message deleted';
    var attachments = Array.isArray(content.attachments) ? content.attachments.filter(function(attachment){ return attachment && attachment.id; }).map(function(attachment){
      var mimeType = attachment.mimeType || 'application/octet-stream';
      var attachmentPath = '/attachments/' + encodeURIComponent(attachment.id);
      return {
        id: attachment.id,
        filename: attachment.filename || 'Attachment',
        mimeType: mimeType,
        url: nativeConversationPath(event.conversationId, attachmentPath),
        previewUrl: nativeConversationPath(event.conversationId, attachmentPath + '?preview=true'),
        canPreview: nativeAttachmentCanPreview(mimeType)
      };
    }) : [];
    var media = attachments.length ? attachments[0] : null;
    return {
      id: event.id,
      sender: event.senderId || 'unknown',
      nativeAgentName: event.senderId === 'gateway' ? 'Mia'
        : (event.metadata && typeof event.metadata.botName === 'string' ? event.metadata.botName
          : (event.metadata && typeof event.metadata.agentName === 'string' ? event.metadata.agentName : null)),
      body: body,
      media: media,
      attachments: attachments,
      ts: Date.parse(event.createdAt) || Date.now(),
      threadRoot: event.parentEventId || null,
      editTs: event.editedAt ? (Date.parse(event.editedAt) || 0) : 0,
      system: event.type === 'system',
      pending: false,
      deleted: !!event.deletedAt,
      clientIdempotencyKey: event.clientIdempotencyKey || null,
      nativeDispatchId: event.metadata && typeof event.metadata.dispatchId === 'string' ? event.metadata.dispatchId : null,
      nativeProgress: !!(event.metadata && event.metadata.progress === true),
      nativeDiagnostic: !!(event.metadata && event.metadata.diagnostic === true),
      nativeEvent: event
    };
  }

  function nativeEventsToMessages(events){
    return normalizeChatMessages((events || []).map(nativeEventToChatMessage));
  }

  function nativeEventsUrl(conversationId, afterSequence, limit, latest, beforeSequence){
    var query = '?limit=' + encodeURIComponent(limit || 100) + '&includeDeleted=false';
    if(afterSequence) query += '&afterSequence=' + encodeURIComponent(afterSequence);
    if(beforeSequence) query += '&beforeSequence=' + encodeURIComponent(beforeSequence);
    if(latest) query += '&latest=true';
    return nativeConversationPath(conversationId, '/events' + query);
  }

  function nativeSocketUrl(){
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + location.host + '/api/conversations/ws?workspace=' + encodeURIComponent(activeWorkspaceKey);
  }

  var miaServiceBannerTimer = null;
  function setMiaServiceUnavailable(unavailable){
    if(miaServiceBannerTimer){
      clearTimeout(miaServiceBannerTimer);
      miaServiceBannerTimer = null;
    }
    var banner = el('#miaServiceBanner');
    if(banner) banner.hidden = !unavailable;
  }

  function scheduleMiaServiceUnavailable(){
    if(miaServiceBannerTimer) return;
    miaServiceBannerTimer = setTimeout(function(){
      miaServiceBannerTimer = null;
      var banner = el('#miaServiceBanner');
      if(banner) banner.hidden = false;
    }, 500);
  }

  (function(){
    var retry = el('#miaServiceRetry');
    if(!retry) return;
    retry.addEventListener('click', function(){
      if(retry.disabled) return;
      retry.disabled = true;
      retry.textContent = 'Restarting…';
      var request = window.miaDesktop && typeof window.miaDesktop.retryConnection === 'function'
        ? window.miaDesktop.retryConnection()
        : Promise.resolve(false);
      Promise.resolve(request).then(function(ok){
        if(ok){
          setMiaServiceUnavailable(false);
          retry.disabled = false;
          retry.textContent = 'Restart and reconnect';
          if(chatWs.native && chatWs.activeRoomId) connectNativeChatSocket(chatWs.activeRoomId);
          return;
        }
        retry.disabled = false;
        retry.textContent = 'Try again';
      }).catch(function(){
        retry.disabled = false;
        retry.textContent = 'Try again';
      });
    });
  })();

  function closeNativeChatSocket(){
    if(chatWs.nativeReconnectTimer){
      clearTimeout(chatWs.nativeReconnectTimer);
      chatWs.nativeReconnectTimer = null;
    }
    var socket = chatWs.nativeSocket;
    chatWs.nativeSocket = null;
    chatWs.nativeSocketConversationId = null;
    if(socket){
      socket.onclose = null;
      try { socket.close(); } catch(err) {}
    }
  }

  function applyNativeEvent(event, options){
    options = options || {};
    if(!event || event.conversationId !== chatWs.activeRoomId) return;
    var state = chatRoomState(event.conversationId);
    syncNativeDispatchFromEvent(event);
    var message = nativeEventToChatMessage(event);
    var wasKnown = state.messages.some(function(existing){
      return existing.id === message.id || (existing.pending && existing.clientIdempotencyKey && existing.clientIdempotencyKey === message.clientIdempotencyKey);
    });
    var replaced = false;
    state.messages = state.messages.map(function(existing){
      if(existing.pending && existing.clientIdempotencyKey && existing.clientIdempotencyKey === message.clientIdempotencyKey){
        replaced = true;
        return message;
      }
      return existing.id === message.id ? message : existing;
    });
    if(!replaced && !state.messages.some(function(existing){ return existing.id === message.id; })) state.messages.push(message);
    state.messages = normalizeChatMessages(state.messages);
    if(window.MiaChatScroll) window.MiaChatScroll.noteIncoming(state, {
      isNew: !wasKnown,
      isVisible: !message.threadRoot && (message.system || isHumanSender(message.sender) || !!displayBotBody(message.body) || chatMessageHasAttachments(message)),
      isStreamingDelta: wasKnown
    });
    // Native handoffs use the triggering human event as the thread root.
    // Opening it when the first agent event arrives replaces the old
    // thread-trigger behavior and lets the user see progress immediately.
    if(options.autoOpenThread && (event.senderType === 'agent' || event.senderType === 'bot') && message.threadRoot && !state.openThreadRoot){
      state.openThreadRoot = message.threadRoot;
    }
    state.lastSequence = Math.max(Number(state.lastSequence || 0), Number(event.sequence || 0));
    state.lastTs = Math.max(Number(state.lastTs || 0), message.ts || 0);
    var fromWorker = event.senderType === 'agent' || event.senderType === 'bot';
    var eventMetadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    var isProgress = eventMetadata.progress === true && eventMetadata.status !== 'failed';
    // The browser starts an immediate local thinking row when the user sends.
    // The first authoritative worker event (including persisted progress) owns
    // that same UI slot, so retire the local row before rendering the event.
    // The local "thinking…" bubble only bridges the gap until the gateway's
    // own first event; from then on the gateway status row is the single
    // live indicator (it keeps shimmering until the dispatch completes).
    // Two bubbles at once was the reported bug.
    if(fromWorker && state.thinking) stopChatThinking(event.conversationId);
    // A final reply is also the point where browser-local dispatch state can
    // become stale (for example, if the final event omitted its dispatchId).
    // Reconcile with the durable active list so an idle chat never keeps a
    // pulsing activity dot after its work has completed.
    if(fromWorker && !isProgress){
      loadActiveNativeDispatches(event.conversationId);
      // A completed worker event in another room is the actionable transition
      // the user asked to be told about. Progress events remain quiet so a
      // long-running background task produces one notification, not a stream.
      if(isIncomingAttentionMessage(message)) notifyDesktopChatMessage(event.conversationId, message);
    }
    if(chatWs.activeRoomId === event.conversationId) renderChatThread();
    renderChatSidebar();
    renderComposerTaskControl();
  }

  function connectNativeChatSocket(conversationId){
    closeNativeChatSocket();
    if(!conversationId || typeof WebSocket !== 'function') return;
    var state = chatRoomState(conversationId);
    var socket = new WebSocket(nativeSocketUrl());
    chatWs.nativeSocket = socket;
    chatWs.nativeSocketConversationId = conversationId;
    socket.onopen = function(){
      if(chatWs.nativeSocket !== socket) return;
      setMiaServiceUnavailable(false);
      socket.send(JSON.stringify({type:'subscribe', conversationId:conversationId, afterSequence:Number(state.lastSequence || 0)}));
    };
    socket.onmessage = function(message){
      if(chatWs.nativeSocket !== socket) return;
      var payload;
      try { payload = JSON.parse(message.data); } catch(err){ return; }
      if(payload.type === 'conversation.event') applyNativeEvent(payload.event, {autoOpenThread: true});
      if(payload.type === 'history') (payload.events || []).forEach(function(event){ applyNativeEvent(event, {autoOpenThread: false}); });
    };
    socket.onclose = function(){
      if(chatWs.nativeSocket !== socket || !chatWs.native || chatWs.activeRoomId !== conversationId) return;
      chatWs.nativeSocket = null;
      chatWs.nativeSocketConversationId = null;
      scheduleMiaServiceUnavailable();
      chatWs.nativeReconnectTimer = setTimeout(function(){
        chatWs.nativeReconnectTimer = null;
        if(chatWs.native && chatWs.activeRoomId === conversationId) connectNativeChatSocket(conversationId);
      }, 1500);
    };
  }

  function applyNativeConversationList(conversations){
    setMiaServiceUnavailable(false);
    var rooms = (conversations || []).map(nativeConversationToRoom);
    chatWs.native = true;
    chatWs.nativeConversations = conversations || [];
    chatWs.configured = true;
    chatWs.rooms.home = rooms.filter(function(room){ return room.kind === 'home'; })[0] || null;
    chatWs.rooms.departments = rooms.filter(function(room){ return room.kind === 'department'; });
    chatWs.rooms.dms = rooms.filter(function(room){ return room.kind === 'dm' || room.kind === 'group'; });
    var agentRooms = rooms.filter(function(room){ return room.kind === 'agent'; });
    var seenBotRooms = {};
    var uniqueBotRooms = agentRooms.filter(function(room){ return !isNativeMiaConversation(room.nativeConversation); })
      .sort(function(left, right){
        return (Date.parse(left.createdAt || '') || 0) - (Date.parse(right.createdAt || '') || 0);
      }).filter(function(room){
        var key = String(room.agentId || room.id || '');
        if(seenBotRooms[key]) return false;
        seenBotRooms[key] = true;
        return true;
      });
    chatWs.allAgents = uniqueBotRooms.map(function(room){
      return {
        id: room.agentId || room.id,
        name: room.name,
        roomId: room.roomId,
        conversationId: room.conversationId,
        nativeConversationId: room.id,
        departments: room.metadata.departments || []
      };
    });
    if(Array.isArray(chatWs.botRecords) && chatWs.botRecords.length) syncChatBotRecords(chatWs.botRecords);
    var mia = agentRooms.filter(function(room){ return isNativeMiaConversation(room.nativeConversation); })[0];
    chatWs.gatewayAgent = mia ? {id:'gateway', name:mia.name || 'Mia', roomId:mia.roomId, conversationId:mia.id, manager:true, department:'Mia'} : null;
    chatWs.allDepartments = chatWs.rooms.departments.map(function(room){ return room.department; });
    chatWs.humans = [];
  }

  function loadNativeConversationStates(rooms){
    return Promise.all((rooms || []).map(function(room){
      return api(nativeConversationPath(room.roomId, '/state')).then(function(res){
        return {room: room, state: res.status === 200 && res.data ? res.data.state : null};
      }).catch(function(){ return {room: room, state: null}; });
    })).then(function(results){
      results.forEach(function(result){
        var state = result.state;
        if(!state) return;
        var keys = ['room:' + result.room.roomId];
        if(result.room.kind === 'agent') keys.push('agent:' + (result.room.agentId || result.room.roomId));
        if(result.room.kind === 'dm' || result.room.kind === 'group') keys.push('dm:' + result.room.id);
        keys.forEach(function(key){
          if(state.pinned) chatPinnedKeys[key] = true;
          else delete chatPinnedKeys[key];
        });
        if(state.hidden) {
          keys.forEach(function(key){
            if(chatWs.hiddenChats.indexOf(key) === -1) chatWs.hiddenChats.push(key);
          });
        } else {
          chatWs.hiddenChats = chatWs.hiddenChats.filter(function(existing){ return keys.indexOf(existing) === -1; });
        }
      });
      saveChatPinned();
      renderChatSidebar();
    });
  }

  function loadNativeConversations(requestOptions){
    return api('/api/conversations?limit=200', requestOptions || {}).then(function(res){
      if(res.status !== 200) throw new Error(res.data && res.data.error || 'Native conversations unavailable.');
      var conversations = (res.data && res.data.conversations) || [];
      // A workspace is a scope, not a conversation. Keep the real agent chat
      // available when this scope has no rooms yet, but never synthesize a
      // workspace/home room just to give the center column something to show.
      return ensureNativeMiaConversation(conversations, requestOptions);
    });
  }
  var AGENT_SETUP_ROOM_ID = '__bot_setup__';
  var AGENT_SETUP_TIMEOUT_MS = 30000;
  var agentSetup = {
    phase: 'idle', // idle | intent | interpreting | review | activating | active
    intent: '',
    draft: null,
    error: '',
    created: null,
    liveRoomId: null,
    requestId: 0,
    requestController: null,
    requestTimeoutTimer: null,
    requestTimedOut: false
  };
  var chatPinnedKeys = {};
  var chatPinnedMigrationInFlight = false;
  var chatAttentionRooms = {};
  var chatSidebarSections = {pinned: true, all: true};
  var chatTaskStopPending = {};
  var chatAttachment = {file: null, previewUrl: null, busy: false, error: ''};

  function clearChatAttachment(){
    if(chatAttachment.previewUrl) URL.revokeObjectURL(chatAttachment.previewUrl);
    chatAttachment = {file: null, previewUrl: null, busy: false, error: ''};
    var picker = el('#ccFileInput');
    if(picker) picker.value = '';
    renderChatAttachment();
  }

  function renderChatAttachment(){
    var strip = el('#ccAttachStrip');
    if(!strip) return;
    if(!chatAttachment.file){
      strip.innerHTML = '';
      strip.style.display = 'none';
      return;
    }
    var file = chatAttachment.file;
    var preview = chatAttachment.previewUrl
      ? '<img class="cc-attach-thumb" src="' + esc(chatAttachment.previewUrl) + '" alt="" />'
      : '<span class="cc-attach-icon" aria-hidden="true">&#128247;</span>';
    strip.style.display = '';
    strip.innerHTML = '<div class="cc-attach-chip">' + preview +
      '<span class="cc-attach-name">' + esc(file.name || 'image') + ' &middot; ' + esc(humanFileSize(file.size)) + '</span>' +
      (chatAttachment.busy ? '<span class="cc-attach-state">Uploading&hellip;</span>' : '') +
      '<button type="button" class="cc-attach-remove" aria-label="Remove attachment"' + (chatAttachment.busy ? ' disabled' : '') + '>&times;</button></div>' +
      (chatAttachment.error ? '<div class="cc-attach-error" role="alert">' + esc(chatAttachment.error) + '</div>' : '');
  }

  function stageChatAttachment(file){
    if(!file) return false;
    var allowed = ['image/png','image/jpeg','image/gif','image/webp'];
    if(allowed.indexOf(String(file.type || '').toLowerCase()) === -1){
      chatAttachment.error = 'Choose a PNG, JPEG, GIF, or WebP image.';
      renderChatAttachment();
      return false;
    }
    if(file.size > 8 * 1024 * 1024){
      chatAttachment.error = 'Images must be 8 MB or smaller.';
      renderChatAttachment();
      return false;
    }
    clearChatAttachment();
    chatAttachment.file = file;
    chatAttachment.previewUrl = URL.createObjectURL(file);
    renderChatAttachment();
    return true;
  }

  function fileAsBase64(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onerror = function(){ reject(new Error('Could not read this image.')); };
      reader.onload = function(){
        var value = String(reader.result || '');
        var comma = value.indexOf(',');
        if(comma < 0) return reject(new Error('Could not read this image.'));
        resolve(value.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  function prepareChatAttachment(file, roomId){
    return fileAsBase64(file).then(function(dataBase64){
      return api(nativeConversationPath(roomId, '/attachments'), {method:'POST', body:{
        filename: file.name || 'image',
        mimeType: file.type || 'application/octet-stream',
        contentBase64: dataBase64
      }});
    }).then(function(result){
      if((result.status !== 201 && result.status !== 200) || !result.data || !result.data.attachment){
        throw new Error(result.data && result.data.error || 'Image upload failed.');
      }
      return {attachment: result.data.attachment};
    });
  }

  function chatAttentionStorageKey(){
    return 'miaChatAttention:' + String(currentUser || 'preview').toLowerCase() + ':' + activeWorkspaceKey;
  }
  function loadChatAttention(){
    try {
      var raw = localStorage.getItem(chatAttentionStorageKey());
      var parsed = raw ? JSON.parse(raw) : {};
      chatAttentionRooms = parsed && typeof parsed === 'object' ? parsed : {};
    } catch(err){ chatAttentionRooms = {}; }
  }
  function saveChatAttention(){
    try { localStorage.setItem(chatAttentionStorageKey(), JSON.stringify(chatAttentionRooms)); } catch(err) {}
  }
  function chatNeedsAttention(roomId){
    return !!(roomId && chatAttentionRooms[roomId]);
  }
  function clearChatAttention(roomId){
    if(!roomId || !chatAttentionRooms[roomId]) return;
    delete chatAttentionRooms[roomId];
    saveChatAttention();
  }
  function markChatAttention(roomId){
    if(!roomId || roomId === chatWs.activeRoomId || chatNeedsAttention(roomId)) return false;
    chatAttentionRooms[roomId] = true;
    saveChatAttention();
    return true;
  }
  function setChatAttention(roomId, unread){
    if(!roomId) return;
    if(unread) chatAttentionRooms[roomId] = true;
    else delete chatAttentionRooms[roomId];
    saveChatAttention();
    renderChatSidebar();
  }
  function chatPinnedStorageKey(){
    return 'miaChatPinned:' + String(currentUser || 'preview').toLowerCase() + ':' + activeWorkspaceKey;
  }
  function loadChatPinned(){
    try {
      var raw = localStorage.getItem(chatPinnedStorageKey());
      var parsed = raw ? JSON.parse(raw) : {};
      chatPinnedKeys = parsed && typeof parsed === 'object' ? parsed : {};
    } catch(err){ chatPinnedKeys = {}; }
  }
  function saveChatPinned(){
    try { localStorage.setItem(chatPinnedStorageKey(), JSON.stringify(chatPinnedKeys)); } catch(err) {}
  }
  function chatPinnedMigrationKey(){
    return 'miaChatPinnedServerMigration:' + String(currentUser || 'preview').toLowerCase() + ':' + activeWorkspaceKey;
  }
  function applyServerPinnedChats(keys){
    if(!Array.isArray(keys)) return;
    chatPinnedKeys = {};
    keys.filter(function(key){ return typeof key === 'string' && key; }).forEach(function(key){ chatPinnedKeys[key] = true; });
    saveChatPinned();
    renderChatSidebar();
  }
  function loadChatPinnedFromServer(){
    return Promise.resolve();
  }
  function isChatPinned(key){
    return !!(key && chatPinnedKeys[key]);
  }
  function setChatPinned(key, pinned){
    if(!key) return;
    if(pinned) chatPinnedKeys[key] = true;
    else delete chatPinnedKeys[key];
    saveChatPinned();
    renderChatSidebar();
    if(key.indexOf('room:') === 0){
      var conversationId = key.slice(5);
      api(nativeConversationPath(conversationId, '/state'), {method:'PATCH', body:{pinned: !!pinned}}).catch(function(){});
    }
  }

  function setChatSidebarSection(section, expanded){
    var wrap = section === 'pinned' ? el('#chatPinned') : el('#chatAllConversations');
    var toggle = el('[data-chat-section-toggle="' + section + '"]');
    if(!wrap) return;
    var group = wrap.parentElement;
    if(group) group.classList.toggle('is-collapsed', !expanded);
    if(toggle){
      var label = section === 'pinned' ? 'Pinned' : 'All conversations';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + label);
      toggle.setAttribute('title', (expanded ? 'Collapse ' : 'Expand ') + label);
    }
  }

  (function(){
    els('[data-chat-section-toggle]').forEach(function(toggle){
      toggle.addEventListener('click', function(){
        var section = toggle.getAttribute('data-chat-section-toggle');
        if(!Object.prototype.hasOwnProperty.call(chatSidebarSections, section)) return;
        chatSidebarSections[section] = !chatSidebarSections[section];
        setChatSidebarSection(section, chatSidebarSections[section]);
      });
    });
  })();

  // Sidebar conversation actions are deliberately scoped to the row type. The
  // shared actions work for humans and agents; agent-only actions are hidden
  // for human conversations instead of pretending a person's profile is an
  // editable agent record.
  (function(){
    var menu = el('#chatSidebarCtxMenu');
    var pinItem = el('#chatSidebarCtxPin');
    var pinLabel = el('#chatSidebarCtxPinLabel');
    var attentionLabel = el('#chatSidebarCtxAttentionLabel');
    var deleteLabel = el('#chatSidebarCtxDeleteLabel');
    var scroll = el('.chat-sidebar-scroll');
    if(!menu || !pinItem || !scroll) return;
    var openEntry = null;

    function item(action){ return el('[data-sidebar-action="' + action + '"]', menu); }
    function setVisible(action, visible){
      var button = item(action);
      if(button) button.hidden = !visible;
      return visible;
    }
    function setSeparator(name, visible){
      var separator = el('[data-sidebar-separator="' + name + '"]', menu);
      if(separator) separator.hidden = !visible;
    }

    function closeMenu(){
      if(menu.hidden) return false;
      menu.hidden = true;
      openEntry = null;
      return true;
    }

    function openMenuFor(row, x, y){
      var pinKey = row.getAttribute('data-chat-key');
      if(!pinKey) return;
      var kind = row.getAttribute('data-chat-menu-kind') || '';
      var roomId = row.getAttribute('data-chat-room-id') || '';
      var agentId = row.getAttribute('data-chat-menu-agent-id') || '';
      var hideKey = row.getAttribute('data-chat-menu-hide-key') || '';
      var name = row.getAttribute('data-chat-menu-name') || 'conversation';
      openEntry = {pinKey: pinKey, kind: kind, roomId: roomId, agentId: agentId, hideKey: hideKey, name: name};
      var pinned = isChatPinned(pinKey);
      var hasAgentActions = kind === 'agent' && agentId !== 'gateway';
      var hasConversationDelete = !!roomId && kind !== 'home' && kind !== 'agent';
      var hasCopy = !!roomId;
      var hasHide = !!hideKey;
      if(pinLabel) pinLabel.textContent = pinned ? 'Unpin' : 'Pin';
      if(attentionLabel) attentionLabel.textContent = chatNeedsAttention(roomId) ? 'Mark as Read' : 'Mark as Unread';
      setVisible('attention', !!roomId);
      setVisible('edit', hasAgentActions);
      setVisible('duplicate', hasAgentActions);
      setVisible('share', hasAgentActions);
      setVisible('copy', hasCopy);
      setVisible('hide', hasHide);
      setVisible('delete', hasAgentActions || hasConversationDelete);
      if(deleteLabel) deleteLabel.textContent = hasConversationDelete ? 'Delete conversation' : 'Delete';
      setSeparator('agent', hasAgentActions);
      setSeparator('copy', hasAgentActions && hasCopy);
      setSeparator('hide', hasCopy && hasHide);
      menu.hidden = false;
      var w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    }

    scroll.addEventListener('contextmenu', function(e){
      var row = e.target.closest('.chat-recent-row[data-chat-key]');
      if(!row) return;
      e.preventDefault();
      openMenuFor(row, e.clientX, e.clientY);
    });
    menu.addEventListener('click', function(e){
      var button = e.target.closest('[data-sidebar-action]');
      if(!button || button.hidden || !openEntry) return;
      var action = button.getAttribute('data-sidebar-action');
      var entry = openEntry;
      closeMenu();
      if(action === 'pin'){
        setChatPinned(entry.pinKey, !isChatPinned(entry.pinKey));
      } else if(action === 'attention'){
        setChatAttention(entry.roomId, !chatNeedsAttention(entry.roomId));
      } else if(action === 'edit'){
        var editAgent = findBenchAgentByServerId(entry.agentId);
        if(editAgent) openEditCinema(editAgent.id);
      } else if(action === 'duplicate'){
        duplicateBenchAgent(findBenchAgentByServerId(entry.agentId));
      } else if(action === 'share'){
        var agent = findBenchAgentByServerId(entry.agentId);
        if(agent){
          var template = ['Agent template', 'Name: ' + agent.name, 'Role: ' + (agent.instructions || agent.brief || ''), 'Model: ' + (agent.model || 'Not configured'), 'Departments: ' + agentDepartments(agent).join(', ')].join('\n');
          copySidebarText(template, 'Agent template copied');
        }
      } else if(action === 'copy'){
        copySidebarText(entry.roomId, 'Conversation ID copied');
      } else if(action === 'hide'){
        hideChatEntry(entry.hideKey);
      } else if(action === 'delete'){
        if(entry.roomId && entry.kind !== 'agent') deleteNativeConversation(entry);
        else deleteBenchAgent(findBenchAgentByServerId(entry.agentId));
      }
    });
    document.addEventListener('click', function(e){
      if(!menu.hidden && !menu.contains(e.target)) closeMenu();
    });
    document.addEventListener('contextmenu', function(e){
      if(!menu.hidden && !e.target.closest('.chat-recent-row[data-chat-key]')) closeMenu();
    });
    document.addEventListener('scroll', closeMenu, true);
    chatSidebarCtxMenuClose = closeMenu;
  })();

  // Keep the rail edge treatment tied to real overflow. This makes the
  // Styled-skin dissolve appears only where rows are actually leaving the
  // viewport, not as a permanent haze over the first or last visible row.
  (function(){
    var scroll = el('.chat-sidebar-scroll');
    if(!scroll) return;
    function sync(){
      var top = scroll.scrollTop > 1;
      var bottom = scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1;
      scroll.classList.toggle('has-overflow-top', top);
      scroll.classList.toggle('has-overflow-bottom', bottom);
    }
    scroll.addEventListener('scroll', sync, {passive:true});
    window.addEventListener('resize', sync);
    if(window.MutationObserver){
      new MutationObserver(function(){ window.requestAnimationFrame(sync); }).observe(scroll, {childList:true, subtree:true});
    }
    window.requestAnimationFrame(sync);
  })();

  // Agent chats keep the routines pane visible by default; other
  // rooms can open the same surface on demand.
  // It is presentation-only: closing it never changes the active room or
  // the underlying chat data, and the user's close/reopen choice survives a
  // reload.
  var chatInfo = {open: true, mode: 'automations', automationBotId: null, automationId: null};
  var pluginShell = null;
  var pluginPaneRoomId = null;
  var localBrowserState = {open: false, roomId: null};
  var LOCAL_BROWSER_OPEN_STATE_KEY = 'miaBrowserOpen';
  var LOCAL_BROWSER_SEARCH_ENGINE_KEY = 'miaBrowserSearchEngine';
  var localBrowserSearchEngine = 'google';
  // Bot Store: catalog entries are fetched once (index + each manifest) and
  // cached here for the lifetime of the tab; installingId guards against a
  // double-click firing two POST /api/bots calls for the same manifest.
  var botStoreState = {loading: false, error: '', entries: null, installingId: null};
  var appDevState = {available: false, verboseHermes: false, traceCommands: false, events: []};
  var appDevPollTimer = null;
  var localBrowserPromptIndex = 0;
  var localBrowserPromptTimer = null;
  var LOCAL_BROWSER_PROMPTS = [
    'Ask Mia to browse with you',
    'Ask Mia to do things for you',
    'Ask Mia to find something for you'
  ];
  function localBrowserNormalizeUrl(value, searchEngine){
    var input = String(value || '').trim();
    if(!input) throw new Error('Enter an address or search.');
    var explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    var localAddress = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
    var domainAddress = /^[\w.-]+\.\w+(?::\d+)?(?:[/?#]|$)/i.test(input);
    if(!explicitScheme && !localAddress && !domainAddress){
      if(searchEngine === 'x') return 'https://x.com/search?q=' + encodeURIComponent(input) + '&src=typed_query';
      return 'https://www.google.com/search?q=' + encodeURIComponent(input) + '&igu=1';
    }
    if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = /^localhost(?:[:/]|$)/i.test(input) ? 'http://' + input : 'https://' + input;
    var url = new URL(input);
    if(url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only web addresses are supported.');
    if(url.hostname.toLowerCase() === 'google.com' || url.hostname.toLowerCase() === 'www.google.com'){
      url.protocol = 'https:';
      url.hostname = 'www.google.com';
      if(url.pathname === '/' || !url.pathname) url.pathname = '/webhp';
      url.searchParams.set('igu', '1');
    }
    return url.toString();
  }

  function stopLocalBrowserPromptRotation(){
    if(localBrowserPromptTimer) clearInterval(localBrowserPromptTimer);
    localBrowserPromptTimer = null;
  }

  function startLocalBrowserPromptRotation(){
    stopLocalBrowserPromptRotation();
    localBrowserPromptIndex = 0;
    syncInlineChatSuggestion();
    localBrowserPromptTimer = setInterval(function(){
      if(!localBrowserState.open){ stopLocalBrowserPromptRotation(); return; }
      localBrowserPromptIndex = (localBrowserPromptIndex + 1) % LOCAL_BROWSER_PROMPTS.length;
      syncInlineChatSuggestion();
    }, 3500);
  }

  function renderAppDevDiagnostics(){
    var verbose = el('#appDevHermesVerbose');
    var status = el('#appDevStatus');
    if(verbose) verbose.checked = appDevState.verboseHermes;
    if(status){
      status.textContent = appDevState.available
        ? (appDevState.verboseHermes ? 'Detailed agent activity is enabled.' : 'Detailed agent activity is disabled.')
        : 'Diagnostics are available only from the local preview.';
    }
  }

  function stopAppDevPolling(){
    if(appDevPollTimer) clearInterval(appDevPollTimer);
    appDevPollTimer = null;
  }

  function refreshAppDevDiagnostics(){
    return api('/api/dev/diagnostics').then(function(result){
      if(result.status === 404){
        appDevState.available = false;
        renderAppDevDiagnostics();
        return;
      }
      if(result.status < 200 || result.status >= 300 || !result.data || !result.data.diagnostics) throw new Error('diagnostics unavailable');
      appDevState = Object.assign(appDevState, result.data.diagnostics, {available: true});
      renderAppDevDiagnostics();
    }).catch(function(){
      appDevState.available = false;
      renderAppDevDiagnostics();
    });
  }

  function updateAppDevDiagnostics(){
    var verbose = el('#appDevHermesVerbose');
    var desired = {
      verboseHermes: !!(verbose && verbose.checked),
      traceCommands: !!(verbose && verbose.checked),
    };
    var previous = Object.assign({}, appDevState);
    appDevState = Object.assign(appDevState, desired);
    renderAppDevDiagnostics();
    return api('/api/dev/diagnostics', {method:'POST', body:desired}).then(function(result){
      if(result.status < 200 || result.status >= 300 || !result.data || !result.data.diagnostics) throw new Error('diagnostics update failed');
      appDevState = Object.assign(appDevState, result.data.diagnostics, {available: true});
      renderAppDevDiagnostics();
    }).catch(function(){
      appDevState = previous;
      renderAppDevDiagnostics();
      showBenchToast('Diagnostics setting could not be applied');
    });
  }

  function buildAppDevSupportSummary(){
    return Promise.all([
      api('/healthz').catch(function(){ return {status:0, data:{}}; }),
      api('/api/dev/diagnostics').catch(function(){ return {status:0, data:{}}; })
    ]).then(function(results){
      var health = results[0].data || {};
      var diagnostics = results[1].data && results[1].data.diagnostics || {};
      var inference = health.inference || {};
      var capacity = inference.capacity || {};
      var chatStatus = chatWs.configured === true ? 'online' : chatWs.configured === false ? 'offline' : 'connecting';
      var capacitySummary = Number.isInteger(capacity.maxConcurrent) && Number.isInteger(capacity.maxQueueDepth)
        ? inference.running + '/' + capacity.maxConcurrent + ' active, ' + inference.waiting + '/' + capacity.maxQueueDepth + ' queued'
        : 'unavailable';
      var summary = [
        'Mia safe support summary',
        'Generated: ' + new Date().toISOString(),
        'Workspace: ' + workspaceLabel(),
        'Chat: ' + chatStatus,
        'Health: ' + (health.ok === true ? 'ok' : 'unavailable'),
        'Database: ' + (health.db === true ? 'ok' : 'unavailable'),
        'Inference capacity: ' + capacitySummary,
        'Diagnostics: ' + (diagnostics.localOnly === true ? 'local only' : 'unavailable'),
        'Detailed activity: ' + (diagnostics.verboseHermes === true ? 'on' : 'off'),
        'Trace events captured: ' + (Array.isArray(diagnostics.events) ? diagnostics.events.length : 0)
      ].join('\n');
      return summary;
    });
  }

  function copyAppDevSupportSummary(){
    return buildAppDevSupportSummary().then(function(summary){
      return copySidebarText(summary, 'Safe support summary copied');
    }).catch(function(){
      showBenchToast('Could not create support summary');
      return false;
    });
  }

  function prepareBetaFeedback(){
    return appPrompt('', {
      title: 'Tell us what happened',
      message: 'Describe the confusing step, unexpected result, or missing feature. Please leave out passwords and private conversation content.',
      inputLabel: 'Beta feedback',
      note: 'Mia will copy your note with a safe support summary so you can paste it into your beta feedback channel.',
      submitLabel: 'Copy feedback'
    }).then(function(result){
      if(!result || !result.ok || !String(result.text || '').trim()) return false;
      return buildAppDevSupportSummary().then(function(summary){
        var feedback = ['Mia beta feedback', '', String(result.text).trim(), '', summary].join('\n');
        return copySidebarText(feedback, 'Feedback copied — paste it into your beta channel');
      });
    }).catch(function(){
      showBenchToast('Could not prepare feedback');
      return false;
    });
  }

  function closeAppDevPanel(){
    stopAppDevPolling();
    var panel = el('#appDevelopmentPanel');
    if(panel) panel.hidden = true;
  }

  function toggleAppDevPanel(force){
    var panel = el('#appDevelopmentPanel');
    if(!panel) return;
    var open = force === undefined ? panel.hidden : !!force;
    panel.hidden = !open;
    if(open){
      refreshAppDevDiagnostics();
      stopAppDevPolling();
      appDevPollTimer = setInterval(refreshAppDevDiagnostics, 1500);
    } else stopAppDevPolling();
  }

  function renderLocalBrowser(){
    var overlay = el('#localBrowserOverlay');
    var empty = el('#localBrowserEmpty');
    var blocked = el('#localBrowserBlocked');
    var back = el('#localBrowserBackBtn');
    var forward = el('#localBrowserForwardBtn');
    var reload = el('#localBrowserReloadBtn');
    if(!overlay) return;
    overlay.hidden = !localBrowserState.open;
    overlay.setAttribute('aria-hidden', localBrowserState.open ? 'false' : 'true');
    overlay.classList.toggle('open', localBrowserState.open);
    if(window.miaNativeBrowser){ window.miaNativeBrowser.render(localBrowserState.open); return; }
    if(empty) empty.hidden = true;
    if(blocked) blocked.hidden = false;
    var blockedTitle = el('#localBrowserBlockedTitle');
    var blockedMessage = el('#localBrowserBlockedMessage');
    var blockedLink = el('#localBrowserBlockedLink');
    if(blockedTitle) blockedTitle.textContent = 'Native browser unavailable';
    if(blockedMessage) blockedMessage.textContent = 'Open this localhost build in Mia to use its browser.';
    if(blockedLink) blockedLink.hidden = true;
    if(back) back.disabled = true;
    if(forward) forward.disabled = true;
    if(reload) reload.disabled = true;
  }

  function localBrowserNavigate(value){
    var target;
    try { target = localBrowserNormalizeUrl(value, localBrowserSearchEngine); }
    catch(error){ showBenchToast(error.message || 'Enter a valid web address.'); return false; }
    if(window.miaNativeBrowser) return window.miaNativeBrowser.navigate(target);
    showBenchToast('The browser is available only in Mia.');
    return false;
  }

  function closeLocalBrowser(){
    if(!localBrowserState.open) return;
    stopLocalBrowserPromptRotation();
    localBrowserState.open = false;
    localBrowserState.roomId = null;
    localBrowserHistoryCache = null;
    closeLocalBrowserSuggest();
    try {
      if(window.miaDesktop && window.miaDesktop.state) window.miaDesktop.state.set(LOCAL_BROWSER_OPEN_STATE_KEY, null);
    } catch(_browserDesktopStateError) {}
    try { localStorage.removeItem(LOCAL_BROWSER_OPEN_STATE_KEY); } catch(_browserStorageError) {}
    document.body.classList.remove('browser-collab-mode', 'browser-sidebar-open');
    renderLocalBrowser();
    syncInlineChatSuggestion();
  }

  function openWebBrowserTool(options){
    localBrowserState.open = true;
    try {
      if(window.miaDesktop && window.miaDesktop.state) window.miaDesktop.state.set(LOCAL_BROWSER_OPEN_STATE_KEY, '1');
    } catch(_browserDesktopStateError) {}
    try { localStorage.setItem(LOCAL_BROWSER_OPEN_STATE_KEY, '1'); } catch(_browserStorageError) {}
    document.body.classList.add('browser-collab-mode');
    document.body.classList.remove('browser-sidebar-open');
    closeChatThread();
    closeChatTasksPanel();
    chatInfo.mode = 'automations';
    chatInfo.open = false;
    // Opening the browser used to always yank the chat pane back to the
    // gateway room. If an agent/bot room is already active, keep the chat
    // pane pinned to it instead — only fall back to the gateway room when
    // nothing is active yet.
    if(chatWs.activeRoomId){
      localBrowserState.roomId = chatWs.activeRoomId;
    } else if(chatWs.gatewayAgent){
      navigateToAgentChat(chatWs.gatewayAgent, true);
      localBrowserState.roomId = chatWs.activeRoomId || chatWs.gatewayAgent.roomId || chatWs.gatewayAgent.nativeConversationId || null;
    }
    renderChatInfoPane();
    renderChatHeaderBar();
    renderLocalBrowser();
    startLocalBrowserPromptRotation();
    if(options && options.restoring) showBenchToast('Browser restored where you left off. Playback is paused.');
  }

  function shouldRestoreLocalBrowser(){
    try {
      if(window.miaDesktop && window.miaDesktop.state && window.miaDesktop.state.get(LOCAL_BROWSER_OPEN_STATE_KEY) === '1') return true;
    } catch(_browserDesktopStateError) {}
    try { return localStorage.getItem(LOCAL_BROWSER_OPEN_STATE_KEY) === '1'; } catch(_browserStorageError) { return false; }
  }

  var localBrowserBootRestoreHandled = false;
  function restoreLocalBrowserAfterBoot(){
    if(localBrowserBootRestoreHandled) return;
    localBrowserBootRestoreHandled = true;
    if(startUpdatedDesktopIntro()) return;
    if(shouldRestoreLocalBrowser()) openWebBrowserTool({restoring:true});
  }

  // URL-bar autocomplete: a lightweight custom dropdown backed by the
  // Electron shell's visit history (window.miaDesktop.browser.history).
  // Older shells / the web build don't expose it — every call below is
  // guarded so the feature quietly does nothing there.
  var localBrowserHistoryCache = null;
  var localBrowserSuggestItems = [];
  var localBrowserSuggestIndex = -1;
  function localBrowserHistorySupported(){
    return !!(window.miaDesktop && window.miaDesktop.browser && typeof window.miaDesktop.browser.history === 'function');
  }
  function loadLocalBrowserHistory(){
    if(!localBrowserHistorySupported()) return Promise.resolve([]);
    if(localBrowserHistoryCache) return Promise.resolve(localBrowserHistoryCache);
    return Promise.resolve(window.miaDesktop.browser.history(20)).then(function(res){
      localBrowserHistoryCache = (res && Array.isArray(res.history)) ? res.history : [];
      return localBrowserHistoryCache;
    }).catch(function(){ return []; });
  }
  function filterLocalBrowserHistory(history, query){
    var q = String(query || '').trim().toLowerCase();
    if(!q) return [];
    return (history || []).filter(function(item){
      return (item.url && String(item.url).toLowerCase().indexOf(q) !== -1) ||
        (item.title && String(item.title).toLowerCase().indexOf(q) !== -1);
    }).slice(0, 5);
  }
  function closeLocalBrowserSuggest(){
    var box = el('#localBrowserUrlSuggest');
    if(box){ box.hidden = true; box.innerHTML = ''; }
    var input = el('#localBrowserUrl');
    if(input) input.setAttribute('aria-expanded', 'false');
    localBrowserSuggestItems = [];
    localBrowserSuggestIndex = -1;
  }
  function updateLocalBrowserSuggestHighlight(){
    var box = el('#localBrowserUrlSuggest');
    if(!box) return;
    els('.local-browser-suggest-item', box).forEach(function(btn, i){
      btn.classList.toggle('active', i === localBrowserSuggestIndex);
    });
  }
  function renderLocalBrowserSuggest(items){
    var box = el('#localBrowserUrlSuggest');
    if(!box) return;
    localBrowserSuggestItems = items || [];
    localBrowserSuggestIndex = -1;
    var input = el('#localBrowserUrl');
    if(!localBrowserSuggestItems.length){
      box.hidden = true;
      box.innerHTML = '';
      if(input) input.setAttribute('aria-expanded', 'false');
      return;
    }
    box.innerHTML = localBrowserSuggestItems.map(function(item, i){
      return '<button type="button" class="local-browser-suggest-item" role="option" data-suggest-index="' + i + '">' +
        '<span class="local-browser-suggest-title">' + esc(item.title || item.url) + '</span>' +
        '<span class="local-browser-suggest-url">' + esc(item.url) + '</span></button>';
    }).join('');
    box.hidden = false;
    if(input) input.setAttribute('aria-expanded', 'true');
  }
  function chooseLocalBrowserSuggest(item, input){
    if(!item) return;
    if(input) input.value = item.url;
    closeLocalBrowserSuggest();
    localBrowserNavigate(item.url);
  }

  function browserSidebarOwnsClick(target, drawer, toggle, portaledMenu){
    return !!target && !!(
      (drawer && drawer.contains(target)) ||
      (toggle && toggle.contains(target)) ||
      (portaledMenu && portaledMenu.contains(target))
    );
  }

  (function wireLocalBrowser(){
    var form = el('#localBrowserForm');
    var input = el('#localBrowserUrl');
    var back = el('#localBrowserBackBtn');
    var forward = el('#localBrowserForwardBtn');
    var reload = el('#localBrowserReloadBtn');
    var close = el('#localBrowserCloseBtn');
    var sidebar = el('#localBrowserSidebarBtn');
    var searchEnginePicker = el('#localBrowserSearchEngine');
    function renderLocalBrowserSearchEngine(){
      if(!searchEnginePicker) return;
      els('[data-search-engine]', searchEnginePicker).forEach(function(button){
        button.setAttribute('aria-pressed', button.getAttribute('data-search-engine') === localBrowserSearchEngine ? 'true' : 'false');
      });
    }
    if(searchEnginePicker){
      try { localBrowserSearchEngine = localStorage.getItem(LOCAL_BROWSER_SEARCH_ENGINE_KEY) === 'x' ? 'x' : 'google'; }
      catch(_browserSearchReadError){ localBrowserSearchEngine = 'google'; }
      renderLocalBrowserSearchEngine();
      searchEnginePicker.addEventListener('click', function(event){
        var button = event.target.closest('[data-search-engine]');
        if(!button) return;
        localBrowserSearchEngine = button.getAttribute('data-search-engine') === 'x' ? 'x' : 'google';
        renderLocalBrowserSearchEngine();
        try { localStorage.setItem(LOCAL_BROWSER_SEARCH_ENGINE_KEY, localBrowserSearchEngine); }
        catch(_browserSearchWriteError) {}
        if(input) input.focus();
      });
    }
    if(window.miaDesktop && window.miaDesktop.browser && window.miaDesktop.browser.onOpen){
      window.miaDesktop.browser.onOpen(function(action){
        openWebBrowserTool();
        window.setTimeout(function(){
          if(window.miaNativeBrowser && window.miaNativeBrowser.menuAction) window.miaNativeBrowser.menuAction(action);
        }, 0);
      });
    }
    if(form) form.addEventListener('submit', function(event){
      event.preventDefault();
      localBrowserNavigate(input ? input.value : '');
    });
    var suggestBox = el('#localBrowserUrlSuggest');
    if(input && localBrowserHistorySupported()){
      var refreshSuggest = function(){
        loadLocalBrowserHistory().then(function(history){
          if(document.activeElement !== input) return;
          renderLocalBrowserSuggest(filterLocalBrowserHistory(history, input.value));
        });
      };
      input.addEventListener('focus', refreshSuggest);
      input.addEventListener('input', refreshSuggest);
      input.addEventListener('keydown', function(event){
        if(!localBrowserSuggestItems.length) return;
        if(event.key === 'ArrowDown'){
          event.preventDefault();
          localBrowserSuggestIndex = Math.min(localBrowserSuggestItems.length - 1, localBrowserSuggestIndex + 1);
          updateLocalBrowserSuggestHighlight();
        } else if(event.key === 'ArrowUp'){
          event.preventDefault();
          localBrowserSuggestIndex = Math.max(0, localBrowserSuggestIndex - 1);
          updateLocalBrowserSuggestHighlight();
        } else if(event.key === 'Enter'){
          if(localBrowserSuggestIndex < 0) return; // no selection: keep the normal submit behavior
          event.preventDefault();
          chooseLocalBrowserSuggest(localBrowserSuggestItems[localBrowserSuggestIndex], input);
        } else if(event.key === 'Escape'){
          closeLocalBrowserSuggest();
        }
      });
      input.addEventListener('blur', function(){
        // Deferred so a suggestion's mousedown/click can still register.
        setTimeout(closeLocalBrowserSuggest, 150);
      });
      if(suggestBox) suggestBox.addEventListener('mousedown', function(event){
        var btn = event.target.closest('.local-browser-suggest-item');
        if(!btn) return;
        event.preventDefault();
        var idx = Number(btn.getAttribute('data-suggest-index'));
        chooseLocalBrowserSuggest(localBrowserSuggestItems[idx], input);
      });
    }
    if(back) back.addEventListener('click', function(){
      if(window.miaNativeBrowser) window.miaNativeBrowser.action('back');
    });
    if(forward) forward.addEventListener('click', function(){
      if(window.miaNativeBrowser) window.miaNativeBrowser.action('forward');
    });
    if(reload) reload.addEventListener('click', function(){
      if(window.miaNativeBrowser) window.miaNativeBrowser.action('reload');
    });
    if(close) close.addEventListener('click', closeLocalBrowser);
    var sidebarClose = el('#chatSidebarDrawerClose');
    function setBrowserSidebarOpen(open){
      document.body.classList.toggle('browser-sidebar-open', open);
      if(!sidebar) return;
      sidebar.setAttribute('aria-expanded', open ? 'true' : 'false');
      sidebar.setAttribute('aria-label', open ? 'Close your bots' : 'Open your bots');
      sidebar.setAttribute('title', 'Your bots');
    }
    if(sidebar) sidebar.addEventListener('click', function(){
      setBrowserSidebarOpen(!document.body.classList.contains('browser-sidebar-open'));
    });
    if(sidebarClose) sidebarClose.addEventListener('click', function(){
      setBrowserSidebarOpen(false);
    });
    document.addEventListener('click', function(event){
      if(!document.body.classList.contains('browser-sidebar-open')) return;
      var drawer = el('.chat-sidebar');
      var portaledMenu = el('#chatSidebarCtxMenu');
      if(browserSidebarOwnsClick(event.target, drawer, sidebar, portaledMenu)) return;
      // Capture and consume the click before any underlying chat, toolbar, or
      // restored native browser surface can act on it.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setBrowserSidebarOpen(false);
    }, true);
    // Picking a bot or conversation from the drawer is a destination choice:
    // collapse the drawer so the chosen chat is immediately visible. Row
    // tools (hide, dismiss, context-menu actions) keep the drawer open.
    var drawer = el('.chat-sidebar');
    if(drawer) drawer.addEventListener('click', function(e){
      if(!document.body.classList.contains('browser-sidebar-open')) return;
      var pick = e.target.closest('.chat-recent-row, .chat-starter-bot');
      if(!pick || pick.classList.contains('chat-row-hidden')) return;
      if(e.target.closest('.chat-row-hide, .chat-starter-bot-dismiss, [data-sidebar-action]')) return;
      setBrowserSidebarOpen(false);
    });
    renderLocalBrowser();
  })();

  (function wireAppDevelopment(){
    var panel = el('#appDevelopmentPanel');
    var close = el('#appDevelopmentClose');
    var verbose = el('#appDevHermesVerbose');
    var copy = el('#appDevCopySummary');
    if(!panel) return;
    if(close) close.addEventListener('click', function(){ closeAppDevPanel(); });
    if(verbose) verbose.addEventListener('change', updateAppDevDiagnostics);
    if(copy) copy.addEventListener('click', function(){
      copy.disabled = true;
      Promise.resolve(copyAppDevSupportSummary()).then(function(){ copy.disabled = false; });
    });
    document.addEventListener('keydown', function(event){
      if(event.key === 'Escape' && !panel.hidden) closeAppDevPanel();
    });
    refreshAppDevDiagnostics();
  })();

  var CHAT_INFO_PREFERENCE_VERSION = '3';
  function chatInfoOpenPreference(){
    // Migrate the old local preview's forced-closed preference once. That
    // preview hid the panel by default, which made it look like the routines
    // surface had been removed after a reload.
    if(localStorage.getItem('styledInfoPanePreferenceVersion') !== CHAT_INFO_PREFERENCE_VERSION){
      localStorage.setItem('styledInfoPanePreferenceVersion', CHAT_INFO_PREFERENCE_VERSION);
      localStorage.removeItem('styledInfoPaneOpen');
    }
    return localStorage.getItem('styledInfoPaneOpen') !== '0';
  }
  function isDirectChatRoom(){
    return chatWs.activeKind === 'agent' || chatWs.activeKind === 'dm' || chatWs.activeKind === 'group' || chatWs.activeKind === 'agent-setup';
  }
  function isInfoPaneAvailable(){
    return STYLED_SKIN && !!chatWs.activeRoomId && chatWs.activeKind !== 'agent-setup';
  }

  var DEVELOPER_MODE_KEY = 'miaos.developerMode';
  var THEME_MODE_KEY = 'miaos.theme';
  var developerTransitionFallbackTimer = null;
  function developerModeEnabled(){
    // Theme replaced the Developer Mode toggle: dark IS the old developer
    // look. An existing "developerMode: on" migrates to dark on first read.
    try {
      var theme = localStorage.getItem(THEME_MODE_KEY);
      if(theme === 'dark') return true;
      if(theme === 'light') return false;
      var legacy = localStorage.getItem(DEVELOPER_MODE_KEY) === 'on';
      if(legacy) localStorage.setItem(THEME_MODE_KEY, 'dark');
      return legacy;
    }
    catch(_developerModeStorageError){ return false; }
  }
  function applyDeveloperTheme(enabled){
    if(enabled) document.documentElement.setAttribute('data-theme', 'developer');
    else document.documentElement.removeAttribute('data-theme');
  }
  function finishDeveloperModeTransition(overlay, video){
    clearTimeout(developerTransitionFallbackTimer);
    developerTransitionFallbackTimer = null;
    applyDeveloperTheme(true);
    if(!overlay) return;
    overlay.classList.add('is-finishing');
    setTimeout(function(){
      overlay.hidden = true;
      overlay.classList.remove('is-finishing');
      if(video){ video.pause(); video.currentTime = 0; }
    }, 180);
  }
  function activateDeveloperMode(options){
    options = options || {};
    if(!options.animate || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)){
      applyDeveloperTheme(true);
      return;
    }
    var overlay = el('#developerModeTransition');
    var video = el('#developerModeTransitionVideo');
    if(!overlay || !video){ applyDeveloperTheme(true); return; }
    overlay.hidden = false;
    overlay.classList.remove('is-finishing');
    video.currentTime = 0;
    var themeApplied = false;
    var revealTheme = function(){
      if(themeApplied) return;
      themeApplied = true;
      applyDeveloperTheme(true);
    };
    var onTimeUpdate = function(){
      if(video.duration && video.currentTime >= video.duration * .72) revealTheme();
    };
    var cleanup = function(){
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
    };
    var onEnded = function(){ cleanup(); revealTheme(); finishDeveloperModeTransition(overlay, video); };
    var onError = function(){ cleanup(); revealTheme(); finishDeveloperModeTransition(overlay, video); };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded, {once:true});
    video.addEventListener('error', onError, {once:true});
    clearTimeout(developerTransitionFallbackTimer);
    developerTransitionFallbackTimer = setTimeout(onError, 2600);
    var playback = video.play();
    if(playback && typeof playback.catch === 'function') playback.catch(onError);
  }
  function deactivateDeveloperMode(){
    clearTimeout(developerTransitionFallbackTimer);
    developerTransitionFallbackTimer = null;
    var overlay = el('#developerModeTransition');
    var video = el('#developerModeTransitionVideo');
    if(video){ video.pause(); video.currentTime = 0; }
    if(overlay){ overlay.hidden = true; overlay.classList.remove('is-finishing'); }
    applyDeveloperTheme(false);
  }
  function syncDeveloperModeUI(){
    var enabled = developerModeEnabled();
    var select = el('#settingsThemeMode');
    var button = el('#chatSidebarDeveloperBtn');
    var menu = el('#chatDeveloperMenu');
    if(select) select.value = enabled ? 'dark' : 'light';
    // Developer tools are retired from the product surface: verbose output
    // moved to Settings → General → Output, and the theme moved next to it.
    // The sidebar entry point stays hidden for every user.
    if(button) button.hidden = true;
    if(menu) menu.classList.remove('open');
    applyDeveloperTheme(enabled);
    syncSidebarToolButtons();
  }

  // Clean slate is a factory reset: every remembered UI preference goes with
  // the data, not just the Solo keys, so the next launch is indistinguishable
  // from a first launch.
  function clearSoloWorkspaceUiState(){
    var owner = String(currentUser || 'preview').toLowerCase();
    var keys = [
      'miaChatActive:' + owner + ':solo',
      'miaChatAttention:' + owner + ':solo',
      'miaChatPinned:' + owner + ':solo',
      'miaChatPinnedServerMigration:' + owner + ':solo',
      chatModelSelectionCacheKey('solo')
    ];
    keys.forEach(function(key){
      try { localStorage.removeItem(key); } catch(_cleanSlateStorageError) {}
      try {
        if(window.miaDesktop && window.miaDesktop.state && typeof window.miaDesktop.state.set === 'function'){
          window.miaDesktop.state.set(key, null);
        }
      } catch(_cleanSlateDesktopStateError) {}
    });
    try { localStorage.clear(); } catch(_cleanSlateClearError) {}
    try { sessionStorage.clear(); } catch(_cleanSlateSessionError) {}
  }

  function cleanSlateSoloWorkspace(){
    var confirmed = window.confirm(
      'Erase all data and start from zero? This permanently removes every bot, automation, conversation, message, and attachment in Solo and Multiplayer Test, disconnects every model provider, forgets their keys, and wipes agent sessions, memories, and scheduled jobs. Mia relaunches afterwards as if newly installed.'
    );
    if(!confirmed) return;
    setAppLoading(true);
    // Clean slate targets the Solo resource, not the currently displayed
    // workspace. Scope both capability issuance and consumption explicitly.
    var soloHeaders = {'X-MiaOS-Workspace':'solo'};
    api('/api/dev/clean-slate/confirmation', {method:'POST', headers:soloHeaders}).then(function(result){
      if(result.status !== 200 || !result.data || typeof result.data.confirmationToken !== 'string' || !result.data.confirmationToken){
        throw new Error(result.data && result.data.message || 'Mia did not issue a clean-slate confirmation.');
      }
      return api('/api/dev/clean-slate', {
        method:'POST',
        headers:soloHeaders,
        body:{confirmationToken:result.data.confirmationToken, scope:'everything'}
      });
    }).then(function(result){
      if(result.status !== 200 || !result.data || !result.data.ok){
        throw new Error(result.data && result.data.message || 'Mia could not complete clean slate.');
      }
      clearSoloWorkspaceUiState();
      // The desktop shell also clears Electron storage and relaunches the
      // whole app (backend included) so nothing survives in memory. A plain
      // browser session can only reload.
      var relaunch = window.miaDesktop && window.miaDesktop.reset && typeof window.miaDesktop.reset.relaunch === 'function'
        ? window.miaDesktop.reset.relaunch()
        : Promise.resolve(false);
      return relaunch.catch(function(){ return false; }).then(function(relaunched){
        if(!relaunched) location.reload();
      });
    }).catch(function(error){
      setAppLoading(false);
      window.alert(error && error.message ? error.message : 'Clean slate failed.');
    });
  }

  function syncSidebarToolButtons(){
    var manager = el('#chatSidebarManageAgentsBtn');
    var managerOpen = chatInfo.mode === 'agents' && chatInfo.open;
    if(manager){
      var managerLabel = appCollaborationMode === 'multiplayer' ? 'people, agents, and bots' : 'agents and bots';
      manager.classList.toggle('active', managerOpen);
      manager.setAttribute('aria-label', managerOpen ? 'Close ' + managerLabel : 'Manage ' + managerLabel);
      manager.setAttribute('title', managerOpen ? 'Close ' + managerLabel : 'Manage ' + managerLabel);
    }
    var developer = el('#chatSidebarDeveloperBtn');
    var developerMenu = el('#chatDeveloperMenu');
    if(developer){
      var developerOpen = !!(developerMenu && developerMenu.classList.contains('open'));
      developer.classList.toggle('active', developerOpen);
      developer.setAttribute('aria-expanded', developerOpen ? 'true' : 'false');
      developer.setAttribute('aria-label', developerOpen ? 'Close developer menu' : 'Open developer menu');
    }
    var tools = el('#chatSidebarToolsBtn');
    var toolsMenu = el('#chatToolsMenu');
    if(!tools) return;
    var toolsOpen = !!(toolsMenu && toolsMenu.classList.contains('open'));
    tools.classList.toggle('active', toolsOpen);
    tools.setAttribute('aria-expanded', toolsOpen ? 'true' : 'false');
    tools.setAttribute('aria-label', toolsOpen ? 'Close tools menu' : 'Open tools menu');
  }

  // Active tasks belonging to one agent — drives the sidebar dots, the
  // header popover's "N running tasks" link, and the docked tasks panel.
  function tasksForAgent(agentId){
    return (chatWs.tasks || []).filter(function(t){ return t.agentId === agentId; });
  }

  function tasksForRoom(roomId){
    return (chatWs.tasks || []).filter(function(t){ return t.roomId === roomId; });
  }

  function automationScheduleText(automation){
    if(!automation) return '';
    if(automation.frequency === 'none') return 'Not scheduled';
    if(automation.enabled === true && !String(automation.prompt || '').trim()) return 'Paused · add a prompt';
    var prefix = automation.enabled === true ? '' : 'Paused · ';
    if(automation.frequency === 'interval'){
      var intervalMinutes = Number(automation.intervalMinutes || 0);
      if(intervalMinutes === 1) return prefix + 'Every minute';
      if(intervalMinutes === 60) return prefix + 'Every hour';
      if(intervalMinutes > 60 && intervalMinutes % 60 === 0){
        var intervalHours = intervalMinutes / 60;
        return prefix + 'Every ' + intervalHours + (intervalHours === 1 ? ' hour' : ' hours');
      }
      return prefix + 'Every ' + intervalMinutes + ' minutes';
    }
    if(automation.frequency === 'daily') return prefix + (automation.weekdaysOnly ? 'Weekdays' : 'Every day') + (automation.time ? ' at ' + automation.time : '') + (Number.isInteger(automation.utcOffsetMinutes) ? ' · ' + newsTimeZoneLabel(automation.utcOffsetMinutes) : '');
    if(automation.frequency === 'weekly') return prefix + 'Every ' + (automation.day || 'week') + (automation.time ? ' at ' + automation.time : '');
    if(automation.frequency === 'monthly') return prefix + 'Every month' + (automation.day ? ' on day ' + automation.day : '') + (automation.time ? ' at ' + automation.time : '');
    return prefix + 'Scheduled';
  }

  function automationIntervalParts(intervalMinutes){
    var minutes = Number(intervalMinutes || 5);
    if(minutes >= 60 && minutes % 60 === 0){
      return {value: minutes / 60, unit: 'hours'};
    }
    return {value: minutes, unit: 'minutes'};
  }

  function normalizedAutomationIntervalMinutes(value, unit){
    var amount = Number(value);
    if(!Number.isInteger(amount) || amount < 1) throw new Error('Enter a whole-number timer interval.');
    if(unit === 'hours'){
      if(amount > 24) throw new Error('Hour timers must be between 1 and 24 hours.');
      return amount * 60;
    }
    if(unit !== 'minutes' || amount > 60) throw new Error('Minute timers must be between 1 and 60 minutes.');
    return amount;
  }

  function botAutomationList(bot){
    if(!bot) return [];
    var source = Array.isArray(bot.automations)
      ? bot.automations
      : (bot.automation && typeof bot.automation === 'object' ? [bot.automation] : []);
    return source.slice(0, 10).map(function(automation, index){
      return Object.assign({
        id: 'automation-' + (index + 1),
        name: index === 0 ? (bot.name || 'Automation') : 'Automation ' + (index + 1)
      }, automation || {});
    });
  }

  function automationBotsForPanel(isMia, agent){
    var records = (chatWs.botRecords || []).filter(function(bot){
      return isMia || (agent && String(bot.id) === String(agent.id));
    });
    var entries = [];
    records.forEach(function(bot){
      botAutomationList(bot).forEach(function(automation){ entries.push({bot:bot, automation:automation}); });
    });
    return entries;
  }

  function automationRecordById(botId, automationId){
    var bot = (chatWs.botRecords || []).filter(function(bot){
      return bot && String(bot.id) === String(botId);
    })[0] || null;
    if(!bot) return null;
    if(automationId === undefined) return bot;
    var automation = botAutomationList(bot).filter(function(item){ return String(item.id) === String(automationId); })[0] || null;
    return automation ? {bot:bot, automation:automation} : null;
  }

  function automationDetailFields(bot, automation){
    var hasAutomation = !!automation;
    automation = automation || {};
    var fields = [];
    function add(label, value, multiline){
      if(value === undefined || value === null || String(value).trim() === '') return;
      var field = {label:label, value:String(value)};
      if(multiline) field.multiline = true;
      fields.push(field);
    }
    add('Name', automation.name);
    add('Automation ID', hasAutomation ? automation.id : null);
    add('Bot ID', bot && bot.id);
    if(hasAutomation){
      add('Status', automation.enabled === true && String(automation.prompt || '').trim() ? 'Enabled' : (automation.enabled === true ? 'Needs a prompt' : 'Disabled'));
      add('Schedule', automationScheduleText(automation));
    }
    add('Task', automation.task, true);
    add('Prompt', automation.prompt, true);
    add('Latest run', automation.lastRunAt);
    add('Latest status', automation.lastRunStatus);
    var delivery = bot && bot.hermesCronDeliveries && bot.hermesCronDeliveries[automation.id] || {};
    add('Latest delivery', delivery.deliveredAt);
    add('Latest session', delivery.sessionId);
    return fields;
  }

  function normalizedAutomationEditorPayload(bot, automationId, values){
    values = values || {};
    var name = String(values.name || '').trim();
    if(!name) throw new Error('Name is required.');
    var enabled = values.enabled === true;
    var frequency = String(values.frequency || 'interval');
    var weekdaysOnly = frequency === 'weekdays';
    if(weekdaysOnly) frequency = 'daily';
    if(['interval', 'daily', 'weekly', 'monthly'].indexOf(frequency) === -1){
      throw new Error('Choose a valid schedule.');
    }
    var automations = botAutomationList(bot);
    var existingIndex = automations.findIndex(function(item){ return String(item.id) === String(automationId || ''); });
    if(existingIndex < 0 && automations.length >= 10) throw new Error('This bot already has 10 automations.');
    var automation = existingIndex >= 0 ? Object.assign({}, automations[existingIndex]) : {
      id: 'automation-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    };
    delete automation.intervalMinutes;
    delete automation.day;
    delete automation.time;
    automation.enabled = enabled;
    automation.frequency = frequency;
    if(weekdaysOnly) automation.weekdaysOnly = true;
    else delete automation.weekdaysOnly;
    automation.name = name;
    var prompt = String(values.prompt || '').trim();
    if(prompt) automation.prompt = prompt;
    else if(enabled) throw new Error('Add the task prompt this automation should run.');
    else delete automation.prompt;
    if(frequency === 'interval'){
      automation.intervalMinutes = values.intervalValue !== undefined
        ? normalizedAutomationIntervalMinutes(values.intervalValue, values.intervalUnit)
        : normalizedAutomationIntervalMinutes(values.intervalMinutes, 'minutes');
    }
    if(frequency === 'daily' || frequency === 'weekly' || frequency === 'monthly'){
      var time = String(values.time || '').trim();
      if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid time.');
      automation.time = time;
      // Without a stored offset the backend assumes the legacy UTC-6 server
      // deployment, which misfires on a local scheduler running on wall time.
      if(!Number.isInteger(automation.utcOffsetMinutes)) automation.utcOffsetMinutes = new Date().getTimezoneOffset();
    }
    if(frequency === 'weekly'){
      var weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      var weekday = String(values.day || 'Monday');
      if(weekdays.indexOf(weekday) === -1) throw new Error('Choose a valid weekday.');
      automation.day = weekday;
    }
    if(frequency === 'monthly'){
      var monthDay = Number(values.day);
      if(!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) throw new Error('Day must be between 1 and 31.');
      automation.day = String(monthDay);
    }
    if(existingIndex >= 0) automations[existingIndex] = automation;
    else automations.push(automation);
    return {automations: automations};
  }

  function openAutomationDetail(botId, automationId, createNew){
    var bot = automationRecordById(botId);
    if(!bot) return false;
    if(createNew && botAutomationList(bot).length >= 10) return false;
    if(typeof document !== 'undefined' && document.body) document.body.classList.remove('cinema-open');
    chatInfo.mode = 'automation-detail';
    chatInfo.open = true;
    chatInfo.automationBotId = String(bot.id);
    chatInfo.automationId = createNew ? 'new' : String(automationId || '');
    renderChatInfoPane();
    return true;
  }

  function bindAutomationRows(pane){
    els('[data-automation-id]', pane).forEach(function(row){
      row.addEventListener('click', function(){
        openAutomationDetail(row.getAttribute('data-bot-id'), row.getAttribute('data-automation-id'));
      });
    });
  }

  function activeAutomationRunsForPanel(isMia, agent){
    var runs = chatWs.automationRuns || [];
    if(isMia) return runs;
    if(!agent) return [];
    return runs.filter(function(run){ return String(run.botId) === String(agent.id); });
  }

  function activeAutomationRunsForAgent(agent){
    if(!agent) return [];
    var agentId = agent.id || agent.agentId;
    return (chatWs.automationRuns || []).filter(function(run){
      return run && String(run.botId) === String(agentId);
    });
  }

  function activeAutomationRunsForRoom(roomId){
    if(!roomId) return [];
    return (chatWs.automationRuns || []).filter(function(run){
      return run && String(run.conversationId || '') === String(roomId);
    });
  }

  function runningAutomationLabel(run){
    return String(run && run.name || 'Automation') + ' automation running';
  }

  function loadActiveAutomationRuns(){
    return api('/api/automations/active').then(function(res){
      var next = res.status === 200 && res.data && Array.isArray(res.data.runs) ? res.data.runs : [];
      var changed = JSON.stringify(chatWs.automationRuns || []) !== JSON.stringify(next);
      chatWs.automationRuns = next;
      if(changed){
        renderChatSidebar();
        if(chatInfo.open && chatInfo.mode === 'automations' && !liveRefreshBlocked()) renderChatInfoPane();
      }
      return next;
    }).catch(function(){
      var changed = (chatWs.automationRuns || []).length > 0;
      chatWs.automationRuns = [];
      if(changed) renderChatSidebar();
      return [];
    });
  }

  function openRunningAutomationConversation(runId){
    var run = (chatWs.automationRuns || []).filter(function(item){
      return item && String(item.id) === String(runId);
    })[0];
    if(!run || !run.conversationId) return false;
    var conversation = (chatWs.nativeConversations || []).filter(function(item){
      return item && String(item.id) === String(run.conversationId);
    })[0] || null;
    closeChatUtilityPane();
    loadChatRoom(
      run.conversationId,
      conversation ? nativeConversationKind(conversation.type) : 'agent',
      conversation && conversation.name || run.name || 'Automation'
    );
    return true;
  }

  function bindRunningAutomationRows(pane){
    els('[data-running-automation-id]', pane).forEach(function(row){
      row.addEventListener('click', function(){
        openRunningAutomationConversation(row.getAttribute('data-running-automation-id'));
      });
    });
  }

  function nativeDispatchTask(dispatch){
    return {
      id: dispatch.id,
      roomId: dispatch.conversationId,
      agentId: dispatch.targetId,
      title: dispatch.targetType === 'gateway' ? 'Mia response' : 'Bot response',
      status: dispatch.status,
      startedAt: Date.parse(dispatch.createdAt) || Date.now(),
      kind: 'native-dispatch'
    };
  }

  function setRoomNativeDispatches(roomId, dispatches){
    chatWs.tasks = (chatWs.tasks || []).filter(function(task){
      return task.kind !== 'native-dispatch' || task.roomId !== roomId;
    }).concat((dispatches || []).filter(function(dispatch){
      return dispatch && (dispatch.status === 'pending' || dispatch.status === 'claimed');
    }).map(nativeDispatchTask));
  }

  function syncNativeDispatchFromEvent(event){
    var metadata = event && event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    var dispatchId = typeof metadata.dispatchId === 'string' ? metadata.dispatchId : '';
    if(!dispatchId) return;
    var existing = (chatWs.tasks || []).filter(function(task){ return task.id === dispatchId; })[0];
    // A deleted progress row means the dispatch was stopped: it must retire
    // the task (falling through to removal below), never resurrect it.
    if((event.senderType === 'agent' || event.senderType === 'bot') && metadata.progress === true && metadata.status !== 'failed' && !event.deletedAt){
      if(!existing){
        chatWs.tasks.push(nativeDispatchTask({
          id: dispatchId,
          conversationId: event.conversationId,
          targetId: event.senderId,
          targetType: event.senderId === 'gateway' ? 'gateway' : 'bot',
          status: 'claimed',
          createdAt: event.createdAt
        }));
      }
      return;
    }
    chatWs.tasks = (chatWs.tasks || []).filter(function(task){ return task.id !== dispatchId; });
    delete chatTaskStopPending[dispatchId];
  }

  function loadActiveNativeDispatches(roomId){
    return api(nativeConversationPath(roomId, '/dispatches/active')).then(function(res){
      setRoomNativeDispatches(roomId, res.status === 200 ? (res.data && res.data.dispatches || []) : []);
      renderLiveViews();
    }).catch(function(){
      setRoomNativeDispatches(roomId, []);
      renderLiveViews();
    });
  }

  // One composer controls the active room, so its Stop affordance targets
  // the newest active background turn in that room. The server remains the
  // authority and re-checks task ownership before cancelling anything.
  function activeRoomTask(){
    var tasks = tasksForRoom(chatWs.activeRoomId).slice().sort(function(a, b){
      return Number(b.startedAt || 0) - Number(a.startedAt || 0);
    });
    return tasks[0] || null;
  }

  var CHAT_SEND_ICON_HTML = '<svg class="cc-send-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"></path></svg>';

  function renderComposerTaskControl(){
    var button = el('#ccSend');
    if(!button) return;
    if(!chatWs.activeRoomId){
      button.classList.remove('is-stop');
      button.disabled = true;
      button.setAttribute('data-stop-task-id', '');
      button.setAttribute('aria-label', 'Select a conversation before sending');
      button.setAttribute('title', 'Select a conversation before sending');
      button.innerHTML = CHAT_SEND_ICON_HTML;
      return;
    }
    var task = activeRoomTask();
    var input = el('#ccInput');
    var hasDraft = !!(input && input.value.trim()) || !!chatAttachment.file;
    var stopping = !!(task && (task.status === 'stopping' || chatTaskStopPending[task.id]));
    var showStop = !!task && !hasDraft;
    button.classList.toggle('is-stop', showStop);
    button.disabled = !!chatAttachment.busy || stopping;
    button.setAttribute('data-stop-task-id', showStop ? task.id : '');
    button.setAttribute('aria-label', showStop ? (stopping ? 'Stopping response' : 'Stop response') : 'Send');
    button.setAttribute('title', showStop ? (stopping ? 'Stopping…' : 'Stop') : 'Send');
    button.innerHTML = showStop ? '<span class="cc-stop-square" aria-hidden="true"></span>' : CHAT_SEND_ICON_HTML;
  }

  function stopTaskFromComposer(taskId){
    var task = (chatWs.tasks || []).filter(function(candidate){ return candidate.id === taskId; })[0];
    if(!task || task.kind !== 'native-dispatch' || chatTaskStopPending[taskId]) return;
    chatTaskStopPending[taskId] = true;
    renderComposerTaskControl();
    return api(nativeConversationPath(task.roomId, '/dispatches/' + encodeURIComponent(taskId) + '/stop'), {
      method: 'POST',
      body: {}
    }).then(function(res){
      if(res.status !== 200) throw new Error(res.data && (res.data.message || res.data.error) || 'Stop failed');
      chatWs.tasks = (chatWs.tasks || []).filter(function(candidate){ return candidate.id !== taskId; });
      delete chatTaskStopPending[taskId];
      stopChatThinking(task.roomId);
      renderLiveViews();
    }).catch(function(){
      delete chatTaskStopPending[taskId];
      renderComposerTaskControl();
    });
  }

  // "Working now" is an execution state, not an agent lifecycle state.
  // An enabled agent may carry status=running/watch indefinitely while it is
  // simply available for work, so only a live background task or an in-flight
  // foreground reply earns the working treatment.
  function agentHasLiveWork(agent){
    if(!agent) return false;
    if(tasksForAgent(agent.id || agent.agentId).length > 0) return true;
    var targetName = canonicalAgentDisplayName(agent.name).toLowerCase();
    return Object.keys(chatWs.byRoom || {}).some(function(roomId){
      var state = chatWs.byRoom[roomId];
      return !!(state && state.thinking && state.thinkingAgentName &&
        canonicalAgentDisplayName(state.thinkingAgentName).toLowerCase() === targetName);
    });
  }

  // Every surface should derive "working" from the same source. Durable
  // background tasks are authoritative across sessions; the room's local
  // thinking state covers the foreground reply between Send and the native
  // response. Represent that transient reply as one indicator so the sidebar
  // cannot disagree with the message pane's "Preparing a response" state.
  function workIndicatorsForAgent(agent){
    if(!agent) return [];
    var tasks = tasksForAgent(agent.id || agent.agentId);
    if(tasks.length) return tasks;
    return agentHasLiveWork(agent) ? [{title: 'Preparing a response', transient: true}] : [];
  }

  function roomHasLocalTypingActivity(roomId){
    return !!(roomId && localChatTyping.active && localChatTyping.roomId === roomId);
  }

  function setLocalChatTypingActivity(active){
    if(localChatTyping.timer){
      clearTimeout(localChatTyping.timer);
      localChatTyping.timer = null;
    }
    var nextRoomId = active ? chatWs.activeRoomId : null;
    var changed = localChatTyping.active !== !!active || localChatTyping.roomId !== nextRoomId;
    localChatTyping.active = !!active;
    localChatTyping.roomId = nextRoomId;
    if(active){
      localChatTyping.timer = setTimeout(function(){
        localChatTyping.timer = null;
        setLocalChatTypingActivity(false);
      }, 2500);
    }
    if(changed) renderChatSidebar();
  }

  function roomHasModelResponseActivity(roomId){
    if(!roomId) return false;
    var state = chatWs.byRoom && chatWs.byRoom[roomId];
    return tasksForRoom(roomId).length > 0 || !!(state && state.thinking);
  }

  function sidebarEntryHasActivity(entry){
    if(!entry) return false;
    if(roomHasLocalTypingActivity(entry.roomId)) return true;
    if(roomHasModelResponseActivity(entry.roomId)) return true;
    return activeAutomationRunsForRoom(entry.roomId).length > 0;
  }

  function renderChatActivityIndicator(active, unread){
    if(active) return '<span class="chat-activity-dot is-live" aria-label="Active now" title="Active now"></span>';
    if(unread) return '<span class="chat-activity-dot is-unread" aria-label="Unread messages" title="Unread messages"></span>';
    return '';
  }

  function chatRoomState(roomId){
    if(!chatWs.byRoom[roomId]) chatWs.byRoom[roomId] = {messages: [], lastTs: 0, lastSequence: 0, polling: false, thinking: false, thinkingTimer: null, thinkingAgentName: null, selectedAgentId: null, mentionRoster: null, chatSuggestions: null, openThreadRoot: null, localWelcome: null, sidebarPreviewLoading: false, sidebarPreviewLoaded: false, sidebarAttentionPolling: false, historyCursor: null, historyLoading: false, historyComplete: false, historyInitialized: false, historyRequestId: 0, historyEdits: {}, followLatest: true, newVisibleMessages: false, chatScrollTop: 0, chatScrollAnchor: null, chatScrollRevision: 0};
    return chatWs.byRoom[roomId];
  }

  function syncChatJumpLatest(thread, state){
    var button = el('#chatJumpLatest');
    if(window.MiaChatScroll) window.MiaChatScroll.syncButton(button, thread, state);
    else if(button) button.hidden = true;
    if(button){
      var hasNew = !!(state && state.newVisibleMessages);
      var label = el('.chat-jump-latest-label', button);
      button.classList.toggle('has-new-messages', hasNew);
      button.setAttribute('aria-label', hasNew ? 'New messages. Jump to latest message' : 'Jump to latest message');
      button.title = hasNew ? 'New messages — jump to latest' : 'Jump to latest message';
      if(label) label.textContent = hasNew ? 'New messages' : '';
    }
  }

  function captureRenderedChatScroll(thread){
    var roomId = thread && thread.getAttribute('data-chat-scroll-room');
    var state = roomId && chatWs.byRoom[roomId];
    if(state && window.MiaChatScroll) window.MiaChatScroll.capture(thread, state);
  }

  function replaceChatTimeline(thread, roomId, state, html, options){
    thread.setAttribute('data-chat-scroll-room', roomId);
    if(window.MiaChatScroll) window.MiaChatScroll.replace(thread, html, state, options || {});
    else thread.innerHTML = html;
    syncChatJumpLatest(thread, state);
  }

  function absorbChatHistoryEdits(state, edits){
    if(!state.historyEdits) state.historyEdits = {};
    (edits || []).forEach(function(edit){
      if(!edit || !edit.targetId) return;
      var previous = state.historyEdits[edit.targetId];
      if(!previous || Number(edit.ts || 0) > Number(previous.ts || 0)) state.historyEdits[edit.targetId] = edit;
    });
  }

  function applyKnownChatHistoryEdits(state, messages){
    var edits = state.historyEdits || {};
    return (messages || []).map(function(message){
      var edit = edits[message.id];
      if(!edit || edit.sender !== message.sender || Number(edit.ts || 0) <= Number(message.editTs || 0)) return message;
      return Object.assign({}, message, {body: edit.body, editTs: edit.ts});
    });
  }
  function chatSidebarRoomIds(){
    var ids = {};
    function add(roomId){ if(roomId) ids[roomId] = true; }
    add(chatWs.rooms.home && chatWs.rooms.home.roomId);
    chatWs.rooms.departments.forEach(function(room){ add(room.roomId); });
    chatWs.rooms.dms.forEach(function(room){ add(room.roomId); });
    if(chatWs.gatewayAgent) add(chatWs.gatewayAgent.roomId || chatWs.gatewayAgent.nativeConversationId);
    chatWs.allAgents.forEach(function(agent){ add(agent.roomId || agent.nativeConversationId); });
    (chatWs.humans || []).forEach(function(human){
      var dm = directHumanDmFor(human.email);
      add(dm && dm.roomId);
    });
    return Object.keys(ids);
  }
  function chatAttentionLabel(roomId){
    if(chatWs.rooms.home && chatWs.rooms.home.roomId === roomId) return 'Multiplayer Test';
    var dept = chatWs.rooms.departments.filter(function(room){ return room.roomId === roomId; })[0];
    if(dept) return dept.department;
    var dm = chatWs.rooms.dms.filter(function(room){ return room.roomId === roomId; })[0];
    if(dm) return dmLabel(dm);
    if(chatWs.gatewayAgent && (chatWs.gatewayAgent.roomId === roomId || chatWs.gatewayAgent.nativeConversationId === roomId)) return 'Mia';
    var agent = chatWs.allAgents.filter(function(item){ return item.roomId === roomId || item.nativeConversationId === roomId; })[0];
    return agent ? agent.name : 'New message';
  }
  function desktopNotificationPermission(){
    return typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported';
  }
  function syncDesktopNotificationControl(){
    var status = el('#chatAcctNotificationsStatus');
    if(!status) return;
    var permission = desktopNotificationPermission();
    status.textContent = permission === 'granted' ? 'On' : permission === 'denied' ? 'Blocked' : permission === 'unsupported' ? 'Unavailable' : 'Off';
  }
  function requestDesktopNotifications(){
    var permission = desktopNotificationPermission();
    if(permission === 'unsupported'){
      showBenchToast('Desktop notifications are not supported in this browser.');
      return;
    }
    if(permission === 'granted'){
      showBenchToast('Desktop notifications are already on.');
      syncDesktopNotificationControl();
      return;
    }
    window.Notification.requestPermission().then(function(next){
      syncDesktopNotificationControl();
      showBenchToast(next === 'granted' ? 'Desktop notifications are on.' : 'Desktop notifications were not enabled.');
    }).catch(function(){
      syncDesktopNotificationControl();
      showBenchToast('Desktop notifications could not be enabled.');
    });
  }
  function notifyDesktopChatMessage(roomId, message){
    if(roomId === chatWs.activeRoomId || desktopNotificationPermission() !== 'granted') return;
    var parsed = message && isHumanSender(message.sender)
      ? parseSignedHumanBody(message.body)
      : parseSignedBody(message && message.body);
    var body = parsed && parsed.text ? parsed.text : (message && message.body) || 'New message';
    body = excerpt(String(body).replace(/\s+/g, ' ').trim(), 120);
    try {
      var notification = new window.Notification('Mia · ' + chatAttentionLabel(roomId), {
        body: body || 'New message',
        tag: 'mia-chat-' + roomId
      });
      notification.onclick = function(){ window.focus(); notification.close(); };
    } catch(err) {}
  }
  function isIncomingAttentionMessage(message){
    if(!message) return false;
    if(!isHumanSender(message.sender)) return true;
    var parsed = parseSignedHumanBody(message.body);
    return !!(parsed && parsed.agent && parsed.agent.toLowerCase() !== String(currentUser || '').toLowerCase());
  }
  function chatRelTime(ts){
    var mins = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if(mins < 1) return 'just now';
    if(mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if(hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }
  function humanFileSize(bytes){
    var n = Number(bytes) || 0;
    if(n < 1024) return n + ' B';
    if(n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if(n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
  function chatSenderLabel(){ return (currentUser || '').split('@')[0] || 'you'; }

  /* Sender identity -> "is this a human" isn't just "is it me": department
     rooms carry multiple humans (alice, bob) and the bot posts under a
     third identity (miaos) that's neither. Simplest correct rule (per
     addendum #3): anything that isn't a known human renders as bot. */
  function chatKnownHumanLocalparts(){
    var localparts = {};
    function add(email){
      var local = String(email || '').toLowerCase().split('@')[0];
      if(local) localparts[local] = true;
    }
    add(currentUser);
    (chatWs.humans || []).forEach(function(h){ add(h.email); });
    var state = chatWs.activeRoomId && chatWs.byRoom[chatWs.activeRoomId];
    var rosterHumans = state && state.mentionRoster && state.mentionRoster.humans || [];
    rosterHumans.forEach(function(h){ add(h.email); });
    return localparts;
  }
  function isHumanSender(sender){
    var identity = String(sender || '').toLowerCase();
    var local = identity.split('@')[0];
    var known = chatKnownHumanLocalparts();
    // Native events identify a human with the full account email, while the
    // legacy renderer's roster is keyed by localpart. Resolve both forms so
    // native user messages do not fall through to the agent renderer.
    return !!(known[identity] || known[local]);
  }
  // Backend sanitization is authoritative. This browser-side pass also keeps
  // internal task plumbing out of the visible timeline: bot messages
  // containing only internal reasoning/TASK plumbing disappear locally, and
  // mixed messages retain their final answer. Human-authored content is never
  // passed through this sanitizer.
  var CHAT_SECURITY = window.MiaChatSecurity;
  function normalizeChatMessages(messages){
    if(!CHAT_SECURITY || !CHAT_SECURITY.normalizeMessages) return messages || [];
    return CHAT_SECURITY.normalizeMessages(messages, isHumanSender);
  }
  function isLegacyTaskFiller(body){
    var text = String(body || '').replace(/^\s*\[[^\]\n]{1,120}\]\s*/, '').trim();
    return text === 'I’m on it — I’ll keep you posted here.' ||
      text === 'I’m waiting for a turn to start — I’ll keep you posted.';
  }
  function displayBotBody(body){
    var visible = (!CHAT_SECURITY || !CHAT_SECURITY.sanitizeBotMessage)
      ? String(body || '') : CHAT_SECURITY.sanitizeBotMessage(body);
    return isLegacyTaskFiller(visible) ? '' : visible;
  }

  /* A department room's bot reply is signed "[AgentName] ..." so one room can
     persona-switch between its members — strip that tag and surface it as the
     bubble's brand label instead of leaving it sitting in the body text. */
  function parseSignedBody(body){
    var m = /^\[([^\]]{1,40})\]\s*/.exec(body || '');
    if(!m) return {agent: null, text: body};
    return {agent: m[1], text: body.slice(m[0].length)};
  }

  // Human signatures are always email labels added by the backend. Do not
  // treat arbitrary bracketed prose (for example, "[todo] ...") as an
  // identity when a human posts in a single-person room.
  function parseSignedHumanBody(body){
    var parsed = parseSignedBody(body);
    if(!parsed.agent || parsed.agent.indexOf('@') === -1) return {agent: null, text: body};
    return parsed;
  }

  // Long chat messages are useful context, but a full historical answer can
  // take over the timeline. Keep the complete text in the message and show
  // the first 150 words until the user explicitly expands it. Compact-window
  // height is capped in CSS as well, because the same word count wraps into
  // many more lines when the center column gets narrower.
  var CHAT_MESSAGE_PREVIEW_WORDS = 150;
  function chatMessageWordCount(text){
    var raw = String(text || '').trim();
    return raw ? raw.split(/\s+/).length : 0;
  }
  function chatMessagePreview(text, maxWords){
    var raw = String(text || '').trim();
    if(!raw) return '';
    var matcher = /\S+/g;
    var end = 0;
    var count = 0;
    var match;
    while(count < maxWords && (match = matcher.exec(raw))){
      count++;
      end = matcher.lastIndex;
    }
    if(!match || !matcher.exec(raw)) return raw;
    return raw.slice(0, end).replace(/\s+$/, '') + '…';
  }
  function isPreReasoningNotice(text){
    return /^\s*(?:Mia\s+)?Pre-reasoning(?:\s|:)/i.test(String(text || ''));
  }
  function chatPreReasoningHtml(text, compactBrowserMessage){
    return chatExpandableMessageHtml(text, true, compactBrowserMessage);
  }
  function chatExpandableMessageHtml(text, isPreReasoning, compactBrowserMessage){
    var raw = String(text || '').trim();
    var wordCount = chatMessageWordCount(raw);
    var truncated = wordCount > CHAT_MESSAGE_PREVIEW_WORDS;
    var hasMore = !!compactBrowserMessage || truncated;
    var preview = hasMore ? chatMessagePreview(raw, CHAT_MESSAGE_PREVIEW_WORDS) : raw;
    var previewClass = isPreReasoning ? ' chat-pre-reasoning-preview' : '';
    var fullClass = isPreReasoning ? ' chat-pre-reasoning-full' : '';
    var toggleClass = isPreReasoning ? ' chat-pre-reasoning-toggle' : '';
    var previewAttr = isPreReasoning ? ' data-pre-reasoning-preview' : '';
    var compactPreviewAttr = compactBrowserMessage ? ' data-chat-compact-preview' : '';
    var truncatedAttr = truncated ? ' data-chat-truncated' : '';
    var fullAttr = isPreReasoning ? ' data-pre-reasoning-full' : '';
    var toggleAttr = isPreReasoning ? ' data-pre-reasoning-toggle' : '';
    var labelAttr = isPreReasoning ? ' data-pre-reasoning-label' : '';
    var toggle = hasMore
      ? '<button type="button" class="chat-expandable-toggle' + toggleClass + '" data-chat-expand-toggle' + toggleAttr + ' aria-expanded="false">' +
          '<span data-chat-expand-label' + labelAttr + '>Show more</span><span class="chat-expandable-chevron chat-pre-reasoning-chevron" aria-hidden="true"></span>' +
        '</button>'
      : '';
    var previewHtml = isPreReasoning ? esc(preview) : mdLite(preview);
    var full = hasMore ? '<div class="chat-expandable-full' + fullClass + '" data-chat-expand-full' + fullAttr + ' hidden>' + mdLite(raw) + '</div>' : '';
    return '<div class="chat-expandable-preview' + previewClass + '" data-chat-expand-preview' + previewAttr + compactPreviewAttr + truncatedAttr + '>' + previewHtml + '</div>' + toggle + full;
  }
  function syncChatCompactPreviewVisibility(thread){
    if(!thread) return;
    els('[data-chat-compact-preview]', thread).forEach(function(preview){
      var card = preview.closest('.chat-expandable-message, .chat-pre-reasoning');
      var toggle = card && card.querySelector('[data-chat-expand-toggle]');
      if(!toggle) return;
      // A word-truncated preview ends in "…" no matter how it is laid out:
      // fitting its box does not mean the message is whole, so the toggle
      // must stay visible regardless of measured overflow.
      if(preview.hasAttribute('data-chat-truncated')){
        toggle.hidden = false;
        toggle.setAttribute('aria-hidden', 'false');
        return;
      }
      // A hidden or not-yet-laid-out panel measures 0×0, which looks like
      // "fits" and would hide the toggle on a message that is actually cut.
      // Leave the toggle visible until a real measurement says otherwise.
      if(!preview.clientHeight){
        toggle.hidden = false;
        toggle.setAttribute('aria-hidden', 'false');
        return;
      }
      var fits = preview.scrollHeight <= preview.clientHeight + 1;
      preview.classList.toggle('chat-compact-preview-overflow', !fits);
      toggle.hidden = fits;
      toggle.setAttribute('aria-hidden', fits ? 'true' : 'false');
    });
  }
  function wireChatExpandableMessages(thread){
    els('[data-chat-expand-toggle]', thread).forEach(function(toggle){
      toggle.addEventListener('click', function(){
        var card = toggle.closest('.chat-expandable-message, .chat-pre-reasoning');
        if(!card) return;
        var preview = card.querySelector('[data-chat-expand-preview]');
        var full = card.querySelector('[data-chat-expand-full]');
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        toggle.classList.toggle('expanded', !expanded);
        if(preview) preview.hidden = !expanded;
        if(full) full.hidden = expanded;
        var label = toggle.querySelector('[data-chat-expand-label]');
        if(label) label.textContent = expanded ? 'Show more' : 'Show less';
      });
    });
    syncChatCompactPreviewVisibility(thread);
    if(window.requestAnimationFrame) window.requestAnimationFrame(function(){ syncChatCompactPreviewVisibility(thread); });
    // The compact browser panel can be hidden or mid-layout when messages
    // render; re-measure whenever the thread's size actually changes so the
    // toggle reflects real overflow instead of a 0-height measurement.
    if(window.ResizeObserver && !thread._compactPreviewObserver){
      thread._compactPreviewObserver = new ResizeObserver(function(){
        syncChatCompactPreviewVisibility(thread);
      });
      thread._compactPreviewObserver.observe(thread);
    }
  }

  // Only failures that can be resolved by replaying the same agent turn get a
  // Retry action. Authentication, permission, and reconnect failures need a
  // different user action, so they deliberately never match this list.
  function chatRetryableFailure(text){
    var normalized = String(text || '').trim();
    if(!normalized || /reconnect(?:ed|ing)?\b|needs to be reconnected|in Plugins\b/i.test(normalized)) return false;
    return [
      /^I couldn't safely apply the spreadsheet (?:update|layout)\./i,
      /^Google didn't respond in time, so I didn't change the spreadsheet\./i,
      /^I couldn't apply the spreadsheet update\./i,
      /^I ran out of time before finishing\./i,
      /^Sorry\s*[—-]\s*I ran into a problem working on that and couldn't finish\./i
    ].some(function(pattern){ return pattern.test(normalized); });
  }

  var chatRetryAttempts = {};
  function wireChatRetryActions(root){
    els('[data-chat-retry]', root).forEach(function(button){
      button.addEventListener('click', function(){
        var roomId = chatWs.activeRoomId;
        var state = roomId && chatRoomState(roomId);
        var threadRootId = state && state.openThreadRoot;
        var eventId = button.getAttribute('data-retry-event-id') || '';
        if(!roomId || !threadRootId || !eventId || chatRetryAttempts[eventId]) return;
        chatRetryAttempts[eventId] = true;
        button.disabled = true;
        button.textContent = 'Retrying…';
        Promise.resolve(sendActiveRoomMessage('Try that again.', threadRootId, null, roomId)).then(function(res){
          if(res && res.status === 200){
            button.textContent = 'Retried';
            return;
          }
          delete chatRetryAttempts[eventId];
          button.disabled = false;
          button.textContent = 'Retry';
        });
      });
    });
  }

  // Who a suggestion pill click should re-address: department/DM/home rooms
  // are silent by default (see backend/reply-routing.js's resolveReplyRouting
  // — an untagged message there reaches nobody unless an agent/Mia is
  // tagged), so filling the composer with a bare pill leaves the user
  // hanging same as if they'd typed it themselves.
  // Scans this room's already-loaded thread, newest first:
  //   1. the most recent AGENT-authored message's attribution — same
  //      [AgentName] unsigning chatMsgHtml uses for the bubble's name/tag,
  //      reused verbatim rather than re-deriving it. parseSignedBody
  //      returns agent:null for home's gateway bot (its replies are never
  //      signed), so a gateway-only history correctly yields nothing here
  //      instead of misattributing to it.
  //   2. else the most recent USER message that @-tagged a roster agent by
  //      name, matched the same way the composer's own send-time
  //      "did I address someone" check does (nameTagged, above).
  function lastAddressedAgentInRoom(roomId){
    if(!roomId) return null;
    var state = chatRoomState(roomId);
    var messages = state.messages || [];
    for(var i = messages.length - 1; i >= 0; i--){
      var m = messages[i];
      if(m.system || isHumanSender(m.sender)) continue;
      var parsed = parseSignedBody(m.body);
      if(parsed.agent) return parsed.agent;
    }
    var rosterAgents = (state.mentionRoster || {}).agents || [];
    for(var j = messages.length - 1; j >= 0; j--){
      var um = messages[j];
      if(um.system || !isHumanSender(um.sender)) continue;
      var bodyLower = String(um.body || '').toLowerCase();
      var hit = rosterAgents.filter(function(a){ return a.name && a.id !== 'gateway' && bodyLower.indexOf('@' + a.name.toLowerCase()) !== -1; })[0];
      if(hit) return hit.name;
    }
    return null;
  }

  // Mia is the Agent. Every other Mote is a Bot, regardless of its
  // department or current room.
  function agentTagFor(brand){
    if(isMiaOrchestrator(brand)) return 'Agent';
    return 'Bot';
  }

  function canonicalAgentDisplayName(name){
    var value = String(name || '').trim();
    return isMiaOrchestrator(value) ? 'Mia' : (value || 'bot');
  }

  // Native events keep the signed display name that was current when a reply was
  // posted. If an agent is renamed later, old room events can still say
  // "New Agent" while the live roster correctly says "Researcher X". Use
  // the current room roster only when there is exactly one non-Mia agent to
  // avoid guessing in a multi-agent department or home room.
  function currentAgentDisplayNameForMessage(name){
    var parsed = canonicalAgentDisplayName(name);
    if(isMiaOrchestrator(parsed)) return 'Mia';
    var roomId = chatWs.activeRoomId;
    var state = roomId && chatRoomState(roomId);
    var rosterAgents = state && state.mentionRoster && !state.mentionRoster.loading
      ? (state.mentionRoster.agents || []) : [];
    var exact = rosterAgents.filter(function(a){
      return String(a.name || '').trim().toLowerCase() === parsed.toLowerCase();
    })[0];
    if(exact) return exact.name;
    var roomAgents = rosterAgents.filter(function(a){ return !isMiaOrchestrator(a.name, a.id); });
    if(roomAgents.length === 1) return roomAgents[0].name;
    if(chatWs.activeKind === 'agent' && chatWs.activeLabel && !isMiaOrchestrator(chatWs.activeLabel)) {
      return chatWs.activeLabel;
    }
    return parsed;
  }

  // Renders the optional structured-data blocks the mock depicts under an
  // agent's answer (metric cards, source chips, a pattern-detection callout)
  // — dormant until a message actually carries m.facts/m.sources/m.flag, so
  // today's real messages (plain body only) never trigger fake data.
  function chatMsgExtras(m){
    var html = '';
    if(m.facts && m.facts.length){
      html += '<div class="chat-fact-grid">' + m.facts.map(function(f){
        var tone = f.tone === 'warn' ? ' warn' : '';
        return '<div class="chat-fact-card"><div class="chat-fact-label">' + esc(f.label) + '</div>' +
          '<div class="chat-fact-row"><span class="chat-fact-value">' + esc(f.value) + '</span>' +
          (f.delta ? '<span class="chat-fact-delta' + tone + '">' + esc(f.delta) + '</span>' : '') + '</div></div>';
      }).join('') + '</div>';
    }
    if(m.sources && m.sources.length){
      html += '<div class="msg-sources"><span class="ms-label">Source</span>' +
        m.sources.map(function(s){ return '<span class="msg-source-chip">' + esc(s) + '</span>'; }).join('') + '</div>';
    }
    if(m.flag){
      html += '<div class="msg-callout"><div><div class="mc-label">' + esc(m.flag.label || 'Flagged') + '</div>' +
        '<div class="mc-body">' + esc(m.flag.body || '') + '</div></div></div>';
    }
    return html;
  }

  // esc()+linkify for message bodies: URLs become real links, everything else
  // stays escaped exactly as before. Trailing punctuation (incl. the ")" in
  // "(https://…/)" asides) is left outside the link; a ")" is kept only when
  // the URL itself contains a "(" (wikipedia-style paths).
  function linkifyEsc(text){
    var s = String(text == null ? '' : text);
    var re = /https?:\/\/[^\s<>"]+/g;
    var out = '', last = 0, match;
    while((match = re.exec(s))){
      var url = match[0];
      while(/[).,;:!?’”]$/.test(url)){
        if(url.slice(-1) === ')' && url.indexOf('(') !== -1) break;
        url = url.slice(0, -1);
      }
      out += esc(s.slice(last, match.index));
      out += '<a href="' + esc(url) + '" data-chat-web-link>' + esc(url) + '</a>';
      last = match.index + url.length;
    }
    out += esc(s.slice(last));
    return out;
  }

  // Lite markdown for chat bubbles: agent replies can include **bold**,
  // *em*, `code`, "- " lists, and #-headings that used to render as raw
  // marker characters. Escape-then-transform order is load-bearing: every
  // leaf of raw text goes through esc()/linkifyEsc() BEFORE any tags are
  // added, so message content can never smuggle HTML in. mdLite (below)
  // owns BLOCK structure — real <p>/<ul>/<ol> with CSS margins, so wrapped
  // list items hang-indent and paragraphs retain readable spacing. mdInline
  // owns the inline spans within one block.
  function markdownPreviewText(raw){
    var text = String(raw == null ? '' : raw);
    text = text.replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1');
    text = text.replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1');
    text = text.replace(/`([^`\n]+)`/g, '$1');
    text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/gm, '');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    text = text.replace(/__([^_\n]+)__/g, '$1');
    text = text.replace(/~~([^~\n]+)~~/g, '$1');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
    text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2');
    return text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
  }
  function renderMathExpression(raw, display){
    var source = String(raw == null ? '' : raw).trim();
    var html = esc(source);
    html = html.replace(/\\text\{([^{}]*)\}/g, '<span class="chat-math-text">$1</span>');
    var commands = {
      times:'×', cdot:'·', div:'÷', pm:'±', le:'≤', ge:'≥', ne:'≠', approx:'≈',
      infty:'∞', rightarrow:'→', leftarrow:'←', alpha:'α', beta:'β', gamma:'γ',
      delta:'δ', theta:'θ', lambda:'λ', mu:'μ', pi:'π', sigma:'σ', phi:'φ', omega:'ω'
    };
    Object.keys(commands).forEach(function(command){
      html = html.replace(new RegExp('\\\\' + command + '\\b', 'g'), commands[command]);
    });
    html = html.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>').replace(/_([A-Za-z0-9+-])/g, '<sub>$1</sub>');
    html = html.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>').replace(/\^([A-Za-z0-9+-])/g, '<sup>$1</sup>');
    html = html.replace(/\\(?:left|right)\b/g, '').replace(/[{}]/g, '').replace(/\\([A-Za-z]+)/g, '$1');
    var label = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    return '<span class="chat-math' + (display ? ' chat-math-block' : ' chat-math-inline') + '" role="math" aria-label="' + esc(label) + '">' + html + '</span>';
  }
  function mdInline(raw){
    // Keep a bold code span as one token. Splitting on backticks alone turns
    // **`file.pdf`** into three fragments, so neither pair of ** markers can
    // be matched and the presentation syntax leaks into the rendered chat.
    return String(raw == null ? '' : raw).split(/(\*\*`[^`\n]+`\*\*|`[^`\n]+`)/g).map(function(seg){
      if(/^\*\*`[^`\n]+`\*\*$/.test(seg)) return '<strong><code>' + esc(seg.slice(3, -3)) + '</code></strong>';
      if(/^`[^`\n]+`$/.test(seg)) return '<code>' + esc(seg.slice(1, -1)) + '</code>';
      var math = [];
      seg = seg.replace(/\\\(([^\n]+?)\\\)|\$([^$\n]+)\$/g, function(_match, parenMath, dollarMath){
        var index = math.length;
        math.push(renderMathExpression(parenMath === undefined ? dollarMath : parenMath, false));
        return 'MIAOSMATHTOKEN' + index + 'END';
      });
      var html = linkifyEsc(seg);
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // word-boundary guards keep snake_case and URL underscores untouched
      html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
      html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
      return html.replace(/MIAOSMATHTOKEN(\d+)END/g, function(_token, index){ return math[Number(index)] || ''; });
    }).join('');
  }
  // A line counts as a table row once it's wrapped in pipes on both ends —
  // deliberately loose (real GFM requires a leading pipe only optionally),
  // since this only has to catch what models actually emit, not validate
  // arbitrary markdown.
  function isPipeTableLine(line){
    var t = line.trim();
    return t.length >= 2 && t.charAt(0) === '|' && t.charAt(t.length - 1) === '|';
  }
  // The GFM header-separator row: only pipes, dashes, colons (alignment),
  // and whitespace, with at least one dash so an all-blank/empty row can't
  // false-positive.
  function isPipeTableSeparator(line){
    var t = line.trim();
    return /^[|:\-\s]+$/.test(t) && t.indexOf('-') !== -1;
  }
  function pipeTableCells(line){
    var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split('|').map(function(c){ return c.trim(); });
  }
  function pipeTableRowHtml(cells, tag){
    return '<tr>' + cells.map(function(c){ return '<' + tag + '>' + mdInline(c) + '</' + tag + '>'; }).join('') + '</tr>';
  }
  function pipeTableHtml(rows){
    var hasHeader = rows.length > 1 && isPipeTableSeparator(rows[1]);
    if(hasHeader){
      var theadHtml = pipeTableRowHtml(pipeTableCells(rows[0]), 'th');
      var tbodyHtml = rows.slice(2).map(function(r){ return pipeTableRowHtml(pipeTableCells(r), 'td'); }).join('');
      return '<div class="chat-md-table"><table><thead>' + theadHtml + '</thead><tbody>' + tbodyHtml + '</tbody></table></div>';
    }
    // No separator row (models sometimes skip it) — no way to tell which
    // row, if any, was meant as a header, so every row renders as a plain
    // body row rather than guessing.
    var bodyOnlyHtml = rows.map(function(r){ return pipeTableRowHtml(pipeTableCells(r), 'td'); }).join('');
    return '<div class="chat-md-table"><table><tbody>' + bodyOnlyHtml + '</tbody></table></div>';
  }
  // Block markers. Bullets accept -, *, and the literal •/· characters
  // models emit when they've decided to draw the list themselves.
  var MD_BULLET_RE = /^\s*[-*•·]\s+(.*)$/;
  var MD_NUM_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;
  var MD_HEAD_RE = /^\s*#{1,4}\s+(.*)$/;
  function mdLite(text){
    var lines = String(text == null ? '' : text).split('\n');
    var blocks = [];
    var i = 0;
    // A pipe line only starts a table when the NEXT line is also one — a
    // single isolated "a | b |" in prose stays prose (and, load-bearing:
    // the paragraph scanner below breaks on the same test, so a lone pipe
    // line can never wedge the outer loop).
    function tableStartsAt(k){
      return isPipeTableLine(lines[k]) && k + 1 < lines.length && isPipeTableLine(lines[k + 1]);
    }
    function mathStartsAt(k){ return String(lines[k] || '').trim() === '\\['; }
    while(i < lines.length){
      var t = lines[i].trim();
      if(t === ''){ i++; continue; }
      if(/^```/.test(t)){
        var code = [];
        i++;
        while(i < lines.length && !/^```\s*$/.test(lines[i].trim())){ code.push(lines[i]); i++; }
        if(i < lines.length) i++;
        blocks.push('<pre class="chat-md-code"><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if(mathStartsAt(i)){
        var expression = [];
        i++;
        while(i < lines.length && String(lines[i] || '').trim() !== '\\]'){ expression.push(lines[i]); i++; }
        if(i < lines.length) i++;
        blocks.push(renderMathExpression(expression.join(' '), true));
        continue;
      }
      if(tableStartsAt(i)){
        var rows = [];
        while(i < lines.length && isPipeTableLine(lines[i])){ rows.push(lines[i]); i++; }
        blocks.push(pipeTableHtml(rows));
        continue;
      }
      if(/^-{3,}$/.test(t)){ blocks.push('<hr class="chat-md-hr">'); i++; continue; }
      if(MD_BULLET_RE.test(lines[i])){
        var items = [];
        var m;
        while(i < lines.length && (m = MD_BULLET_RE.exec(lines[i]))){ items.push('<li>' + mdInline(m[1]) + '</li>'); i++; }
        blocks.push('<ul class="chat-md-list">' + items.join('') + '</ul>');
        continue;
      }
      if(MD_NUM_RE.test(lines[i])){
        var nitems = [];
        var start = MD_NUM_RE.exec(lines[i])[1];
        var n;
        while(i < lines.length && (n = MD_NUM_RE.exec(lines[i]))){ nitems.push('<li>' + mdInline(n[2]) + '</li>'); i++; }
        blocks.push('<ol class="chat-md-list" start="' + esc(start) + '">' + nitems.join('') + '</ol>');
        continue;
      }
      var h = MD_HEAD_RE.exec(lines[i]);
      if(h){ blocks.push('<p class="chat-md-h">' + mdInline(h[1]) + '</p>'); i++; continue; }
      // Paragraph: consecutive plain lines, single newlines kept as <br>
      // (deliberate short lines — addresses, poems — survive; wrapped prose
      // reflows because the model sends it unwrapped anyway).
      var para = [];
      while(i < lines.length){
        var pt = lines[i].trim();
        if(pt === '' || MD_BULLET_RE.test(lines[i]) || MD_NUM_RE.test(lines[i]) ||
           MD_HEAD_RE.test(lines[i]) || /^-{3,}$/.test(pt) || /^```/.test(pt) || mathStartsAt(i) || tableStartsAt(i)) break;
        para.push(mdInline(lines[i]));
        i++;
      }
      blocks.push('<p class="chat-md-p">' + para.join('<br>') + '</p>');
    }
    return blocks.join('');
  }

  // Which human posted this message, for grouping: the signed-body email
  // lowercased, or 'me' when unsigned / it's the current user. Must resolve
  // identity exactly the way chatMsgHtml's isHuman branch does, or a run of
  // messages could group under the wrong name.
  function chatHumanSenderKey(m){
    var email = parseSignedHumanBody(m.body).agent;
    if(!email || email.toLowerCase() === (currentUser || '').toLowerCase()) return 'me';
    return email.toLowerCase();
  }

  // A message stays deletable for any user UNLESS it's human-signed with
  // someone else's email — mirrors the backend's own delete authorization
  // authorization rule exactly (see stripHumanSignedBody there), so a button
  // never offers a delete the server would then 403 on.
  function chatMsgDeletable(m){
    if(m.system || m.pending) return false;
    if(isAdmin) return true; // admins can delete anyone's messages (server enforces the same rule)
    if(!isHumanSender(m.sender)) return true;
    var senderEmail = parseSignedHumanBody(m.body).agent;
    if(!senderEmail) return true;
    return senderEmail.toLowerCase() === (currentUser || '').toLowerCase();
  }

  // Editing is deliberately narrower than deletion: only a human-authored
  // prompt belonging to the signed-in user may be re-sent. The original
  // event is not changed; the edit action creates a new root prompt.
  function chatMsgEditable(m){
    if(m.system || m.pending || !isHumanSender(m.sender)) return false;
    var senderEmail = parseSignedHumanBody(m.body).agent;
    if(!senderEmail) return true;
    return senderEmail.toLowerCase() === (currentUser || '').toLowerCase();
  }

  function editableChatPromptForEvent(roomId, eventId){
    var state = roomId && chatRoomState(roomId);
    var message = state && (state.messages || []).filter(function(m){ return m.id === eventId; })[0];
    if(!message || !chatMsgEditable(message)) return null;
    var parsed = parseSignedHumanBody(message.body);
    return String(parsed.agent ? parsed.text : message.body || '').trim();
  }

  // Older background-task acknowledgments stored the clock/status sentence in
  // the event store. Keep that history intact, but hide the obsolete UI line when it
  // is rendered; new task replies seed a real thread instead.
  function stripLegacyBackgroundStatus(text){
    return String(text || '')
      .replace(/\n\s*⏳?\s*working on this in the background\s*[—-]\s*I[’']ll post the final result here\.?\s*$/i, '')
      .replace(/\s*\(still working on this in the background\)\s*$/i, '')
      .trim();
  }

  function isLatestLiveProgressMessage(message){
    if(!message || !message.nativeProgress || !message.nativeDispatchId) return false;
    // Diagnostic (debug) rows are durable transcript content, not the
    // transient "working…" status row — never give them the live pulse.
    if(message.nativeDiagnostic) return false;
    var active = (chatWs.tasks || []).some(function(task){
      return task.id === message.nativeDispatchId && task.kind === 'native-dispatch';
    });
    if(!active) return false;
    var state = chatWs.activeRoomId && chatWs.byRoom[chatWs.activeRoomId];
    var messages = state && Array.isArray(state.messages) ? state.messages : [];
    for(var i = messages.length - 1; i >= 0; i--){
      if(messages[i].nativeProgress && messages[i].nativeDispatchId === message.nativeDispatchId){
        return messages[i].id === message.id;
      }
    }
    return false;
  }

  function isSupersededNativeProgressMessage(message){
    if(!message || !message.nativeProgress || !message.nativeDispatchId) return false;
    // Debug-toggle output must stay visible after the final reply lands;
    // only the transient status rows ("I'm working through this now.")
    // are superseded by it.
    if(message.nativeDiagnostic) return false;
    var state = chatWs.activeRoomId && chatWs.byRoom[chatWs.activeRoomId];
    var messages = state && Array.isArray(state.messages) ? state.messages : [];
    return messages.some(function(candidate){
      return candidate.id !== message.id &&
        candidate.nativeDispatchId === message.nativeDispatchId &&
        !candidate.nativeProgress &&
        Number(candidate.ts || 0) >= Number(message.ts || 0);
    });
  }

  function chatArtifactCardHtml(media){
    var mediaUrl = esc(media.url || '');
    var previewUrl = esc(media.previewUrl || ((media.url || '').indexOf('?') === -1 ? (media.url + '?preview=true') : (media.url + '&preview=true')));
    var mediaName = esc(media.filename || 'Attachment');
    var mediaType = String(media.mimeType || '').toLowerCase();
    var previewButton = media.canPreview || nativeAttachmentCanPreview(mediaType)
      ? '<button type="button" class="chat-artifact-preview" data-chat-artifact-preview data-preview-url="' + previewUrl + '">Preview</button>'
      : '';
    var image = nativeAttachmentIsRaster(mediaType)
      ? '<div class="chat-msg-media"><img class="chat-artifact-thumb" src="' + previewUrl + '" alt="' + mediaName + '" loading="lazy"></div>'
      : '<span class="chat-artifact-icon" aria-hidden="true">&#128196;</span>';
    return '<div class="chat-artifact-card' + (nativeAttachmentIsRaster(mediaType) ? ' has-thumb' : '') + '">' + image +
      '<div class="chat-artifact-copy"><div class="chat-artifact-name">' + mediaName + '</div>' +
      '<div class="chat-artifact-type">' + esc(mediaType || 'file') + '</div>' +
      '<div class="chat-artifact-actions">' + previewButton +
      '<a class="chat-artifact-download" href="' + mediaUrl + '" download="' + mediaName + '">Download</a></div></div></div>';
  }

  function wireChatArtifactPreviews(container){
    if(!container || container.getAttribute('data-artifact-preview-wired') === '1') return;
    container.setAttribute('data-artifact-preview-wired', '1');
    container.addEventListener('click', function(event){
      var button = event.target.closest('[data-chat-artifact-preview]');
      if(!button) return;
      event.preventDefault();
      var url = button.getAttribute('data-preview-url');
      if(!url) return;
      var desktop = window.miaDesktop && window.miaDesktop.artifact;
      if(desktop && typeof desktop.open === 'function'){
        Promise.resolve(desktop.open(url)).then(function(result){
          if(result && result.ok) return;
          showBenchToast(result && result.error || 'Artifact preview could not be opened.');
        }).catch(function(error){
          showBenchToast(error && error.message || 'Artifact preview could not be opened.');
        });
        return;
      }
      showBenchToast('Artifact previews are available in the Mia desktop app.');
    });
  }

  // opts.inThread: this row is rendered inside an open thread box, where
  // only Delete applies (no thread-on-thread). opts.footerHtml: extra markup
  // (thread pill / thread box) appended inside the body column, below the
  // text — only ever passed for main-timeline rows.
  function chatMsgHtml(m, grouped, opts){
    opts = opts || {};
    if(m.system){
      var systemAvatar = '';
      if(m.member && m.member.kind === 'agent'){
        systemAvatar = agentAvatarHtml(m.member.label, m.member.id, 24, null, null, false);
      } else if(m.member && m.member.kind === 'human'){
        systemAvatar = humanAvatarContent(m.member.label);
      }
      var avatarHtml = systemAvatar ? '<span class="chat-msg-system-avatar">' + systemAvatar + '</span>' : '';
      return '<div class="chat-msg-system' + (systemAvatar ? ' with-avatar' : '') + '">' + avatarHtml + '<p>' + esc(m.body) + '</p></div>';
    }
    var media = m.media && m.media.url ? m.media : null;
    var attachments = Array.isArray(m.attachments) && m.attachments.length ? m.attachments : (media ? [media] : []);
    var hasMedia = attachments.length > 0;
    var isHuman = isHumanSender(m.sender);
    if(!isHuman && isSupersededNativeProgressMessage(m)) return '';
    var isOwnHuman = false;
    var botBody = isHuman ? m.body : displayBotBody(m.body);
    if(!isHuman && !botBody && !hasMedia) return '';
    var timeText = m.pending ? 'sending&hellip;' : esc(chatRelTime(m.ts));
    var mark, name, tag, text;
    if(isHuman){
      // Every human send shares one server-side app identity, so
      // m.sender alone can't say WHICH human posted this — a room with two
      // or more possible human senders (see server.js's stripHumanSignedBody)
      // gets each message tagged "[email] body" the same way an agent reply
      // is signed "[AgentName] body". parseSignedBody's regex unsigns both
      // shapes identically; an untagged message (a single-human room, or an
      // older message from before this existed) just falls back to "You",
      // same as always.
      var humanParsed = parseSignedHumanBody(m.body);
      var senderEmail = humanParsed.agent;
      isOwnHuman = !senderEmail || senderEmail.toLowerCase() === (currentUser || '').toLowerCase();
      mark = humanAvatarInitialsHtml(isOwnHuman ? currentUser : senderEmail);
      name = isOwnHuman ? 'You' : displayNameForEmail(senderEmail);
      tag = '';
      text = String(senderEmail ? humanParsed.text : m.body || '');
    } else {
      // DM and 1:1 agent-room replies are posted through the same
      // room-reply-job machinery as department replies (see
      // runRoomReplyJob), so they're signed the same "[AgentName] ..." way
      // and need the same unsigning here. A 1:1 agent room can still hold
      // OLD messages from back when the Hermes gateway answered it directly
      // — those are plain unsigned text, and parseSignedBody's regex simply
      // doesn't match them, so they pass through untouched (agent: null)
      // and fall back to chatWs.activeLabel below, same as before this
      // migration.
      // home included: addressed agents reply signed "[Name] ..." there too
      // now; the gateway's own unsigned replies simply don't match
      // parseSignedBody's regex and pass through untouched.
      var signed = chatWs.activeKind === 'department' || chatWs.activeKind === 'dm' || chatWs.activeKind === 'agent' || chatWs.activeKind === 'home';
      var parsed = signed ? parseSignedBody(botBody) : {agent: null, text: botBody};
      name = m.nativeAgentName || currentAgentDisplayNameForMessage(parsed.agent || chatWs.activeLabel || 'agent');
      mark = esc(benchMark(name));
      tag = agentTagFor(name);
      text = stripLegacyBackgroundStatus(parsed.text);
    }
    if(!text && !hasMedia) return '';
    var visuallyGrouped = grouped && isHuman;
    var markCol = visuallyGrouped
      ? '<span class="chat-msg-mark-time">' + timeText + '</span>'
      : '<span class="chat-msg-mark' + (isHuman ? '' : ' agent') + (!isHuman && isMiaOrchestrator(name, name === 'Mia' ? 'gateway' : null) ? ' mia-mark-host' : '') + '">' + (isHuman ? mark : agentAvatarHtml(name, name === 'Mia' ? 'gateway' : null, 28, null, null, true)) + '</span>';
    // Message actions use the shared context menu, which reads the row's
    // existing permission attributes instead of recomputing them on click.
    var showThreadAction = !opts.inThread && !m.pending;
    var showDeleteAction = chatMsgDeletable(m);
    var showEditAction = chatMsgEditable(m);
    var isPreReasoning = !!text && isPreReasoningNotice(text);
    var compactBrowserMessage = !!text && document.body.classList.contains('browser-collab-mode');
    var isLongMessage = !!text && (compactBrowserMessage || chatMessageWordCount(text) > CHAT_MESSAGE_PREVIEW_WORDS);
    var liveProgress = !isHuman && isLatestLiveProgressMessage(m);
    var messageHtml = text ? (liveProgress
      ? '<span class="chat-thinking-shimmer">' + esc(text) + '</span>'
      : (isPreReasoning ? chatPreReasoningHtml(text, compactBrowserMessage) : (isLongMessage ? chatExpandableMessageHtml(text, false, compactBrowserMessage) : mdLite(text)))) : '';
    var mediaHtml = '';
    if(hasMedia) mediaHtml = '<div class="chat-msg-artifacts">' + attachments.map(chatArtifactCardHtml).join('') + '</div>';
    var head = visuallyGrouped ? '' : '<div class="chat-msg-head"><span class="chat-msg-name">' + esc(name) + '</span>' +
      (tag ? '<span class="chat-msg-tag">' + esc(tag) + '</span>' : '') +
      '<span class="chat-msg-time">' + timeText + '</span></div>';
    // A background task's live activity line ("✓ research done, building
    // table") — muted so a thread of them reads as a progress feed, not a
    // stack of full agent messages.
    var isActivity = !isHuman && /^✓ /.test(text || '');
    var directRoom = isDirectChatRoom();
    var messageClass = liveProgress ? ' chat-msg-thinking' : (isPreReasoning ? ' chat-pre-reasoning' : (isLongMessage ? ' chat-expandable-message' : ''));
    var retryAttempted = !!chatRetryAttempts[m.id];
    var retryHtml = opts.inThread && !isHuman && !m.pending && chatRetryableFailure(text)
      ? '<div class="chat-msg-retry-row"><button type="button" class="chat-msg-retry" data-chat-retry data-retry-event-id="' + esc(m.id) + '"' +
          (retryAttempted ? ' disabled' : '') + '>' + (retryAttempted ? 'Retried' : 'Retry') + '</button></div>'
      : '';
    return '<div class="chat-msg-row' + (visuallyGrouped ? ' grouped' : '') + (m.pending ? ' pending' : '') + (directRoom ? ' is-direct' : '') + (opts.inThread ? ' in-thread' : '') + (isOwnHuman ? ' is-you' : '') + '" data-event-id="' + esc(m.id) +
      '" data-can-thread="' + (showThreadAction ? '1' : '') + '" data-can-delete="' + (showDeleteAction ? '1' : '') + '" data-can-edit="' + (showEditAction ? '1' : '') + '">' + markCol +
      '<div class="chat-msg-body">' + head + (text ? '<div class="chat-msg-text' + (isActivity ? ' chat-msg-activity' : '') + messageClass + '">' + messageHtml + '</div>' : '') + mediaHtml + retryHtml + chatMsgExtras(m) + (opts.footerHtml || '') + '</div></div>';
  }

  function agentSetupAutomationText(automation){
    if(!automation || !automation.enabled || automation.frequency === 'none') return 'No automation';
    if(automation.frequency === 'interval'){
      var intervalMinutes = Number(automation.intervalMinutes || 0);
      if(intervalMinutes === 1) return 'Every minute';
      if(intervalMinutes === 60) return 'Every hour';
      if(intervalMinutes > 60 && intervalMinutes % 60 === 0){
        var intervalHours = intervalMinutes / 60;
        return 'Every ' + intervalHours + (intervalHours === 1 ? ' hour' : ' hours');
      }
      return 'Every ' + intervalMinutes + ' minutes';
    }
    var text = automation.frequency === 'daily' ? 'Every day'
      : automation.frequency === 'weekly' ? 'Every ' + (automation.day || 'week')
      : 'Every month' + (automation.day ? ' on day ' + automation.day : '');
    return text + (automation.time ? ' at ' + automation.time : '');
  }

  function normalizedAgentSetupAutomation(automation){
    var source = automation || {};
    var enabled = source.enabled === true && source.frequency !== 'none';
    var normalized = {
      enabled: enabled,
      frequency: enabled ? source.frequency : 'none'
    };
    if(enabled && source.frequency === 'interval') normalized.intervalMinutes = Number(source.intervalMinutes || 1);
    if(enabled && source.day) normalized.day = String(source.day);
    if(enabled && source.time) normalized.time = String(source.time);
    if(enabled && source.prompt) normalized.prompt = String(source.prompt).trim();
    return normalized;
  }

  // Builds the greeting a freshly-activated bot "says" the moment its room
  // opens. Room state's `localWelcome` field is consumed once by
  // loadChatRoom() (see its use of state.localWelcome) and rendered like any
  // other message, then cleared as soon as real history exists for the room.
  function agentSetupWelcomeExcerpt(text, maxWords){
    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if(!words.length) return '';
    if(words.length <= maxWords) return words.join(' ');
    return words.slice(0, maxWords).join(' ') + '…';
  }

  function agentSetupWelcomeBody(created, draft){
    var name = (created && created.name) || (draft && draft.name) || 'your new bot';
    var roleSummary = agentSetupWelcomeExcerpt(draft && draft.role, 24).replace(/[.\s]+$/, '');
    var automation = draft && draft.automation;
    var sentences = ['I’m ' + name + '.'];
    if(roleSummary) sentences.push('I handle ' + roleSummary + '.');
    if(automation && automation.enabled && String(automation.prompt || '').trim()){
      var task = agentSetupWelcomeExcerpt(automation.prompt, 16).replace(/[.\s]+$/, '');
      sentences.push('Want me to run ' + task + ' now, or is there something related you’d like first?');
    } else {
      sentences.push('What should I work on first?');
    }
    return sentences.join(' ');
  }

  function buildAgentSetupWelcomeMessage(roomId, created, draft){
    return {
      id: 'local-welcome-' + roomId,
      sender: (created && created.id) || 'bot',
      nativeAgentName: (created && created.name) || (draft && draft.name) || null,
      body: agentSetupWelcomeBody(created, draft),
      media: null,
      attachments: [],
      ts: Date.now(),
      threadRoot: null,
      editTs: 0,
      system: false,
      pending: false,
      deleted: false,
      clientIdempotencyKey: null,
      nativeDispatchId: null,
      nativeProgress: false,
      nativeDiagnostic: false,
      nativeEvent: null
    };
  }

  function agentSetupMessageHtml(text, human, name){
    var displayName = human ? 'You' : (name || 'New Bot');
    var mark = human ? humanAvatarInitialsHtml(currentUser) : agentAvatarHtml('New Bot', AGENT_SETUP_ROOM_ID, 28);
    return '<div class="chat-msg-row is-direct agent-setup-message' + (human ? ' is-you' : '') + '">' +
      '<span class="chat-msg-mark' + (human ? '' : ' agent') + '">' + mark + '</span>' +
      '<div class="chat-msg-body"><div class="chat-msg-head"><span class="chat-msg-name">' + esc(displayName) + '</span>' +
      (human ? '' : '<span class="chat-msg-tag">Bot</span>') + '<span class="chat-msg-time">just now</span></div>' +
      '<div class="chat-msg-text">' + mdLite(text) + '</div></div></div>';
  }

  function agentSetupProposalText(draft){
    return [
      'Here’s what I inferred:',
      '',
      'Name: **' + draft.name + '**',
      'Role: ' + draft.role,
      'Automation: ' + agentSetupAutomationText(draft.automation),
      'Output: ' + draft.output,
      '',
      'Do you want me to activate this bot?'
    ].join('\n');
  }

  function agentSetupReviewHtml(){
    var draft = agentSetup.draft || {};
    var automation = draft.automation || {enabled:false, frequency:'none', day:'', time:''};
    var frequency = automation.enabled ? automation.frequency : 'none';
    var intervalMinutes = frequency === 'interval' ? Number(automation.intervalMinutes || 1) : 0;
    var cadence = frequency;
    var intervalParts = automationIntervalParts(intervalMinutes);
    function option(value, label){ return '<option value="' + value + '"' + (cadence === value ? ' selected' : '') + '>' + label + '</option>'; }
    var dayField = '';
    if(frequency === 'weekly'){
      dayField = '<label class="agent-setup-field"><span>Day</span><select id="agentSetupDay">' +
        ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(function(day){
          return '<option value="' + day + '"' + (automation.day === day ? ' selected' : '') + '>' + day + '</option>';
        }).join('') + '</select></label>';
    } else if(frequency === 'monthly'){
      dayField = '<label class="agent-setup-field"><span>Day of month</span><input id="agentSetupDay" type="number" min="1" max="31" value="' + esc(automation.day || '1') + '"></label>';
    }
    var scheduleFields = frequency === 'interval'
      ? '<div class="agent-setup-timer-row"><span class="agent-setup-timer-prefix">Every</span><input id="agentSetupIntervalValue" type="number" min="1" max="' + (intervalParts.unit === 'hours' ? '24' : '60') + '" value="' + esc(intervalParts.value) + '" aria-label="Timer interval"><select id="agentSetupIntervalUnit" aria-label="Timer unit"><option value="minutes"' + (intervalParts.unit === 'minutes' ? ' selected' : '') + '>minutes</option><option value="hours"' + (intervalParts.unit === 'hours' ? ' selected' : '') + '>hours</option></select></div>'
      : frequency === 'none' ? '' : '<div class="agent-setup-schedule-row">' + dayField +
      '<label class="agent-setup-field"><span>Time</span><input id="agentSetupTime" type="time" value="' + esc(automation.time || '') + '"></label></div>';
    var automationPromptField = frequency === 'none' ? '' :
      '<label class="agent-setup-field"><span>Task prompt</span><textarea id="agentSetupAutomationPrompt" rows="3" maxlength="1000" placeholder="What should this automation do each time it runs?">' + esc(automation.prompt || '') + '</textarea></label>';
    return '<div class="chat-msg-row is-direct agent-setup-review-row"><span class="chat-msg-mark agent">' + agentAvatarHtml('New Bot', AGENT_SETUP_ROOM_ID, 28) + '</span>' +
      '<div class="chat-msg-body"><div class="chat-msg-head"><span class="chat-msg-name">' + esc(draft.name || 'New Bot') + '</span><span class="chat-msg-tag">Bot</span><span class="chat-msg-time">just now</span></div>' +
      '<div class="agent-setup-card">' +
        '<div class="agent-setup-card-intro">Here’s what I inferred. Edit anything before activating me.</div>' +
        '<label class="agent-setup-field"><span>Name</span><input id="agentSetupName" type="text" maxlength="40" value="' + esc(draft.name || '') + '"></label>' +
        '<label class="agent-setup-field"><span>Role</span><textarea id="agentSetupRole" rows="3" maxlength="500">' + esc(draft.role || '') + '</textarea></label>' +
        '<label class="agent-setup-field"><span>Want me to run an automation?</span><select id="agentSetupFrequency">' +
          option('none', 'No automation') + option('interval', 'Repeating timer') +
          option('daily', 'Every day') + option('weekly', 'Every week') + option('monthly', 'Every month') + '</select></label>' +
        scheduleFields +
        automationPromptField +
        '<label class="agent-setup-field"><span>Output</span><textarea id="agentSetupOutput" rows="3" maxlength="300">' + esc(draft.output || '') + '</textarea></label>' +
        '<div class="agent-setup-confirm-copy">Do you want me to activate this bot?</div>' +
        '<div class="agent-setup-safety">Nothing is created or scheduled until you confirm.</div>' +
        (agentSetup.error ? '<div class="agent-setup-error" role="alert">' + esc(agentSetup.error) + '</div>' : '') +
        '<div class="agent-setup-actions"><button type="button" class="agent-setup-activate" id="agentSetupActivate"' + (agentSetup.phase === 'activating' ? ' disabled' : '') + '>' +
          (agentSetup.phase === 'activating' ? 'Activating…' : 'Yes, activate bot') + '</button>' +
          '<button type="button" class="agent-setup-later" id="agentSetupLater">' + (agentSetup.phase === 'activating' ? 'Cancel' : 'Not yet') + '</button></div>' +
      '</div></div></div>';
  }

  function captureAgentSetupDraft(){
    if(!agentSetup.draft) return;
    var name = el('#agentSetupName'), role = el('#agentSetupRole'), output = el('#agentSetupOutput');
    var frequency = el('#agentSetupFrequency'), day = el('#agentSetupDay'), time = el('#agentSetupTime');
    var intervalValue = el('#agentSetupIntervalValue'), intervalUnit = el('#agentSetupIntervalUnit');
    var automationPrompt = el('#agentSetupAutomationPrompt');
    var cadence = frequency ? frequency.value : 'none';
    agentSetup.draft.name = name ? name.value.trim() : agentSetup.draft.name;
    agentSetup.draft.role = role ? role.value.trim() : agentSetup.draft.role;
    agentSetup.draft.output = output ? output.value.trim() : agentSetup.draft.output;
    agentSetup.draft.automation = {
      enabled: cadence !== 'none',
      frequency: cadence,
      day: day ? String(day.value || '') : '',
      time: time ? String(time.value || '') : '',
      prompt: automationPrompt ? automationPrompt.value.trim() : ''
    };
    if(cadence === 'interval'){
      agentSetup.draft.automation.intervalMinutes = normalizedAutomationIntervalMinutes(
        intervalValue ? intervalValue.value : 5,
        intervalUnit ? intervalUnit.value : 'minutes'
      );
    }
  }

  function wireAgentSetupReview(thread){
    var frequency = el('#agentSetupFrequency', thread);
    if(frequency) frequency.addEventListener('change', function(){
      captureAgentSetupDraft();
      if(agentSetup.draft.automation.enabled && agentSetup.draft.automation.frequency === 'weekly' && !agentSetup.draft.automation.day) agentSetup.draft.automation.day = 'Monday';
      if(agentSetup.draft.automation.enabled && agentSetup.draft.automation.frequency === 'monthly' && !agentSetup.draft.automation.day) agentSetup.draft.automation.day = '1';
      renderChatThread();
    });
    var intervalUnit = el('#agentSetupIntervalUnit', thread);
    if(intervalUnit) intervalUnit.addEventListener('change', function(){
      var input = el('#agentSetupIntervalValue', thread);
      if(input) input.max = intervalUnit.value === 'hours' ? '24' : '60';
    });
    var activate = el('#agentSetupActivate', thread);
    if(activate) activate.addEventListener('click', activateAgentSetup);
    var later = el('#agentSetupLater', thread);
    if(later) later.addEventListener('click', cancelAgentSetupFlow);
  }

  function clearAgentSetupRequest(abort){
    if(agentSetup.requestTimeoutTimer) clearTimeout(agentSetup.requestTimeoutTimer);
    agentSetup.requestTimeoutTimer = null;
    if(abort && agentSetup.requestController){
      try { agentSetup.requestController.abort(); } catch(error) {}
    }
    agentSetup.requestController = null;
  }

  function finishAgentSetupFailure(attempt, operation, timedOut, message){
    if(agentSetup.requestId !== attempt || agentSetup.phase !== operation) return;
    agentSetup.requestId += 1;
    clearAgentSetupRequest(true);
    agentSetup.requestTimedOut = timedOut;
    agentSetup.phase = operation === 'interpreting' ? 'intent' : 'review';
    agentSetup.error = timedOut
      ? 'This is taking too long. Nothing was confirmed. Try again.'
      : String(message || (operation === 'interpreting' ? 'I couldn’t prepare the setup. Try again.' : 'The bot could not be activated. Try again.'));
    renderChatThread();
    renderDeptAgentSelector();
  }

  function cancelAgentSetupFlow(){
    var wasActivating = agentSetup.phase === 'activating';
    var wasInterpreting = agentSetup.phase === 'interpreting';
    if(agentSetup.phase !== 'interpreting' && agentSetup.phase !== 'activating' && agentSetup.phase !== 'review' && agentSetup.phase !== 'intent') return;
    agentSetup.requestId += 1;
    clearAgentSetupRequest(true);
    if(wasActivating){
      agentSetup.phase = 'review';
      agentSetup.error = 'Activation cancelled. Nothing was confirmed.';
    } else {
      agentSetup.phase = 'intent';
      agentSetup.draft = null;
      agentSetup.intent = wasInterpreting ? agentSetup.intent : '';
      agentSetup.error = wasInterpreting ? 'Setup cancelled. Try again when ready.' : '';
    }
    renderChatThread();
    renderDeptAgentSelector();
    var input = el('#ccInput');
    if(input) input.focus();
  }

  function renderAgentSetupThread(thread){
    var name = agentSetup.created && agentSetup.created.name || agentSetup.draft && agentSetup.draft.name || 'New Bot';
    var html = agentSetupMessageHtml('Let’s set me up. Tell me in a few words what you want me to do?', false, name);
    if(agentSetup.intent) html += agentSetupMessageHtml(agentSetup.intent, true, name);
    if(agentSetup.phase === 'interpreting'){
      html += '<div class="chat-msg-row is-direct agent-setup-message"><span class="chat-msg-mark agent">' + agentAvatarHtml(name, null, 28) + '</span>' +
        '<div class="chat-msg-body"><div class="chat-msg-head"><span class="chat-msg-name">' + esc(name) + '</span><span class="chat-msg-tag">Bot</span></div>' +
        '<div class="chat-msg-text chat-msg-thinking" aria-live="polite"><span class="chat-thinking-shimmer">Turning that into a clear setup</span></div></div></div>';
    } else if(agentSetup.phase === 'review' || agentSetup.phase === 'activating'){
      html += agentSetupReviewHtml();
    } else if(agentSetup.phase === 'active' && agentSetup.draft){
      html += agentSetupMessageHtml(agentSetupProposalText(agentSetup.draft), false, name);
      html += agentSetupMessageHtml('Activate this bot.', true, name);
      html += agentSetupMessageHtml('I’m active. What should I work on first?', false, name);
    } else if(agentSetup.error){
      html += '<div class="agent-setup-inline-error" role="alert">' + esc(agentSetup.error) + '</div>';
    }
    thread.innerHTML = html;
    if(agentSetup.error && agentSetup.phase === 'intent'){
      var recovery = document.createElement('div');
      recovery.className = 'agent-setup-recovery-actions';
      recovery.innerHTML = '<button type="button" class="agent-setup-retry" id="agentSetupRetry">Try again</button><button type="button" class="agent-setup-later" id="agentSetupCancel">Clear</button>';
      thread.appendChild(recovery);
      var retry = el('#agentSetupRetry', thread);
      if(retry) retry.addEventListener('click', function(){ submitAgentSetupIntent(agentSetup.intent); });
      var clear = el('#agentSetupCancel', thread);
      if(clear) clear.addEventListener('click', cancelAgentSetupFlow);
    }
    if(agentSetup.phase === 'review' || agentSetup.phase === 'activating') wireAgentSetupReview(thread);
    thread.scrollTop = thread.scrollHeight;
    syncChatThreadPanel();
  }

  function chatHistoryControlHtml(state){
    if(!state || !state.historyCursor) return '';
    return '<button type="button" class="chat-history-more" id="chatHistoryMore"' + (state.historyLoading ? ' disabled' : '') + '>' + (state.historyLoading ? 'Loading…' : 'Load earlier messages') + '</button>';
  }

  function wireChatHistoryControl(thread, roomId){
    var more = el('#chatHistoryMore', thread);
    if(more) more.addEventListener('click', function(){ loadOlderChatMessages(roomId); });
  }

  function startAgentSetupChat(){
    clearAgentSetupRequest(true);
    rememberChatBack('agent-setup', AGENT_SETUP_ROOM_ID);
    closeManageAgentsPane();
    closeMentionPopover();
    chatRoster.open = null;
    chatInfo.mode = 'automations';
    chatInfo.open = false;
    agentSetup = {phase:'intent', intent:'', draft:null, error:'', created:null, liveRoomId:null, requestId:0, requestController:null, requestTimeoutTimer:null, requestTimedOut:false};
    chatWs.activeRoomId = AGENT_SETUP_ROOM_ID;
    chatWs.activeKind = 'agent-setup';
    chatWs.activeLabel = 'New Bot';
    renderChatSidebar();
    refreshChatMain();
    setTimeout(function(){ var input = el('#ccInput'); if(input) input.focus(); }, 0);
  }

  function submitAgentSetupIntent(text){
    if(agentSetup.phase !== 'intent') return;
    agentSetup.intent = String(text || '').trim().slice(0, 2000);
    if(!agentSetup.intent) return;
    agentSetup.phase = 'interpreting';
    agentSetup.error = '';
    renderChatThread();
    renderDeptAgentSelector();
    var modelSelection = chatModelSelectionMetadata();
    var attempt = ++agentSetup.requestId;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    agentSetup.requestController = controller;
    agentSetup.requestTimedOut = false;
    agentSetup.requestTimeoutTimer = setTimeout(function(){
      if(agentSetup.requestId !== attempt || agentSetup.phase !== 'interpreting') return;
      if(controller) controller.abort();
      finishAgentSetupFailure(attempt, 'interpreting', true);
    }, AGENT_SETUP_TIMEOUT_MS);
    api('/api/bots/interpret', {
      method:'POST',
      ...(controller ? {signal:controller.signal} : {}),
      body:{
      intent: agentSetup.intent,
      ...(modelSelection ? {modelSelection:modelSelection} : {})
      }
    }).then(function(res){
      if(chatWs.activeRoomId !== AGENT_SETUP_ROOM_ID || agentSetup.phase !== 'interpreting') return;
      if(res.status !== 200 || !res.data || !res.data.draft) throw new Error('proposal unavailable');
      clearAgentSetupRequest(false);
      agentSetup.draft = res.data.draft;
      agentSetup.phase = 'review';
      renderChatHeaderBar();
      renderChatThread();
      renderDeptAgentSelector();
    }).catch(function(error){
      if(chatWs.activeRoomId !== AGENT_SETUP_ROOM_ID || agentSetup.phase !== 'interpreting') return;
      finishAgentSetupFailure(attempt, 'interpreting', agentSetup.requestTimedOut || !!(error && error.name === 'AbortError'), 'I couldn’t prepare the setup. Try describing the bot again.');
    });
  }

  function createNativeAgentConversation(agent, requestOptions){
    // POST /api/bots provisions this native conversation on the server.
    // Refresh before creating anything so the client never races that hook
    // and creates a duplicate room for the same bot.
    return loadNativeConversations(requestOptions).then(function(conversations){
      var existing = (conversations || []).filter(function(conversation){
        var metadata = conversation.metadata || {};
        return conversation.type === 'bot' && metadata.botId === agent.id;
      })[0];
      if(existing) return existing;
      return api('/api/conversations', Object.assign({}, requestOptions || {}, {method:'POST', body:{
        type: 'bot',
        name: agent.name,
        metadata: {
          botId: agent.id,
          departments: Array.isArray(agent.departments) ? agent.departments : [],
          source: 'bot-setup'
        }
      }})).then(function(res){
        if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
          throw new Error(res.data && (res.data.message || res.data.error) || 'native bot conversation could not be created');
        }
        return res.data.conversation;
      });
    });
  }

  function activateAgentSetup(){
    if(agentSetup.phase !== 'review' || !agentSetup.draft) return;
    try {
      captureAgentSetupDraft();
    } catch(error) {
      agentSetup.error = error && error.message ? error.message : 'Check the automation timer.';
      renderChatThread();
      return;
    }
    var draft = agentSetup.draft;
    if(!draft.name || !draft.role || !draft.output){
      agentSetup.error = 'Name, role, and output are required.';
      renderChatThread();
      return;
    }
    if(draft.automation && draft.automation.enabled && !String(draft.automation.prompt || '').trim()){
      agentSetup.error = 'Add the task prompt this automation should run.';
      renderChatThread();
      return;
    }
    agentSetup.error = '';
    agentSetup.phase = 'activating';
    renderChatThread();
    var instructions = 'Role: ' + draft.role + '\n\nDesired output: ' + draft.output;
    var payload = {
      name: draft.name,
      role: draft.role,
      output: draft.output,
      instructions: instructions,
      automations: draft.automation && draft.automation.enabled ? [Object.assign(
        {id:'automation-1', name:draft.name + ' automation'},
        normalizedAgentSetupAutomation(draft.automation)
      )] : [],
      model: selectedConnectedBotModel(),
      status: 'running',
      departments: guessDepartmentsFor(draft.role + ' ' + draft.output),
      setupIntent: agentSetup.intent
    };
    if(!payload.model){
      agentSetup.phase = 'review';
      agentSetup.error = 'Connect and choose a model before activating this bot.';
      renderChatThread();
      return;
    }
    var attempt = ++agentSetup.requestId;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    agentSetup.requestController = controller;
    agentSetup.requestTimedOut = false;
    agentSetup.requestTimeoutTimer = setTimeout(function(){
      if(agentSetup.requestId !== attempt || agentSetup.phase !== 'activating') return;
      if(controller) controller.abort();
      finishAgentSetupFailure(attempt, 'activating', true);
    }, AGENT_SETUP_TIMEOUT_MS);
    api('/api/bots', {
      method:'POST',
      ...(controller ? {signal:controller.signal} : {}),
      body:payload
    }).then(function(res){
      if(agentSetup.requestId !== attempt || agentSetup.phase !== 'activating') return;
      if(res.status !== 201 || !res.data || !res.data.bot){
        throw new Error(res.data && (res.data.message || res.data.error) || 'activation failed');
      }
      var created = res.data.bot;
      return createNativeAgentConversation(created, controller ? {signal:controller.signal} : {}).then(function(conversation){
        if(agentSetup.requestId !== attempt || agentSetup.phase !== 'activating') return;
        clearAgentSetupRequest(false);
        agentSetup.created = created;
        agentSetup.liveRoomId = conversation.id;
        agentSetup.phase = 'idle';
        var createdBotRecords = (chatWs.botRecords || []).filter(function(record){
          return String(record.id || '') !== String(created.id || '');
        });
        createdBotRecords.push(created);
        syncChatBotRecords(createdBotRecords);
        chatWs.nativeConversations.push(conversation);
        applyNativeConversationList(chatWs.nativeConversations);
        renderChatSidebar();
        renderChatHeaderBar();
        chatRoomState(conversation.id).localWelcome = buildAgentSetupWelcomeMessage(conversation.id, created, draft);
        loadChatRoom(conversation.id, 'agent', created.name);
      });
    }).catch(function(err){
      if(agentSetup.requestId !== attempt || agentSetup.phase !== 'activating') return;
      finishAgentSetupFailure(attempt, 'activating', agentSetup.requestTimedOut || !!(err && err.name === 'AbortError'), 'The bot could not be activated: ' + (err && err.message ? err.message : 'please try again.'));
    });
  }

  function renderChatThread(options){
    var thread = el('#chatThread');
    if(!thread) return;
    captureRenderedChatScroll(thread);
    if(chatWs.activeKind === 'agent-setup'){
      thread.removeAttribute('data-chat-scroll-room');
      syncChatJumpLatest(null, null);
      renderAgentSetupThread(thread);
      return;
    }
    if(chatWs.configured === false){
      thread.removeAttribute('data-chat-scroll-room');
      thread.innerHTML = '<div class="no-data">Native chat unavailable</div>';
      syncChatJumpLatest(null, null);
      return;
    }
    var roomId = chatWs.activeRoomId;
    if(!roomId){
      thread.removeAttribute('data-chat-scroll-room');
      thread.innerHTML = chatHeroHtml('Pick a channel, department, or agent to start.');
      syncChatJumpLatest(null, null);
      return;
    }
    var state = chatRoomState(roomId);
    updateChatSuggestions(roomId);
    if(!state.messages.length && !state.thinking){
      var emptyMessage = chatWs.activeKind === 'agent' && isMiaOrchestrator(chatWs.activeLabel)
        ? esc(miaEmptyGreeting(currentRealProfileName()))
        : 'No messages yet &mdash; say hello.';
      replaceChatTimeline(thread, roomId, state, chatHistoryControlHtml(state) + chatHeroHtml(emptyMessage, chatWs.activeKind === 'agent' ? chatWs.activeLabel : ''), options);
      wireChatHistoryControl(thread, roomId);
      return;
    }
    // Consecutive turns from the SAME human collapse to a slim time-only
    // left column. "Same" means the signed-body email (all humans share one
    // shared sender identity, so m.sender can't distinguish them — see chatMsgHtml);
    // a different human always gets a fresh head. Agent replies always keep
    // their full head, since the tag is the audit trail for which
    // capability answered.
    // Thread replies (m.threadRoot set) never appear in this main pass —
    // they render nested under their root instead, via chatThreadFooterHtml.
    var mainMessages = state.messages.filter(function(m){ return !m.threadRoot && (m.system || isHumanSender(m.sender) || displayBotBody(m.body) || chatMessageHasAttachments(m)); });
    var dateDivider = '';
    if(mainMessages.length){
      var dividerDate = new Date(mainMessages[0].ts || Date.now());
      var now = new Date();
      var sameDay = dividerDate.getFullYear() === now.getFullYear() && dividerDate.getMonth() === now.getMonth() && dividerDate.getDate() === now.getDate();
      var dividerTime = dividerDate.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
      dateDivider = '<div class="chat-date-divider">' + (sameDay ? 'Today ' : dividerDate.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ') + esc(dividerTime) + '</div>';
    }
    var prevHumanKey = null;
    var html = mainMessages.map(function(m){
      var isHuman = !m.system && isHumanSender(m.sender);
      var key = isHuman ? chatHumanSenderKey(m) : null;
      var grouped = key !== null && key === prevHumanKey;
      prevHumanKey = key;
      var footerHtml = m.system ? '' : chatThreadFooterHtml(state, m.id);
      footerHtml = miaOnboardingChoicesHtml(m, state) + footerHtml;
      return chatMsgHtml(m, grouped, {footerHtml: footerHtml});
    }).join('');
    if(state.thinking){
      // Who's replying, not what room this is: state.thinkingAgentName (set
      // at send time — see sendActiveRoomMessage) is the agent THIS message
      // actually addressed; lastAddressedAgentInRoom is a same-room-history
      // fallback for when that couldn't be resolved (e.g. a replyAlways
      // fan-out with no explicit @-tag); the room label is the last resort,
      // for genuinely ambiguous cases (@all_bots, multiple replyAlways
      // members) where no single agent can be named.
      var thinkingName = canonicalAgentDisplayName(state.thinkingAgentName || lastAddressedAgentInRoom(roomId) || chatWs.activeLabel || 'agent');
      var thinkingTag = agentTagFor(thinkingName);
      var thinkingIsMia = isMiaOrchestrator(thinkingName, thinkingName === 'Mia' ? 'gateway' : null);
      html += '<div class="chat-msg-row' + (isDirectChatRoom() ? ' is-direct' : '') + '"><span class="chat-msg-mark agent' + (thinkingIsMia ? ' mia-mark-host' : '') + '">' + agentAvatarHtml(thinkingName, thinkingIsMia ? 'gateway' : null, 28, thinkingIsMia ? 'activity' : null, null, true) + '</span>' +
        '<div class="chat-msg-body"><div class="chat-msg-head"><span class="chat-msg-name">' + esc(thinkingName) + '</span>' +
        (thinkingTag ? '<span class="chat-msg-tag">' + esc(thinkingTag) + '</span>' : '') + '</div>' +
        '<div class="chat-msg-text chat-msg-thinking chat-msg-thinking-local" aria-live="polite"><span class="chat-thinking-shimmer">' + esc(chatThinkingText(state)) + '</span></div></div></div>';
    }
    var historyControl = chatHistoryControlHtml(state);
    replaceChatTimeline(thread, roomId, state, historyControl + dateDivider + html, options);
    els('[data-mia-onboarding-choice]', thread).forEach(function(button){
      button.addEventListener('click', function(){
        var label = button.getAttribute('data-mia-onboarding-choice');
        if(label === 'Show my briefing') startNewsAutomationGuide();
        else if(label === 'Skip news briefing') sendMiaOnboardingAction({action:'skip-news'});
        else if(label === 'Change topics') sendMiaOnboardingAction({action:'edit-topics'});
        else if(label === 'Set up my news briefing') sendMiaOnboardingAction({action:'start-news'});
        else if(miaOnboardingChat.phase === 'name') sendMiaOnboardingAnswer(label);
        else sendActiveRoomMessage(label);
      });
    });
    wireNewsOnboarding(thread);
    wireChatExpandableMessages(thread);
    wireChatArtifactPreviews(thread);
    wireChatHistoryControl(thread, roomId);
    syncChatThreadPanel();
  }

  // Slack-style thread pill ("↳ N replies · last …") under a root message's
  // body — the "this thread exists" signal in the main timeline. Clicking
  // it (or the row's "↳ Thread" hover action) opens the docked
  // #chatThreadPanel via openChatThread; the replies themselves no longer
  // render inline here (see syncChatThreadPanel).
  function chatThreadFooterHtml(state, rootId){
    var root = (state.messages || []).filter(function(message){ return message.id === rootId; })[0];
    var threadEvents = (state.messages || []).filter(function(rm){ return rm.threadRoot === rootId; });
    var replies = threadEvents.filter(function(rm){ return rm.system || isHumanSender(rm.sender) || displayBotBody(rm.body) || chatMessageHasAttachments(rm); });
    if(!replies.length && !(root && root.taskRoot) && !threadEvents.length) return '';
    if(!replies.length){
      return '<div class="chat-thread-pill" data-thread-toggle data-root-id="' + esc(rootId) + '">&#8618; Open thread</div>';
    }
    var last = replies[replies.length - 1];
    return '<div class="chat-thread-pill" data-thread-toggle data-root-id="' + esc(rootId) + '">&#8618; ' +
      replies.length + (replies.length === 1 ? ' reply' : ' replies') +
      ' &middot; last ' + esc(chatRelTime(last.ts)) + '</div>';
  }

  // Keeps the docked #chatThreadPanel in sync with the active room's
  // openThreadRoot: shows/hides it and (re)renders just the root+replies
  // region. Deliberately never touches #ctpComposerInput or its DOM
  // subtree — that input is a persistent, static element (see index.html),
  // so a poll-driven re-render here can't steal its focus or clobber
  // whatever the user is mid-typing, unlike an innerHTML rebuild would.
  // One right-hand slot: while the thread or tasks panel is showing, the
  // automations/plugins pane is hidden by CSS (body.ctp-open) rather than
  // closed, so it reappears untouched when the docked panel goes away.
  function syncRightPanelSlot(){
    var thread = el('#chatThreadPanel'), tasks = el('#chatTasksPanel');
    var docked = (thread && !thread.hidden) || (tasks && !tasks.hidden);
    document.body.classList.toggle('ctp-open', !!docked);
  }

  // Thread, task, automations, plugins, and agent manager all occupy one
  // right-side slot. The latest explicit click wins; panels never remain
  // mounted behind each other waiting to reappear unexpectedly.
  function closeChatUtilityPane(){
    var wasOpen = chatInfo.open;
    if(chatInfo.mode === 'agent-edit') closeCinema();
    if(chatInfo.mode === 'plugins') restorePluginShell();
    document.body.classList.remove('manage-agents-open');
    chatInfo.mode = 'automations';
    chatInfo.automationBotId = null;
    chatInfo.automationId = null;
    chatInfo.open = false;
    renderChatInfoPane();
    syncSidebarToolButtons();
    return wasOpen;
  }

  function prepareChatUtilityPane(mode){
    closeChatThread();
    closeChatTasksPanel();
    if(chatInfo.mode === 'plugins' && mode !== 'plugins') restorePluginShell();
    document.body.classList.toggle('manage-agents-open', mode === 'agents');
    chatInfo.mode = mode;
    chatInfo.open = true;
  }

  function syncChatThreadPanel(){
    var panel = el('#chatThreadPanel');
    if(!panel) return;
    var roomId = chatWs.activeRoomId;
    var state = roomId && chatRoomState(roomId);
    var rootId = state && state.openThreadRoot;
    var root = rootId && state.messages.find(function(m){ return m.id === rootId; });
    if(!roomId || !rootId || !root){
      panel.hidden = true;
      syncRightPanelSlot();
      return;
    }
    panel.hidden = false;
    syncRightPanelSlot();
    el('#ctpRoomName').textContent = chatWs.activeLabel || '';
    el('#ctpRoot').innerHTML = chatMsgHtml(root, false, {inThread: true});
    var replies = state.messages.filter(function(rm){ return rm.threadRoot === rootId && (rm.system || isHumanSender(rm.sender) || displayBotBody(rm.body) || chatMessageHasAttachments(rm)); });
    el('#ctpDivider').textContent = replies.length + (replies.length === 1 ? ' reply' : ' replies');
    var prevKey = null;
    el('#ctpReplies').innerHTML = replies.map(function(m){
      var isHuman = !m.system && isHumanSender(m.sender);
      var key = isHuman ? chatHumanSenderKey(m) : null;
      var grouped = key !== null && key === prevKey;
      prevKey = key;
      // A thread is its own audit trail. Keep each reply ungrouped so every
      // status/result retains its sender and timestamp, even in a 1:1 agent
      // room whose main timeline intentionally uses compact bubbles.
      return chatMsgHtml(m, false, {inThread: true});
    }).join('');
    wireChatExpandableMessages(el('#chatThreadPanel'));
    wireChatArtifactPreviews(el('#chatThreadPanel'));
    wireChatRetryActions(el('#chatThreadPanel'));
  }

  // Opens rootId's thread panel (even with zero replies yet) and focuses
  // its reply composer — used by both the pill click and the row's
  // "↳ Thread" action. Always opens (replacing whatever thread was open
  // before), matching the panel's single explicit close (X / Esc). Closes
  // the tasks panel first — only one of the two docked panels is ever open.
  function openChatThread(rootId){
    var roomId = chatWs.activeRoomId;
    if(!roomId || !rootId) return;
    closeChatTasksPanel();
    closeChatUtilityPane();
    chatRoomState(roomId).openThreadRoot = rootId;
    syncChatThreadPanel();
    var input = el('#ctpComposerInput');
    if(input) input.focus();
  }
  // Returns true when it actually closed something, so an Escape handler
  // upstream can stop there instead of also triggering whatever else
  // Escape does in the chat panel.
  function closeChatThread(){
    var roomId = chatWs.activeRoomId;
    var state = roomId && chatRoomState(roomId);
    if(!state || !state.openThreadRoot) return false;
    state.openThreadRoot = null;
    syncChatThreadPanel();
    return true;
  }

  /* ============ CHAT: docked "running tasks" panel (sibling to #chatThreadPanel) ============
     Opened from the header popover's "N running tasks" link (see
     wireChatRosterControls). Not room-scoped like the thread panel — it's
     keyed to a single agentId, so it keeps showing that agent's tasks even
     if the user switches rooms while it's open. */
  var chatTasksPanelState = {agentId: null};

  function renderChatTaskRow(t){
    return '<div class="ctsk-row">' +
      '<div class="ctsk-row-top"><span class="ctsk-title">' + esc(t.title || 'background task') + '</span>' +
      '<span class="ctsk-status ctsk-status-' + esc(t.status) + '">' + esc(t.status) + '</span></div>' +
      '<div class="ctsk-time">started ' + esc(chatRelTime(t.startedAt)) + '</div></div>';
  }

  function syncChatTasksPanel(){
    var panel = el('#chatTasksPanel');
    if(!panel) return;
    var agentId = chatTasksPanelState.agentId;
    if(!agentId){ panel.hidden = true; syncRightPanelSlot(); return; }
    panel.hidden = false;
    syncRightPanelSlot();
    var agent = (chatWs.allAgents || []).filter(function(a){ return a.id === agentId; })[0];
    var nameEl = el('#ctskAgentName');
    if(nameEl) nameEl.textContent = agent ? agent.name : '';
    var tasks = tasksForAgent(agentId);
    var list = el('#ctskList');
    if(list) list.innerHTML = tasks.length ? tasks.map(renderChatTaskRow).join('') : '<div class="ctsk-empty">no active tasks</div>';
  }

  // Opens the docked tasks panel for one agent — closes the thread panel
  // first (mutual exclusivity: only one docked panel open at a time).
  function openChatTasksPanel(agentId){
    if(!agentId) return;
    closeChatThread();
    closeChatUtilityPane();
    chatTasksPanelState.agentId = agentId;
    syncChatTasksPanel();
  }
  // Same true/false-return contract as closeChatThread, for the shared Escape handler.
  function closeChatTasksPanel(){
    if(!chatTasksPanelState.agentId) return false;
    chatTasksPanelState.agentId = null;
    syncChatTasksPanel();
    return true;
  }

  // Confirms, deletes server-side, then updates the local
  // cache — mirrors the backend's own authorization rule (see
  // chatMsgDeletable) so this only ever fires from a button that was
  // already shown, but the server is still the actual source of truth.
  function handleDeleteChatMessage(eventId){
    var roomId = chatWs.activeRoomId;
    if(!roomId || !eventId) return;
    appConfirm('Delete this message?').then(function(ok){
      if(!ok) return;
      api(nativeConversationPath(roomId, '/events/' + encodeURIComponent(eventId)), {method:'DELETE'}).then(function(res){
        if(res.status !== 200) return;
        if(res.data && res.data.event) applyNativeEvent(res.data.event);
      }).catch(function(){});
    });
  }

  // Opens the editable copy of a user's prompt. A confirmed edit is sent as
  // a new root message so Mia/the team see it at the end of the conversation;
  // no stored event is rewritten and no automatic redo is triggered.
  function handleEditChatMessage(eventId){
    var roomId = chatWs.activeRoomId;
    var original = editableChatPromptForEvent(roomId, eventId);
    if(!roomId || !original) return;
    appPrompt(original).then(function(result){
      if(!result || !result.ok || !result.text.trim()) return;
      if(chatWs.activeRoomId !== roomId) return;
      sendActiveRoomMessage(result.text.trim());
    });
  }

  // A local-only confirmation line (@-mention add outcome) — never
  // sent to the server, just appended to this room's cached thread so it
  // persists like any other message until the room's next fresh load.
  function addSystemChatLine(roomId, text, member){
    var state = chatRoomState(roomId);
    state.messages.push({id: 'system-' + Date.now() + Math.random().toString(36).slice(2), system: true, body: text, member: member || null, ts: Date.now()});
    if(chatWs.activeRoomId === roomId) renderChatThread();
  }

  // Interactive roster (people chip + agents chip, each opening a dropdown,
  // each row opening a detail card) — literal port of Chat.dc.html's
  // togglePeople/toggleAgents/rosterVals. Sourced from the same
  // Native member and directory data powers the @-mention popover.
  // already caches per room (loadMentionRoster), joined against
  // chatWs.allAgents for model/department fields the members endpoint
  // doesn't carry — no new endpoint, no fictional rows.
  var chatRoster = {open: null, selectedAgentId: null}; // open: 'people' | 'agents' | null
  var chatNavigation = {back: null};

  function chatCurrentLocation(){
    if(!chatWs.activeRoomId) return null;
    return {roomId: chatWs.activeRoomId, kind: chatWs.activeKind, label: chatWs.activeLabel};
  }
  function updateChatBackButton(){
    var button = el('#chatBackBtn');
    if(!button) return;
    var visible = !!chatNavigation.back;
    button.classList.toggle('visible', visible);
    button.setAttribute('aria-hidden', visible ? 'false' : 'true');
    button.tabIndex = visible ? 0 : -1;
  }
  function clearChatBack(){
    chatNavigation.back = null;
    updateChatBackButton();
  }
  function rememberChatBack(targetKind, targetRoomId){
    var current = chatCurrentLocation();
    if(!current){
      clearChatBack();
      return;
    }
    if(targetKind === current.kind && targetRoomId && targetRoomId === current.roomId){
      clearChatBack();
      return;
    }
    chatNavigation.back = current;
    updateChatBackButton();
  }
  function chatGoBack(){
    var previous = chatNavigation.back;
    if(!previous) return;
    chatNavigation.back = null;
    chatRoster.open = null;
    updateChatBackButton();
    clearChatActive();
    loadChatRoom(previous.roomId, previous.kind, previous.label);
  }
  function navigateToAgentChat(agent, keepBack){
    if(!agent) return;
    if(keepBack) rememberChatBack('agent', agent.roomId || agent.nativeConversationId || null);
    else clearChatBack();
    chatRoster.open = null;
    clearChatActive();
    selectAgentRoom(agent);
  }

  function chatVisibleHumans(humans){
    return (humans || []).filter(function(h){
      // roomState is the Mia membership authority. A pending membership
      // remains visible
      // while a removed member stays out after its membership is revoked.
      // Keep the legacy fallback for older/local responses.
      return h.roomState ? h.roomState === 'active' : h.inChat === true;
    });
  }

  // When the realtime service is unavailable, the local agent directory is still the
  // authoritative source for which agents are assigned to a department. Mia
  // is always the lead in this local view; humans are deliberately omitted
  // because their room membership is not available locally.
  function localDepartmentAgentRoster(label, isHome){
    var department = String(label || '').trim().toLowerCase();
    var assigned = (chatWs.allAgents || []).filter(function(a){
      if(!a || a.id === 'gateway') return false;
      if(isHome) return true;
      return agentDepartments(a).some(function(d){ return String(d || '').trim().toLowerCase() === department; });
    }).map(function(a){ return {id: a.id, name: a.name || a.id}; });
    return [{id: 'gateway', name: 'Mia'}].concat(assigned);
  }

  function chatRosterData(){
    var roomId = chatWs.activeRoomId;
    var roster = roomId && chatRoomState(roomId).mentionRoster;
    if(!roster || roster.loading){
      if(STYLED_SKIN && chatWs.configured === false && (chatWs.activeKind === 'home' || chatWs.activeKind === 'department')){
        var localAgents = localDepartmentAgentRoster(chatWs.activeLabel, chatWs.activeKind === 'home').map(function(a){
          var bench = a.id === 'gateway' ? null : (chatWs.allAgents || []).filter(function(x){ return x.id === a.id; })[0];
          return {kind: 'agent', id: 'agent:' + a.id, agentId: a.id, name: a.name,
            principalType: a.id === 'gateway' ? 'agent' : 'bot',
            initials: benchMark(a.name), model: bench && bench.model,
            departments: bench ? agentDepartments(bench) : [], state: bench && bench.state,
            rawStatus: null, replyAlways: false};
        });
        return {people: [], agents: localAgents, peopleUnavailable: true};
      }
      return null;
    }
    // Keep the full human directory in mentionRoster for invite/mention
    // flows, but do not present directory entries as room members here.
    var people = chatVisibleHumans(roster.humans).map(function(h){
      return {kind: 'human', id: 'human:' + h.email, name: displayNameForEmail(h.email), email: h.email,
        initials: initialsForUser(h.email), isYou: h.email === currentUser,
        membership: h.membership || (h.inChat ? 'join' : 'none')};
    });
    var agents = roster.agents.map(function(a){
      var bench = chatWs.allAgents.filter(function(x){ return x.id === a.id; })[0];
      // The home room's gateway entry (id 'gateway') never matches a real
      // /api/bots record — it carries its own `status` from the backend
      // instead of a bench state, and MODEL stays blank rather than guessed.
      return {kind: 'agent', id: 'agent:' + a.id, agentId: a.id, name: a.name,
        principalType: a.principalType || (a.id === 'gateway' ? 'agent' : 'bot'),
        initials: benchMark(a.name), model: bench && bench.model,
        departments: bench ? agentDepartments(bench) : (a.department ? [a.department] : []),
        state: bench && bench.state, rawStatus: a.status,
        replyAlways: a.replyAlways === true};
    });
    return {people: people, agents: agents};
  }

  function chatRosterRoleText(row){
    if(row.kind === 'human') return '';
    if(row.agentId === 'gateway') return 'Agent';
    return 'Bot';
  }
  function chatRosterAgentWorking(row){
    if(row.kind !== 'agent') return false;
    return agentHasLiveWork({id: row.agentId, name: row.name});
  }

  function chatRosterAgentCountLabel(rows){
    var agents = rows || [];
    if(agents.length === 1){
      return agents[0].principalType === 'bot' ? '1 bot' : '1 agent';
    }
    return agents.length + ' agents &amp; bots';
  }

  function chatRosterPeopleCountLabel(rows){
    var count = (rows || []).length;
    return count + (count === 1 ? ' user' : ' users');
  }

  function renderChatRosterChips(data){
    if(!data) return '';
    var html = '';
    if(data.peopleUnavailable){
      html += '<span class="ch-roster-chip ch-roster-unavailable" title="Human membership unavailable" aria-label="Human membership unavailable">' +
        '<span class="ch-roster-count">users unavailable</span></span>';
    }
    if(data.people.length){
      html += '<button type="button" class="ch-roster-chip' + (chatRoster.open === 'people' ? ' open' : '') + '" id="chatRosterPeopleBtn" title="People in this chat">' +
        '<span class="ch-roster-count">' + chatRosterPeopleCountLabel(data.people) + '</span></button>';
    }
    if(data.agents.length){
      html += '<button type="button" class="ch-roster-chip' + (chatRoster.open === 'agents' ? ' open' : '') + '" id="chatRosterAgentsBtn" title="Agents and bots in this chat">' +
        '<span class="ch-roster-count">' + chatRosterAgentCountLabel(data.agents) + '</span></button>';
    }
    return html;
  }

  // Working agents get the same blinking orange task dot used in the
  // sidebar. Humans and idle agents stay visually quiet: names carry the
  // list, not membership/status labels.
  function chatRosterStatusHtml(row){
    if(chatRosterAgentWorking(row)){
      return '<span class="chat-task-dot ch-roster-working-dot"></span>';
    }
    return '';
  }

  function renderChatRosterRow(row){
    var selected = row.kind === 'agent' && chatRoster.selectedAgentId === row.agentId;
    var role = chatRosterRoleText(row);
    return '<button type="button" class="ch-roster-row' + (selected ? ' selected' : '') + '" data-roster-id="' + esc(row.id) + '"' + (selected ? ' aria-current="true"' : '') + '>' +
      '<span class="ch-roster-row-avatar' + (row.kind === 'agent' ? ' agent' : '') + '">' + (row.kind === 'agent' ? agentAvatarHtml(row.name, row.agentId, 24, null, null, true) : humanAvatarInitialsHtml(row.email)) + '</span>' +
      '<span class="ch-roster-row-body"><span class="ch-roster-row-name">' + esc(row.name) + '</span>' + (role ? '<span class="ch-roster-row-role">' + esc(role) + '</span>' : '') + '</span>' +
      chatRosterStatusHtml(row) + '</button>';
  }

  function renderChatRosterPanel(data){
    if(!chatRoster.open || !data) return '';
    var list = chatRoster.open === 'people' ? data.people : data.agents;
    var label = chatRoster.open === 'people' ? 'USERS IN THIS CHAT' : 'AGENTS &amp; BOTS IN THIS CHAT';
    return '<div class="ch-roster-panel">' +
      '<div class="ch-roster-panel-head"><span class="ch-roster-panel-label">' + label + '</span>' +
      '<button type="button" class="ch-roster-close" id="chatRosterCloseBtn" aria-label="Close">&times;</button></div>' +
      (list.length ? list.map(renderChatRosterRow).join('') : '<div class="ch-roster-empty">nobody yet</div>') +
      '</div>';
  }

  function wireChatRosterControls(header, rosterData){
    var peopleBtn = el('#chatRosterPeopleBtn', header);
    if(peopleBtn) peopleBtn.addEventListener('click', function(e){
      e.stopPropagation();
      chatRoster.open = chatRoster.open === 'people' ? null : 'people';
      renderChatHeaderBar();
    });
    var agentsBtn = el('#chatRosterAgentsBtn', header);
    if(agentsBtn) agentsBtn.addEventListener('click', function(e){
      e.stopPropagation();
      chatRoster.open = chatRoster.open === 'agents' ? null : 'agents';
      renderChatHeaderBar();
    });
    var closeBtn = el('#chatRosterCloseBtn', header);
    if(closeBtn) closeBtn.addEventListener('click', function(e){
      e.stopPropagation();
      chatRoster.open = null;
      renderChatHeaderBar();
    });
    els('.ch-roster-row', header).forEach(function(row){
      row.addEventListener('click', function(e){
        e.stopPropagation();
        var rosterId = row.getAttribute('data-roster-id');
        var selected = rosterData && rosterData.people.concat(rosterData.agents).filter(function(item){ return item.id === rosterId; })[0];
        if(!selected) return;
        chatRoster.open = null;
        chatRoster.selectedAgentId = selected.kind === 'agent' ? selected.agentId : null;
        if(selected.kind === 'agent'){
          var agent = selected.agentId === 'gateway'
            ? chatWs.gatewayAgent
            : chatWs.allAgents.filter(function(item){ return item.id === selected.agentId; })[0];
          if(agent){
            // In the styled chat, an agent roster click is a profile/edit
            // selection in the shared right-side pane. Mia/gateway remains
            // chat-only because it is not an editable bench agent.
            if(styledAgentEditPaneAvailable() && selected.agentId !== 'gateway'){
              var benchAgent = findBenchAgent(agent.id) || cacheBenchAgent(benchAgentFromApiRecord(agent));
              if(benchAgent) {
                openEditCinema(benchAgent.id);
                renderChatHeaderBar();
              } else navigateToAgentChat(agent, true);
            } else navigateToAgentChat(agent, true);
          }
        } else {
          openHumanDirectMessage(selected.email, true);
        }
      });
    });
  }


  function getPluginShell(){
    if(pluginShell && document.body.contains(pluginShell)) return pluginShell;
    pluginShell = el('.styled-integrations-shell', el('#panel-integrations'));
    return pluginShell;
  }

  function restorePluginShell(){
    var shell = getPluginShell();
    var home = el('#panel-integrations .styled-integrations-page');
    if(shell && home && !home.contains(shell)) home.appendChild(shell);
    var pane = el('#chatInfoPane');
    if(pane) pane.classList.remove('plugins-open');
    pluginPaneRoomId = null;
  }

  function closePluginPane(){
    if(chatInfo.mode !== 'plugins') return;
    restorePluginShell();
    chatInfo.mode = 'automations';
    chatInfo.open = false;
    renderChatInfoPane();
    syncSidebarToolButtons();
  }

  function openPluginPane(){
    if(!STYLED_SKIN) return;
    prepareChatUtilityPane('plugins');
    pluginPaneRoomId = chatWs.activeRoomId;
    renderChatHeaderBar();
  }

  function manageAgentIsWorking(agent){
    return agentHasLiveWork(agent);
  }

  function manageAgentDescription(agent){
    if(agent.id === 'gateway') return 'Chief of staff';
    if(String(agent.status || '').toLowerCase() === 'draft') return 'Draft — finish setup to activate';
    var tasks = tasksForAgent(agent.id);
    if(tasks.length) return tasks[0].title || 'Working on a background task';
    var departments = agentDepartments(agent);
    return excerpt(agent.instructions || (departments.length ? departments.join(', ') : 'Ready for work'), 84);
  }

  function manageAgentList(){
    var list = [chatWs.gatewayAgent || {id:'gateway', name:'Mia', manager:true, department:'Mia'}];
    (chatWs.allAgents || []).forEach(function(agent){
      var status = String(agent.status || agent.state || '').toLowerCase();
      if(agent.id !== 'gateway' && status !== 'paused') list.push(agent);
    });
    return list;
  }

  function manageHumanRowHtml(human){
    var email = String(human.email || '').toLowerCase();
    return '<button type="button" class="manage-agent-row manage-human-row" data-manage-human="' + esc(email) + '">' +
      '<span class="manage-agent-avatar">' + humanAvatarInitialsHtml(email) + '</span>' +
      '<span class="manage-agent-copy"><span class="manage-agent-name">' + esc(displayNameForEmail(email)) + '</span>' +
      '<span class="manage-agent-description">' + esc(email) + '</span></span></button>';
  }

  function manageAgentColorInputId(agentId){
    return 'manageAgentColorInput-' + String(agentId || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function manageAgentColorOptionsHtml(agent){
    return '<div class="manage-agent-color-control"><span class="manage-agent-color-label">Avatar color</span><div class="manage-agent-color-options" data-manage-agent-color-options="' + esc(agent.id) + '">' +
      agentColorSwatchesHtml(agent.avatarColor, manageAgentColorInputId(agent.id), 'manage-agent-color') + '</div></div>';
  }

  function refreshManageAgentColorSurfaces(agentIdToKeepOpen){
    return loadAgents().then(function(agents){
      syncChatBotRecords(agents);
      return loadBenchAgents();
    }).then(function(){
      if(chatInfo.mode === 'agents') renderChatInfoPane();
      renderChatSidebar();
      renderChatHeaderBar();
      renderChatThread();
      refreshAgentsView();
      if(agentIdToKeepOpen && chatInfo.mode === 'agents' && chatInfo.open){
        var pane = el('#chatInfoPane');
        els('[data-manage-agent-actions]', pane).forEach(function(menu){
          menu.classList.toggle('open', menu.getAttribute('data-manage-agent-actions') === agentIdToKeepOpen);
        });
      }
    });
  }

  function saveManageAgentColor(agentId, value){
    var agent = manageAgentList().filter(function(item){ return item.id === agentId; })[0];
    if(!agent || agent.id === 'gateway') return;
    var options = els('[data-manage-agent-color-options]').filter(function(item){ return item.getAttribute('data-manage-agent-color-options') === agentId; })[0];
    var actionMenu = options && options.closest('[data-manage-agent-actions]');
    var color = normalizeAgentAvatarColor(value);
    api('/api/bots/' + encodeURIComponent(agent.id), {method:'PUT', body:{avatarColor: color || null}}).then(function(res){
      if(res.status !== 200){
        showBenchToast('Could not update avatar color');
        return;
      }
      var keepOpen = !!(actionMenu && actionMenu.classList.contains('open'));
      refreshManageAgentColorSurfaces(keepOpen ? agent.id : null).catch(function(){
        showBenchToast('Avatar color saved; refresh the agent list to see it');
      });
    }).catch(function(){ showBenchToast('Could not update avatar color'); });
  }

  function manageAgentRowHtml(agent){
    var working = manageAgentIsWorking(agent);
    var canEdit = agent.id !== 'gateway';
    return '<div class="manage-agent-row" data-manage-agent-row="' + esc(agent.id) + '"><button type="button" class="manage-agent-open">' +
      '<span class="manage-agent-avatar">' + agentAvatarHtml(agent.name, agent.id, 38, null, null, true) + '</span>' +
      '<span class="manage-agent-copy"><span class="manage-agent-name-line"><span class="manage-agent-name">' + esc(agent.name) + '</span>' +
      (working ? '<span class="chat-task-dot manage-agent-working-dot" title="Working now"></span>' : '') + '</span>' +
      '<span class="manage-agent-description">' + esc(manageAgentDescription(agent)) + '</span></span></button>' +
      (canEdit ? '<span class="manage-agent-menu-wrap"><button type="button" class="manage-agent-more" data-manage-agent-more="' + esc(agent.id) + '" aria-label="Manage ' + esc(agent.name) + '" title="Manage ' + esc(agent.name) + '">&#8942;</button>' +
      '<span class="manage-agent-actions" data-manage-agent-actions="' + esc(agent.id) + '"><button type="button" data-manage-agent-edit="' + esc(agent.id) + '">Edit bot</button>' + manageAgentColorOptionsHtml(agent) + '</span></span>' : '') +
      '</div>';
  }

  function manageAgentSectionHtml(label, agents, options){
    options = options || {};
    var rows = options.humans ? agents.map(manageHumanRowHtml) : agents.map(manageAgentRowHtml);
    var action = options.newBot
      ? '<button type="button" class="manage-agent-section-add" id="manageAgentsNewBot" aria-label="Create a bot" title="Create a bot">+</button>'
      : options.manageUsers
        ? '<button type="button" class="manage-agent-section-link" id="manageUsersAdmin">Manage</button>'
        : '';
    return '<section class="manage-agent-section"><div class="manage-agent-section-head"><span>' + esc(label) + '</span><span class="manage-agent-section-tools"><span>' + agents.length + '</span>' + action + '</span></div>' +
      (rows.length ? '<div class="manage-agent-list">' + rows.join('') + '</div>' : '') + '</section>';
  }

  function renderManageAgentsPane(pane){
    var groups = {agent: [], bots: []};
    manageAgentList().forEach(function(agent){
      if(agent.id === 'gateway') groups.agent.push(agent);
      else groups.bots.push(agent);
    });
    var multiplayer = appCollaborationMode === 'multiplayer';
    var paneTitle = multiplayer ? 'People, Agents & Bots' : 'Agents & Bots';
    pane.setAttribute('aria-label', paneTitle);
    pane.classList.remove('plugins-open', 'bot-store-open');
    pane.classList.add('open', 'agents-open');
    pane.innerHTML = '<div class="cip-pane-head manage-agents-pane-head"><span class="cip-pane-title">' + esc(paneTitle) + '</span><span class="cip-pane-spacer" aria-hidden="true"></span><div class="cip-pane-actions">' +
      '<button type="button" class="cip-pane-btn" id="manageAgentsPaneClose" aria-label="Close ' + esc(paneTitle) + '" title="Close ' + esc(paneTitle) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg></button></div></div>' +
      '<div class="manage-agents-body">' +
      (multiplayer ? manageAgentSectionHtml('Users', chatWs.humans || [], {humans:true, manageUsers:isAdmin}) : '') +
      manageAgentSectionHtml('Agent', groups.agent) + manageAgentSectionHtml('Bots', groups.bots, {newBot:true}) + '</div>';

    function openManageAgentEditor(agentId){
      loadBenchAgents().then(function(){
        var benchAgent = benchAgents.filter(function(item){ return item.id === agentId || item.agentId === agentId; })[0];
        if(!benchAgent){ showBenchToast('Bot editor is unavailable right now'); return; }
        closeManageAgentsPane();
        openEditCinema(benchAgent.id);
      });
    }

    var close = el('#manageAgentsPaneClose', pane);
    if(close) close.addEventListener('click', closeManageAgentsPane);
    var createBot = el('#manageAgentsNewBot', pane);
    if(createBot) createBot.addEventListener('click', startAgentSetupChat);
    var manageUsers = el('#manageUsersAdmin', pane);
    if(manageUsers) manageUsers.addEventListener('click', function(){ location.href = '/admin#/users'; });
    els('[data-manage-human]', pane).forEach(function(row){
      row.addEventListener('click', function(){
        closeManageAgentsPane();
        openHumanDirectMessage(row.getAttribute('data-manage-human'), true);
      });
    });
    els('.manage-agent-row[data-manage-agent-row]', pane).forEach(function(row){
      row.addEventListener('click', function(e){
        if(e.target.closest('.manage-agent-menu-wrap')) return;
        var agent = manageAgentList().filter(function(item){ return item.id === row.getAttribute('data-manage-agent-row'); })[0];
        if(!agent) return;
        if(agent.id === 'gateway'){
          closeManageAgentsPane();
          navigateToAgentChat(agent, true);
          return;
        }
        openManageAgentEditor(agent.id);
      });
    });
    els('[data-manage-agent-more]', pane).forEach(function(button){
      button.addEventListener('click', function(e){
        e.stopPropagation();
        var id = button.getAttribute('data-manage-agent-more');
        els('[data-manage-agent-actions]', pane).forEach(function(menu){
          var shouldOpen = menu.getAttribute('data-manage-agent-actions') === id && !menu.classList.contains('open');
          menu.classList.toggle('open', shouldOpen);
        });
      });
    });
    els('[data-manage-agent-edit]', pane).forEach(function(button){
      button.addEventListener('click', function(e){
        e.stopPropagation();
        var id = button.getAttribute('data-manage-agent-edit');
        openManageAgentEditor(id);
      });
    });
    els('[data-manage-agent-color-options]', pane).forEach(function(options){
      var id = options.getAttribute('data-manage-agent-color-options');
      options.addEventListener('click', function(e){
        var button = e.target.closest('[data-agent-color]');
        if(!button) return;
        e.stopPropagation();
        saveManageAgentColor(id, button.getAttribute('data-agent-color'));
      });
      options.addEventListener('change', function(e){
        if(!e.target || e.target.type !== 'color') return;
        e.stopPropagation();
        saveManageAgentColor(id, e.target.value);
      });
    });
  }

  function closeManageAgentsPane(){
    if(chatInfo.mode !== 'agents') return;
    document.body.classList.remove('manage-agents-open');
    chatInfo.mode = 'automations';
    chatInfo.open = false;
    renderChatInfoPane();
    syncSidebarToolButtons();
    returnAgentEditFocus();
  }

  function openManageAgentsPane(){
    if(!STYLED_SKIN) return;
    prepareChatUtilityPane('agents');
    renderChatInfoPane();
    Promise.all([loadAgents(), appCollaborationMode === 'multiplayer' ? loadChatHumans() : Promise.resolve(chatWs.humans)]).then(function(results){
      syncChatBotRecords(results[0]);
      if(chatInfo.mode === 'agents') renderChatInfoPane();
    });
  }

  function renderAutomationDetailPane(pane, bot, automation, isNew){
    automation = automation || {name:'New automation', enabled:false, frequency:'none'};
    var promptMissing = automation.enabled === true && !String(automation.prompt || '').trim();
    var frequency = automation.frequency === 'daily' && automation.weekdaysOnly ? 'weekdays' : ['interval', 'daily', 'weekly', 'monthly'].indexOf(automation.frequency) !== -1 ? automation.frequency : 'interval';
    var intervalParts = automationIntervalParts(automation.intervalMinutes || 5);
    var fields = automationDetailFields(bot, automation).filter(function(field){
      return ['Automation ID', 'Bot ID', 'Task', 'Latest run', 'Latest status', 'Latest delivery', 'Latest session'].indexOf(field.label) !== -1;
    });
    var metadata = fields.map(function(field){
      return '<div class="cip-automation-detail-field' + (field.multiline ? ' is-multiline' : '') + '">' +
        '<div class="cip-automation-detail-label">' + esc(field.label) + '</div>' +
        '<div class="cip-automation-detail-value">' + esc(field.value) + '</div></div>';
    }).join('');
    var title = String(automation.name || 'New automation');
    var weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var frequencyOptions = [
      ['interval', 'Repeating timer'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly']
    ].map(function(option){
      return '<option value="' + option[0] + '"' + (frequency === option[0] ? ' selected' : '') + '>' + option[1] + '</option>';
    }).join('');
    var weekdayOptions = weekdays.map(function(day){
      return '<option value="' + day + '"' + (String(automation.day || 'Monday') === day ? ' selected' : '') + '>' + day + '</option>';
    }).join('');
    pane.setAttribute('aria-label', title + ' automation details');
    pane.classList.remove('plugins-open', 'agents-open', 'bot-store-open');
    pane.classList.add('open', 'automation-detail-open');
    pane.innerHTML = '<div class="cip-pane-head cip-automation-detail-head">' +
      '<button type="button" class="cip-automation-back" id="automationDetailBack" aria-label="Back to automations" title="Back to automations"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"></path></svg><span>Automations</span></button>' +
      '<button type="button" class="cip-pane-btn" id="automationDetailClose" aria-label="Close automation details" title="Close automation details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button></div>' +
      '<div class="cip-automation-detail-body"><div class="cip-automation-detail-title">' + esc(title) + '</div>' +
      '<form class="cip-automation-form" id="automationDetailForm">' +
        '<label class="cip-field"><span class="cip-field-label">Name</span><input type="text" id="automationEditName" value="' + esc(automation.name || '') + '" maxlength="80" required></label>' +
        '<div class="cip-editor-row-top"><span class="cip-editor-active-label">Active</span><label class="styled-toggle"><input type="checkbox" id="automationEditEnabled"' + (automation.enabled === true && !promptMissing ? ' checked' : '') + '><span class="gt-track"></span></label></div>' +
        (promptMissing ? '<div class="cip-automation-prompt-warning" role="status">Paused until you add a task prompt and turn Active on.</div>' : '') +
        '<label class="cip-field"><span class="cip-field-label">Schedule</span><select id="automationEditFrequency">' + frequencyOptions + '</select></label>' +
        '<label class="cip-field" data-frequency-control="interval"><span class="cip-field-label">Timer</span><span class="cip-automation-timer"><span>Every</span><input type="number" id="automationEditInterval" min="1" max="' + (intervalParts.unit === 'hours' ? '24' : '60') + '" value="' + esc(intervalParts.value) + '"><select id="automationEditIntervalUnit" aria-label="Timer unit"><option value="minutes"' + (intervalParts.unit === 'minutes' ? ' selected' : '') + '>minutes</option><option value="hours"' + (intervalParts.unit === 'hours' ? ' selected' : '') + '>hours</option></select></span></label>' +
        '<label class="cip-field" data-frequency-control="weekly"><span class="cip-field-label">Weekday</span><select id="automationEditWeekday">' + weekdayOptions + '</select></label>' +
        '<label class="cip-field" data-frequency-control="monthly"><span class="cip-field-label">Day of month</span><input type="number" id="automationEditMonthDay" min="1" max="31" value="' + esc(automation.day || 1) + '"></label>' +
        '<label class="cip-field" data-frequency-control="time"><span class="cip-field-label">Time' + (Number.isInteger(automation.utcOffsetMinutes) ? ' · ' + newsTimeZoneLabel(automation.utcOffsetMinutes) : '') + '</span><input type="time" id="automationEditTime" value="' + esc(automation.time || '09:00') + '"></label>' +
        '<label class="cip-field"><span class="cip-field-label">Prompt</span><textarea id="automationEditPrompt" rows="6">' + esc(automation.prompt || '') + '</textarea></label>' +
        '<div class="cip-automation-form-error" id="automationDetailError" role="alert"></div>' +
        '<div class="cip-editor-actions">' + (!isNew ? '<button type="button" class="styled-btn-secondary danger" id="automationDetailDelete">Delete</button>' : '') + '<button type="button" class="styled-btn-secondary" id="automationDetailCancel">Cancel</button><button type="submit" class="styled-btn-primary" id="automationDetailSave">' + (isNew ? 'Add automation' : 'Save') + '</button></div>' +
      '</form>' + metadata + '</div>';
    var form = el('#automationDetailForm', pane);
    var enabledInput = el('#automationEditEnabled', pane);
    var frequencyInput = el('#automationEditFrequency', pane);
    function updateScheduleControls(){
      var selected = frequencyInput.value;
      frequencyInput.disabled = false;
      els('[data-frequency-control]', pane).forEach(function(field){
        var control = field.getAttribute('data-frequency-control');
        var visible = control === selected || (control === 'time' && selected !== 'interval');
        field.hidden = !visible;
      });
    }
    enabledInput.addEventListener('change', updateScheduleControls);
    frequencyInput.addEventListener('change', updateScheduleControls);
    var intervalUnitInput = el('#automationEditIntervalUnit', pane);
    if(intervalUnitInput) intervalUnitInput.addEventListener('change', function(){
      el('#automationEditInterval', pane).max = intervalUnitInput.value === 'hours' ? '24' : '60';
    });
    updateScheduleControls();
    form.addEventListener('submit', function(event){
      event.preventDefault();
      var errorNode = el('#automationDetailError', pane);
      var save = el('#automationDetailSave', pane);
      errorNode.textContent = '';
      var payload;
      try {
        payload = normalizedAutomationEditorPayload(bot, isNew ? null : automation.id, {
          name: el('#automationEditName', pane).value,
          enabled: enabledInput.checked,
          frequency: frequencyInput.value,
          intervalValue: el('#automationEditInterval', pane).value,
          intervalUnit: el('#automationEditIntervalUnit', pane).value,
          day: frequencyInput.value === 'weekly' ? el('#automationEditWeekday', pane).value : el('#automationEditMonthDay', pane).value,
          time: el('#automationEditTime', pane).value,
          prompt: el('#automationEditPrompt', pane).value
        });
      } catch(error) {
        errorNode.textContent = error.message || 'Check the automation fields.';
        return;
      }
      save.disabled = true;
      save.textContent = 'Saving…';
      api('/api/bots/' + encodeURIComponent(bot.id), {method:'PUT', body:payload}).then(function(res){
        if(res.status !== 200 || !res.data || !res.data.bot) throw new Error((res.data && res.data.error) || 'Could not save automation.');
        var saved = res.data.bot;
        chatWs.botRecords = (chatWs.botRecords || []).map(function(record){ return String(record.id) === String(saved.id) ? saved : record; });
        chatWs.allAgents = (chatWs.allAgents || []).map(function(record){ return String(record.id) === String(saved.id) ? Object.assign({}, record, saved) : record; });
        var savedAutomations = botAutomationList(saved);
        var savedAutomation = isNew ? savedAutomations[savedAutomations.length - 1] : savedAutomations.filter(function(item){ return String(item.id) === String(automation.id); })[0];
        chatInfo.automationBotId = saved.id;
        chatInfo.automationId = savedAutomation ? savedAutomation.id : null;
        renderAutomationDetailPane(pane, saved, savedAutomation, false);
        renderChatSidebar();
      }).catch(function(error){
        errorNode.textContent = error.message || 'Could not save automation.';
        save.disabled = false;
        save.textContent = isNew ? 'Add automation' : 'Save';
      });
    });
    var back = el('#automationDetailBack', pane);
    if(back) back.addEventListener('click', function(){
      chatInfo.automationBotId = null;
      chatInfo.automationId = null;
      renderChatInfoPane();
    });
    var close = el('#automationDetailClose', pane);
    if(close) close.addEventListener('click', function(){
      chatInfo.automationBotId = null;
      chatInfo.automationId = null;
      chatInfo.open = false;
      localStorage.setItem('styledInfoPaneOpen', '0');
      renderChatInfoPane();
      renderChatHeaderBar();
    });
    var cancel = el('#automationDetailCancel', pane);
    if(cancel) cancel.addEventListener('click', function(){
      chatInfo.automationBotId = null;
      chatInfo.automationId = null;
      renderChatInfoPane();
    });
    var remove = el('#automationDetailDelete', pane);
    if(remove) remove.addEventListener('click', function(){
      if(!window.confirm('Delete this automation? It will not run again.')) return;
      remove.disabled = true;
      var remaining = botAutomationList(bot).filter(function(item){ return String(item.id) !== String(automation.id); });
      api('/api/bots/' + encodeURIComponent(bot.id), {method:'PUT', body:{automations:remaining}}).then(function(res){
        if(res.status !== 200 || !res.data || !res.data.bot) throw new Error((res.data && res.data.error) || 'Could not delete automation.');
        var saved = res.data.bot;
        chatWs.botRecords = (chatWs.botRecords || []).map(function(record){ return String(record.id) === String(saved.id) ? saved : record; });
        chatInfo.automationBotId = null;
        chatInfo.automationId = null;
        renderChatInfoPane();
      }).catch(function(error){
        el('#automationDetailError', pane).textContent = error.message || 'Could not delete automation.';
        remove.disabled = false;
      });
    });
  }

  // Bot Store: a read-only marketplace of predefined bots (bots-catalog/ in
  // the repo, served via GET /api/bots/catalog and GET /api/bots/catalog/:id).
  // Installing one POSTs manifest.bot through the exact same create path
  // startAgentSetupChat's review card uses, then greets the new room with
  // manifest.welcome the same way buildAgentSetupWelcomeMessage does for a
  // hand-built bot — see createNativeAgentConversation / chatRoomState(...).localWelcome.
  function closeBotStorePane(){
    if(chatInfo.mode !== 'bot-store') return;
    chatInfo.mode = 'automations';
    chatInfo.open = false;
    renderChatInfoPane();
    syncSidebarToolButtons();
  }

  function openBotStorePane(){
    if(!STYLED_SKIN) return;
    prepareChatUtilityPane('bot-store');
    renderChatInfoPane();
    loadBotStoreCatalog();
  }

  function loadBotStoreCatalog(force){
    if(botStoreState.entries && !force){
      if(chatInfo.mode === 'bot-store') renderChatInfoPane();
      return;
    }
    botStoreState.loading = true;
    botStoreState.error = '';
    if(chatInfo.mode === 'bot-store') renderChatInfoPane();
    api('/api/bots/catalog').then(function(res){
      if(res.status !== 200 || !res.data || !Array.isArray(res.data.bots)) throw new Error('catalog unavailable');
      return Promise.all(res.data.bots.map(function(entry){
        return api('/api/bots/catalog/' + encodeURIComponent(entry.id));
      }));
    }).then(function(results){
      botStoreState.entries = results
        .filter(function(res){ return res.status === 200 && res.data && res.data.bot; })
        .map(function(res){ return res.data; });
      botStoreState.loading = false;
    }).catch(function(){
      botStoreState.loading = false;
      botStoreState.error = 'The bot store is unavailable right now.';
    }).then(function(){
      if(chatInfo.mode === 'bot-store') renderChatInfoPane();
    });
  }

  // "Installed" detection is name-based (v1 has no manifest-id linkage on
  // created bot records), same scope as the rest of the roster the user sees.
  function botStoreInstalledAgentByName(name){
    var target = String(name || '').trim().toLowerCase();
    if(!target) return null;
    return (chatWs.allAgents || []).filter(function(agent){
      return String(agent.name || '').trim().toLowerCase() === target;
    })[0] || null;
  }

  function botStoreCardHtml(manifest){
    var bot = manifest.bot || {};
    var store = manifest.store || {};
    var requires = store.requires || {};
    var connectors = Array.isArray(requires.connectors) ? requires.connectors : [];
    var installed = botStoreInstalledAgentByName(bot.name);
    var installing = botStoreState.installingId === manifest.id;
    return '<div class="bot-store-card" data-bot-store-card="' + esc(manifest.id) + '">' +
      '<span class="bot-store-card-avatar">' + agentAvatarHtml(bot.name || manifest.id, null, 40, null, store.avatarColor || bot.avatarColor || null) + '</span>' +
      '<div class="bot-store-card-body">' +
        '<div class="bot-store-card-head"><span class="bot-store-card-name">' + esc(bot.name || manifest.id) + '</span><span class="bot-store-card-version">v' + esc(manifest.version || '') + '</span></div>' +
        '<div class="bot-store-card-tagline">' + esc(store.tagline || '') + '</div>' +
        '<div class="bot-store-card-meta"><span>' + esc(store.category || 'general') + '</span><span aria-hidden="true">&middot;</span><span>' + esc(manifest.author || 'Mia Labs') + '</span></div>' +
        (connectors.length ? '<div class="bot-store-card-requires">Requires: ' + esc(connectors.join(', ')) + '</div>' : '') +
      '</div>' +
      (installed
        ? '<span class="bot-store-card-installed">Installed</span>'
        : '<button type="button" class="bot-store-card-install" data-bot-store-install="' + esc(manifest.id) + '"' + (installing ? ' disabled' : '') + '>' + (installing ? 'Installing…' : 'Install') + '</button>') +
      '</div>';
  }

  function renderBotStorePane(pane){
    pane.setAttribute('aria-label', 'Bot store');
    pane.classList.remove('plugins-open', 'agents-open', 'automation-detail-open', 'bot-store-open');
    pane.classList.add('open', 'bot-store-open');
    var body;
    if(botStoreState.loading && !botStoreState.entries){
      body = '<div class="bot-store-status">Loading bots…</div>';
    } else if(botStoreState.error){
      body = '<div class="bot-store-status bot-store-error">' + esc(botStoreState.error) + '</div>';
    } else if(!botStoreState.entries || !botStoreState.entries.length){
      body = '<div class="bot-store-status">No bots available right now.</div>';
    } else {
      body = '<div class="bot-store-list">' + botStoreState.entries.map(botStoreCardHtml).join('') + '</div>';
    }
    pane.innerHTML = '<div class="cip-pane-head"><span class="cip-pane-title">Bot store</span><span class="cip-pane-spacer" aria-hidden="true"></span><div class="cip-pane-actions">' +
      '<button type="button" class="cip-pane-btn" id="botStorePaneClose" aria-label="Close Bot store" title="Close Bot store"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg></button></div></div>' +
      '<div class="bot-store-body">' + body + '</div>';
    var close = el('#botStorePaneClose', pane);
    if(close) close.addEventListener('click', closeBotStorePane);
    els('[data-bot-store-install]', pane).forEach(function(button){
      button.addEventListener('click', function(){ installBotStoreBot(button.getAttribute('data-bot-store-install')); });
    });
  }

  // Same message shape buildAgentSetupWelcomeMessage produces for a
  // hand-built bot, but the body comes straight from the manifest's own
  // `welcome` text instead of being assembled from a setup draft.
  function buildBotStoreWelcomeMessage(roomId, created, welcomeText){
    var fallbackName = (created && created.name) || 'your new bot';
    return {
      id: 'local-welcome-' + roomId,
      sender: (created && created.id) || 'bot',
      nativeAgentName: (created && created.name) || null,
      body: String(welcomeText || '').trim() || ('I’m ' + fallbackName + '. What should I work on first?'),
      media: null,
      attachments: [],
      ts: Date.now(),
      threadRoot: null,
      editTs: 0,
      system: false,
      pending: false,
      deleted: false,
      clientIdempotencyKey: null,
      nativeDispatchId: null,
      nativeProgress: false,
      nativeDiagnostic: false,
      nativeEvent: null
    };
  }

  function installBotStoreBot(id){
    if(!id || botStoreState.installingId) return;
    var manifest = (botStoreState.entries || []).filter(function(entry){ return entry.id === id; })[0];
    if(!manifest){ showBenchToast('That bot is unavailable right now'); return; }
    var already = botStoreInstalledAgentByName(manifest.bot && manifest.bot.name);
    if(already){
      closeBotStorePane();
      navigateToAgentChat(already, true);
      return;
    }
    botStoreState.installingId = id;
    if(chatInfo.mode === 'bot-store') renderChatInfoPane();
    api('/api/bots/catalog/' + encodeURIComponent(id)).then(function(res){
      if(res.status !== 200 || !res.data || !res.data.bot) throw new Error('manifest unavailable');
      var freshManifest = res.data;
      return api('/api/bots', {method:'POST', body: freshManifest.bot}).then(function(createRes){
        if(createRes.status !== 201 || !createRes.data || !createRes.data.bot){
          throw new Error(createRes.data && (createRes.data.message || createRes.data.error) || 'install failed');
        }
        var created = createRes.data.bot;
        return createNativeAgentConversation(created, {}).then(function(conversation){
          var createdBotRecords = (chatWs.botRecords || []).filter(function(record){
            return String(record.id || '') !== String(created.id || '');
          });
          createdBotRecords.push(created);
          syncChatBotRecords(createdBotRecords);
          chatWs.nativeConversations.push(conversation);
          applyNativeConversationList(chatWs.nativeConversations);
          chatRoomState(conversation.id).localWelcome = buildBotStoreWelcomeMessage(conversation.id, created, freshManifest.welcome);
          botStoreState.installingId = null;
          closeBotStorePane();
          renderChatSidebar();
          renderChatHeaderBar();
          loadChatRoom(conversation.id, 'agent', created.name);
        });
      });
    }).catch(function(err){
      botStoreState.installingId = null;
      if(chatInfo.mode === 'bot-store') renderChatInfoPane();
      showBenchToast('Could not install bot: ' + (err && err.message ? err.message : 'please try again.'));
    });
  }

  function renderChatInfoPane(){
    var pane = el('#chatInfoPane');
    if(!pane) return;
    if(chatInfo.mode === 'plugins' && pluginPaneRoomId !== chatWs.activeRoomId){
      restorePluginShell();
      chatInfo.mode = 'automations';
    }
    var specialMode = chatInfo.mode === 'plugins' || chatInfo.mode === 'agents' || chatInfo.mode === 'agent-edit' || chatInfo.mode === 'automation-detail' || chatInfo.mode === 'bot-store';
    if(!STYLED_SKIN || !chatInfo.open || (!chatWs.activeRoomId && chatInfo.mode !== 'agents' && chatInfo.mode !== 'plugins' && chatInfo.mode !== 'agent-edit' && chatInfo.mode !== 'bot-store') || (!specialMode && !isInfoPaneAvailable())){
      restorePluginShell();
      pane.classList.remove('open', 'agents-open', 'agent-edit-open', 'automation-detail-open', 'bot-store-open');
      pane.innerHTML = '';
      return;
    }
    if(chatInfo.mode === 'agent-edit'){
      renderStyledAgentEditPane(pane);
      return;
    }
    if(chatInfo.mode === 'bot-store'){
      renderBotStorePane(pane);
      return;
    }
    if(chatInfo.mode === 'automation-detail'){
      var automationBot = automationRecordById(chatInfo.automationBotId);
      var automationSelection = chatInfo.automationId === 'new'
        ? {bot:automationBot, automation:null}
        : automationRecordById(chatInfo.automationBotId, chatInfo.automationId);
      if(automationBot && automationSelection){
        renderAutomationDetailPane(pane, automationBot, automationSelection.automation, chatInfo.automationId === 'new');
        return;
      }
      chatInfo.mode = 'automations';
      chatInfo.automationBotId = null;
      chatInfo.automationId = null;
    }
    if(chatInfo.mode === 'agents'){
      renderManageAgentsPane(pane);
      return;
    }
    if(chatInfo.mode === 'plugins'){
      var shell = getPluginShell();
      pane.setAttribute('aria-label', 'Connected apps');
      pane.classList.remove('agents-open', 'bot-store-open');
      pane.classList.add('open', 'plugins-open');
      pane.innerHTML = '<div class="cip-pane-head styled-plugin-pane-head"><span class="cip-pane-title">Connected apps</span><span class="cip-pane-spacer" aria-hidden="true"></span><div class="cip-pane-actions">' +
        '<button type="button" class="cip-pane-btn" id="styledPluginPaneClose" aria-label="Close connected apps" title="Close connected apps"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg></button></div></div>';
      if(shell) pane.appendChild(shell);
      var pluginClose = el('#styledPluginPaneClose', pane);
      if(pluginClose) pluginClose.addEventListener('click', closePluginPane);
      return;
    }
    pane.classList.remove('plugins-open', 'agents-open', 'automation-detail-open', 'bot-store-open');
    pane.setAttribute('aria-label', 'Automations');
    var agent = chatWs.activeKind === 'agent'
      ? chatWs.allAgents.filter(function(a){ return a.roomId === chatWs.activeRoomId || a.nativeConversationId === chatWs.activeRoomId || a.name === chatWs.activeLabel; })[0]
      : null;
    var name = chatWs.activeLabel || (agent && agent.name) || 'Agent';
    var isMia = isMiaOrchestrator(name, agent && agent.id);
    var automationBots = automationBotsForPanel(isMia, agent);
    var automationRuns = activeAutomationRunsForPanel(isMia, agent);
    var routines = automationBots.length ? automationBots.map(function(entry){
      return '<button type="button" class="cip-routine-row" data-bot-id="' + esc(entry.bot.id) + '" data-automation-id="' + esc(entry.automation.id) + '" aria-label="View ' + esc(entry.automation.name || 'automation') + '"><span class="cip-routine-dot">&#9679;</span>' +
        '<span><span class="cip-routine-name">' + esc(entry.automation.name || 'Automation') + '</span>' +
        '<span class="cip-routine-meta">' + esc(automationScheduleText(entry.automation)) + '</span></span></button>';
    }).join('') : '<div class="cip-routines-empty' + (automationRuns.length ? ' has-running' : '') + '"><div class="cip-routines-empty-text">No automations yet.</div><button type="button" class="cip-automation-link" id="chatInfoAddRoutine"><svg class="cip-automation-zap" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5 3 9h4.2L7 14.5 13 7H8.8L9 1.5z"/></svg><span>Create automation</span></button></div>';
    var running = automationRuns.length ? '<div class="cip-routines-head cip-running-head"><span class="cip-routines-title">Running now</span></div><div class="cip-routine-list">' + automationRuns.map(function(run){
      return '<button type="button" class="cip-routine-row" data-running-automation-id="' + esc(run.id) + '"' + (run.conversationId ? '' : ' disabled') + ' aria-label="Open ' + esc(run.name || 'automation') + ' conversation"><span class="cip-routine-dot">&#9679;</span>' +
        '<span><span class="cip-routine-name">' + esc(runningAutomationLabel(run)) + '</span>' +
        '<span class="cip-routine-meta">Running</span></span></button>';
    }).join('') + '</div>' : '';
    pane.classList.add('open');
    pane.innerHTML = '<div class="cip-pane-head"><span class="cip-pane-spacer" aria-hidden="true"></span><div class="cip-pane-actions">' +
      '<button type="button" class="cip-pane-btn" id="chatInfoSettings" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm7.1 3.7a7.2 7.2 0 0 0-.1-1l1.2-.9-1.7-2.9-1.4.6a7.3 7.3 0 0 0-1.7-1l-.2-1.5h-3.4l-.2 1.5a7.3 7.3 0 0 0-1.7 1l-1.4-.6-1.7 2.9 1.2.9a7.2 7.2 0 0 0 0 2l-1.2.9 1.7 2.9 1.4-.6a7.3 7.3 0 0 0 1.7 1l.2 1.5h3.4l.2-1.5a7.3 7.3 0 0 0 1.7-1l1.4.6 1.7-2.9-1.2-.9a7.2 7.2 0 0 0 .1-1Z"></path></svg></button>' +
      '<button type="button" class="cip-pane-btn" id="chatInfoClose" aria-label="Close automations" title="Close automations"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"></path></svg></button></div></div>' +
      '<div class="cip-routines">' + (automationBots.length ? '<div class="cip-routines-head"><span class="cip-routines-title">Automations</span>' +
      '<button type="button" class="cip-routines-add" id="chatInfoAddRoutineTop" aria-label="Add automation">+</button></div>' +
      '<div class="cip-routine-list">' + routines + '</div>' : routines) + running + '</div>';
    var close = el('#chatInfoClose', pane);
    if(close) close.addEventListener('click', function(){
      chatInfo.automationBotId = null;
      chatInfo.automationId = null;
      chatInfo.open = false;
      localStorage.setItem('styledInfoPaneOpen', '0');
      renderChatInfoPane();
      renderChatHeaderBar();
    });
    var settings = el('#chatInfoSettings', pane);
    if(settings) settings.addEventListener('click', function(){ showBenchToast('Bot settings are upcoming'); });
    bindAutomationRows(pane);
    bindRunningAutomationRows(pane);
    els('#chatInfoAddRoutine, #chatInfoAddRoutineTop', pane).forEach(function(btn){
      btn.addEventListener('click', function(){
        if(!agent) return showBenchToast('Open a bot conversation to add an automation.');
        if(!openAutomationDetail(agent.id, null, true)) showBenchToast('This bot already has 10 automations.');
      });
    });
  }

  function openAutomationsFromTools(){
    closeLocalBrowser();
    var selection;
    if(!isInfoPaneAvailable() || chatWs.activeKind !== 'agent'){
      if(!chatWs.gatewayAgent){ showBenchToast('Mia is still loading. Try again in a moment.'); return; }
      selection = selectAgentRoom(chatWs.gatewayAgent);
    }
    Promise.resolve(selection).then(function(){
      if(!isInfoPaneAvailable()){ showBenchToast('Open a Mia or bot conversation to see its automations.'); return; }
      localStorage.setItem('styledInfoPaneOpen', '1');
      renderChatHeaderBar();
      prepareChatUtilityPane('automations');
      renderChatInfoPane();
    });
  }

  function toggleChatInfoPane(){
    if(!isInfoPaneAvailable()) return;
    var replacedThread = closeChatThread();
    var replacedTasks = closeChatTasksPanel();
    var switchingMode = chatInfo.mode !== 'automations';
    if(switchingMode) prepareChatUtilityPane('automations');
    else chatInfo.open = (replacedThread || replacedTasks) ? true : !chatInfo.open;
    localStorage.setItem('styledInfoPaneOpen', chatInfo.open ? '1' : '0');
    renderChatInfoPane();
    renderChatHeaderBar();
  }

  // The header menu is deliberately small and room-scoped. Native agent
  // conversations can be restarted by their members; official native
  // channels retain the older shared "Reset channel" wording and intent.
  var channelMenu = {open: false, roomId: null, confirming: false, busy: false};

  function channelMenuKind(){
    if(chatWs.activeKind === 'agent') return 'conversation';
    if(isAdmin && (chatWs.activeKind === 'home' || chatWs.activeKind === 'department')) return 'channel';
    return null;
  }

  function channelMenuIsChat(){
    return channelMenuKind() === 'conversation';
  }

  function resetChannelMenuState(){
    channelMenu.open = false;
    channelMenu.roomId = null;
    channelMenu.confirming = false;
    channelMenu.busy = false;
  }

  function closeChannelMenu(){
    if(!channelMenu.open && !channelMenu.confirming && !channelMenu.busy) return;
    resetChannelMenuState();
    if(chatWs.activeRoomId) renderChatHeaderBar();
  }

  function renderChannelMenuHtml(){
    var kind = channelMenuKind();
    if(!kind) return '';
    var isChat = kind === 'conversation';
    if(channelMenu.confirming){
      var confirmText = isChat
        ? 'This clears this conversation\'s history for a fresh start. Restart conversation?'
        : 'This clears the channel history for everyone. Reset channel?';
      var goLabel = isChat ? 'Restart' : 'Reset channel';
      var busyLabel = isChat ? 'Restarting&hellip;' : 'Resetting&hellip;';
      return '<div class="cmp-confirm">' +
        '<div class="cmp-confirm-text">' + confirmText + '</div>' +
        '<div class="cmp-confirm-actions">' +
          '<button type="button" class="cmp-confirm-btn cmp-confirm-add" id="channelMenuResetBtn"' + (channelMenu.busy ? ' disabled' : '') + '>' + (channelMenu.busy ? busyLabel : goLabel) + '</button>' +
          '<button type="button" class="cmp-confirm-btn cmp-confirm-cancel" id="channelMenuCancelBtn"' + (channelMenu.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div></div>';
    }
    return '<div class="cmp-section-label">' + (isChat ? 'CONVERSATION' : 'CHANNEL') + '</div>' +
      '<button type="button" class="channel-menu-item" id="channelMenuResetItem" role="menuitem">' + (isChat ? 'Restart conversation' : 'Reset channel') + '</button>';
  }

  function clearChatRoomStateAfterRestart(roomId){
    var state = chatRoomState(roomId);
    if(state.thinkingTimer){ clearTimeout(state.thinkingTimer); state.thinkingTimer = null; }
    state.thinking = false;
    state.thinkingSince = null;
    state.thinkingAgentName = null;
    state.messages = [];
    state.lastTs = 0;
    state.lastSequence = 0;
    state.openThreadRoot = null;
    state.localWelcome = null;
    state.historyCursor = null;
    state.historyLoading = false;
    state.historyComplete = true;
    state.historyEdits = {};
    state.sidebarPreviewLoading = false;
    state.sidebarPreviewLoaded = true;
  }

  function restartNativeConversation(roomId){
    return api(nativeConversationPath(roomId, '/restart'), {method:'POST', body:{}}).then(function(res){
      if(res.status >= 200 && res.status < 300) clearChatRoomStateAfterRestart(roomId);
      return res;
    });
  }

  function wireChannelMenu(header){
    var titleBtn = el('#channelTitleBtn', header);
    if(titleBtn){
      titleBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if(channelMenu.open){
          resetChannelMenuState();
        } else {
          channelMenu.open = true;
          channelMenu.roomId = chatWs.activeRoomId;
          channelMenu.confirming = false;
          channelMenu.busy = false;
        }
        renderChatHeaderBar();
      });
    }
    if(!channelMenu.open) return;
    var resetItem = el('#channelMenuResetItem', header);
    if(resetItem) resetItem.addEventListener('click', function(e){
      e.stopPropagation();
      channelMenu.confirming = true;
      renderChatHeaderBar();
    });
    var cancelBtn = el('#channelMenuCancelBtn', header);
    if(cancelBtn) cancelBtn.addEventListener('click', function(e){
      e.stopPropagation();
      channelMenu.confirming = false;
      renderChatHeaderBar();
    });
    var resetBtn = el('#channelMenuResetBtn', header);
    if(resetBtn) resetBtn.addEventListener('click', function(e){
      e.stopPropagation();
      if(channelMenu.busy) return;
      var roomId = channelMenu.roomId || chatWs.activeRoomId;
      if(!roomId){ closeChannelMenu(); return; }
      channelMenu.busy = true;
      renderChatHeaderBar();
      if(chatWs.activeRoomId === roomId){
        closeChatThread();
        closeChatTasksPanel();
      }
      restartNativeConversation(roomId).then(function(res){
        if(res.status < 200 || res.status >= 300){
          channelMenu.busy = false;
          showBenchToast((channelMenuIsChat() ? 'Restart' : 'Reset') + ' failed (' + res.status + ')');
          renderChatHeaderBar();
          return;
        }
        resetChannelMenuState();
        renderChatSidebar();
        if(chatWs.activeRoomId === roomId) renderChatThread();
        renderChatHeaderBar();
      }).catch(function(){
        channelMenu.busy = false;
        showBenchToast((channelMenuIsChat() ? 'Restart' : 'Reset') + ' failed — network error');
        renderChatHeaderBar();
      });
    });
  }

  document.addEventListener('click', function(e){
    if(!channelMenu.open) return;
    var header = el('#channelHeader');
    if(header && header.contains(e.target)) return;
    closeChannelMenu();
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && channelMenu.open) closeChannelMenu();
  });

  function renderChatHeaderBar(){
    var header = el('#channelHeader');
    if(!header) return;
    if(!chatWs.activeRoomId){ resetChannelMenuState(); syncSidebarToolButtons(); header.style.display = 'none'; header.innerHTML = ''; if(chatInfo.mode !== 'agents' && chatInfo.mode !== 'plugins') chatInfo.open = false; renderChatInfoPane(); return; }
    header.style.display = 'flex';
    if(chatInfo.mode === 'plugins' && pluginPaneRoomId !== chatWs.activeRoomId){
      restorePluginShell();
      chatInfo.mode = 'automations';
    }
    // Mobile: the pane would cover the whole conversation, so it never
    // auto-opens there -- the sidebar info button still toggles it.
    var roomChanged = chatInfo.roomId !== chatWs.activeRoomId;
    if(roomChanged){
      if(chatInfo.mode === 'agent-edit') closeCinema();
      resetChannelMenuState();
      chatInfo.roomId = chatWs.activeRoomId;
      chatRoster.selectedAgentId = null;
      if(chatInfo.mode !== 'plugins' && chatInfo.mode !== 'agents') chatInfo.open = false;
    }
    // Browser mode replaces the ordinary docked info pane with the fixed
    // collaboration pane — but the overlay modes (bot editor, Bot Store,
    // automation detail) render as fixed right-hand drawers ABOVE the
    // browser, so closing them here tore the editor down the moment
    // openProfile re-rendered this header after opening it.
    var collabMode = document.body.classList.contains('browser-collab-mode');
    var collabOverlayMode = chatInfo.mode === 'agent-edit' || chatInfo.mode === 'bot-store' || chatInfo.mode === 'automation-detail';
    if(collabMode && !collabOverlayMode) chatInfo.open = false;
    else if(!collabMode && STYLED_SKIN && chatInfo.mode !== 'plugins' && chatInfo.mode !== 'agents' && chatInfo.mode !== 'agent-edit' && chatWs.activeKind === 'agent') chatInfo.open = !isMobileChat() && chatInfoOpenPreference();
    if(STYLED_SKIN && chatInfo.mode !== 'plugins' && chatInfo.mode !== 'agents' && chatInfo.mode !== 'agent-edit' && !isInfoPaneAvailable()) chatInfo.open = false;
    syncSidebarToolButtons();
    // Official channels use a square initials mark. The owner's personal avatar
    // belongs to the account, not to the Multiplayer Test home channel.
    var officialChannel = chatWs.activeKind === 'home' || chatWs.activeKind === 'department';
    var headerMiaIsWorking = chatWs.activeKind === 'agent' && isMiaOrchestrator(chatWs.activeLabel, chatWs.activeLabel === 'Mia' ? 'gateway' : null) && roomHasModelResponseActivity(chatWs.activeRoomId);
    var markHtml = officialChannel
      ? '<span class="ch-mark channel">' + esc(benchMark(chatWs.activeLabel || 'Multiplayer Test')) + '</span>'
      : '<span class="ch-mark dm">' + ((chatWs.activeKind === 'agent' || chatWs.activeKind === 'agent-setup') ? agentAvatarHtml(chatWs.activeKind === 'agent-setup' ? 'New Bot' : chatWs.activeLabel, chatWs.activeKind === 'agent-setup' ? AGENT_SETUP_ROOM_ID : null, 24, headerMiaIsWorking ? 'activity' : null, null, true) : esc(benchMark(chatWs.activeLabel || '?'))) + '</span>';
    var title = chatWs.activeLabel;
    var rosterData = chatRosterData();
    var rosterChips = renderChatRosterChips(rosterData);
    var rosterOverlay = chatRoster.open ? renderChatRosterPanel(rosterData) : '';
    var conversationActions = renderConversationHeaderActions();
    var titleHtml = '<span class="channel-header-title" role="heading" aria-level="1">' + esc(title) + '</span>';
    var menuHtml = channelMenuKind() ? '<div class="channel-menu' + (channelMenu.open ? ' open' : '') + '" id="channelMenu" role="menu">' + (channelMenu.open ? renderChannelMenuHtml() : '') + '</div>' : '';
    var titleButtonHtml = channelMenuKind()
      ? '<button type="button" class="ch-title-btn" id="channelTitleBtn" aria-haspopup="menu" aria-controls="channelMenu" aria-expanded="' + (channelMenu.open ? 'true' : 'false') + '">' + markHtml + titleHtml + '<span class="ch-title-caret" aria-hidden="true">&#9662;</span></button>'
      : markHtml + titleHtml;
    if(STYLED_SKIN){
      var mobileBackBtn = '<button type="button" class="ch-mobile-back" id="chatMobileBack" aria-label="Back to chats">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg></button>';
      header.innerHTML = '<div class="ch-left">' + mobileBackBtn + '<div class="ch-title-row">' + titleButtonHtml + menuHtml + '</div></div>' +
        '<div class="ch-right">' + rosterChips + conversationActions + rosterOverlay + '</div>';
      var mobileBack = el('#chatMobileBack', header);
      if(mobileBack) mobileBack.addEventListener('click', closeMobileChatRoom);
      wireChannelMenu(header);
      wireChatRosterControls(header, rosterData);
      wireConversationHeaderActions(header);
      renderChatInfoPane();
      return;
    }
    // Export sits in the header per the mock, but there's nothing to export
    // yet — it's a quiet no-op, never a fake download.
    header.innerHTML = '<div class="ch-left"><div class="ch-title-row">' + titleButtonHtml + menuHtml + '</div></div>' +
      '<div class="ch-right">' + rosterChips + conversationActions + rosterOverlay + '<button type="button" class="ch-export-btn" id="chatExportBtn">Export</button></div>';
    wireChannelMenu(header);
    wireChatRosterControls(header, rosterData);
    wireConversationHeaderActions(header);
  }

  /* Department rooms have no single persona of their own (see addendum #3) —
     who a message is addressed to is a per-room UI selection, not something
     the room remembers server-side. There's no visible chip row for it
     anymore (@-mention is the only way to address someone — see
     insertMentionText); this just keeps chatRoomState(roomId).selectedAgentId
     in sync for sendActiveRoomMessage to read off into body.agentId, and
     drives the composer placeholder while one's selected.

     Default is NO addressee: an unaddressed send just posts, and the room
     stays silent unless the message itself @-tags an agent or Mia (see
     resolveReplyRouting). sendActiveRoomMessage clears selectedAgentId back
     to null right after handing each message to send, so an @-mention only
     addresses that one message, never sticks across sends. */
  function departmentAgentMembers(deptName){
    return chatWs.allAgents.filter(function(a){ return agentDepartments(a).indexOf(deptName) !== -1; });
  }

  // Same addressing concept for a DM room, sourced from the dm_rooms
  // record's stored member list (an agent has no "department" of a DM to
  // belong to — membership is stored on the native conversation record).
  function dmRoomByRoomId(roomId){
    return chatWs.rooms.dms.filter(function(d){ return d.roomId === roomId; })[0] || null;
  }
  function dmAgentMembers(roomId){
    var dm = dmRoomByRoomId(roomId);
    if(!dm) return [];
    var ids = {};
    (dm.members || []).forEach(function(m){ if(m.kind === 'agent') ids[m.agentId] = true; });
    return chatWs.allAgents.filter(function(a){ return ids[a.id]; });
  }

  // A DM's sidebar/header label: its custom name if one was set at creation,
  // otherwise the joined first names of everyone in it besides you — you
  // already know you're in your own DM, seeing your own name in its title
  // would just be noise.
  function firstNameFromEmail(email){
    var local = String(email || '').split('@')[0];
    var first = local.split(/[._-]/)[0] || local;
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : local;
  }
  function dmMemberLabel(m){
    if(m.kind === 'human') return firstNameFromEmail(m.email);
    var agent = chatWs.allAgents.filter(function(a){ return a.id === m.agentId; })[0];
    return agent ? agent.name.split(/\s+/)[0] : 'Agent';
  }
  function dmLabel(dm){
    if(dm.name) return dm.name;
    var others = (dm.members || []).filter(function(m){ return !(m.kind === 'human' && m.email === currentUser); });
    var names = (others.length ? others : (dm.members || [])).map(dmMemberLabel);
    return names.length ? names.join(', ') : 'Direct message';
  }
  function directHumanDmFor(email){
    var target = String(email || '').toLowerCase();
    var me = String(currentUser || '').toLowerCase();
    if(!target) return null;
    return (chatWs.rooms.dms || []).filter(function(dm){
      // A native group is never a private two-person DM, even when it
      // currently has exactly two human members.
      if(dm.kind === 'group') return false;
      var humanMembers = (dm.members || []).filter(function(m){ return m.kind === 'human'; });
      var humanOnly = !(dm.members || []).some(function(m){ return m.kind !== 'human'; });
      if(target === me){
        return humanOnly && humanMembers.length === 1 &&
          String(humanMembers[0].email || '').toLowerCase() === me;
      }
      return humanOnly && humanMembers.length === 2 &&
        humanMembers.some(function(m){ return String(m.email || '').toLowerCase() === target; }) &&
        humanMembers.some(function(m){ return String(m.email || '').toLowerCase() === me; });
    })[0] || null;
  }

  function createNativeDirectConversation(email){
    var members = [
      {kind:'human', email:currentUser},
      {kind:'human', email:email}
    ];
    return api('/api/conversations', {method:'POST', body:{
      type: 'dm',
      name: null,
      metadata: {members: members, source: 'native-ui'}
    }}).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
        throw new Error(res.data && res.data.error || 'Could not create the direct message.');
      }
      var conversation = res.data.conversation;
      return api(nativeConversationPath(conversation.id, '/members'), {method:'POST', body:{
        principalId: email,
        principalType: 'user',
        role: 'member',
        state: 'active'
      }}).then(function(){ return conversation; });
    });
  }

  function createNativeGroupConversation(members, name){
    return api('/api/conversations', {method:'POST', body:{
      type: 'group',
      name: name || null,
      metadata: {members: members, source: 'native-ui'}
    }}).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
        throw new Error(res.data && res.data.error || 'Could not create the group chat.');
      }
      var conversation = res.data.conversation;
      return Promise.all(members.map(function(member){
        var isMia = member.kind === 'agent' && member.agentId === 'gateway';
        return api(nativeConversationPath(conversation.id, '/members'), {method:'POST', body:{
          principalId: member.kind === 'human' ? member.email : member.agentId,
          principalType: member.kind === 'human' ? 'user' : (isMia ? 'agent' : 'bot'),
          role: member.kind === 'human' ? 'member' : (isMia ? 'agent' : 'bot'),
          state: 'active'
        }}).then(function(memberRes){
          if(memberRes.status !== 201 && memberRes.status !== 200){
            throw new Error(memberRes.data && memberRes.data.error || 'Could not add a group member.');
          }
        });
      })).then(function(){ return conversation; });
    });
  }

  function openHumanDirectMessage(email, fromRoster){
    var target = String(email || '').trim().toLowerCase();
    var me = String(currentUser || '').trim().toLowerCase();
    // A local profile is the current person, not a DM recipient. Previously
    // its email-free identity fell through to conversation creation and
    // produced a misleading empty "New conversation" that looked like a new
    // bot. Open the existing profile settings instead.
    if(!target || (me && target === me)){
      chatRoster.open = null;
      renderChatHeaderBar();
      openSettingsDrawer('general');
      return;
    }
    var existing = directHumanDmFor(email);
    if(fromRoster) rememberChatBack('dm', existing && existing.roomId || null);
    else clearChatBack();
    if(existing){
      clearChatActive();
      renderChatSidebar();
      loadChatRoom(existing.roomId, 'dm', dmLabel(existing));
      return;
    }
    createNativeDirectConversation(email).then(function(conversation){
      chatWs.nativeConversations.push(conversation);
      applyNativeConversationList(chatWs.nativeConversations);
      clearChatActive();
      renderChatSidebar();
      loadChatRoom(conversation.id, 'dm', dmLabel(nativeConversationToRoom(conversation)));
    }).catch(function(){
      var nativeThread = el('#chatThread');
      if(nativeThread) nativeThread.innerHTML = '<div class="no-data">Unable to open this direct message right now.</div>';
    });
  }

  function renderDeptAgentSelector(){
    var wrap = el('#chatDeptAgents');
    if(wrap){ wrap.style.display = 'none'; wrap.innerHTML = ''; }
    if(!chatWs.activeRoomId){
      setComposerBoundState(false);
      return;
    }
    if(chatWs.activeKind === 'agent-setup'){
      setComposerBoundState(true);
      var setupInput = el('#ccInput');
      var setupSend = el('#ccSend');
      var acceptsIntent = agentSetup.phase === 'intent';
      if(setupInput){
        setupInput.disabled = !acceptsIntent;
        setupInput.placeholder = acceptsIntent ? 'Tell me what you want this bot to do…' : '';
      }
      if(setupSend) setupSend.disabled = !acceptsIntent;
      syncInlineChatSuggestion();
      return;
    }
    if(chatWs.activeKind === 'department'){
      var state = chatRoomState(chatWs.activeRoomId);
      var members = departmentAgentMembers(chatWs.activeLabel);
      var selected = members.filter(function(a){ return a.id === state.selectedAgentId; })[0] || null;
      if(state.selectedAgentId && !selected) state.selectedAgentId = null; // picked agent left the department since
      updateComposerPlaceholder(selected, chatWs.activeLabel);
      return;
    }
    if(chatWs.activeKind === 'dm' || chatWs.activeKind === 'group'){
      var dmState = chatRoomState(chatWs.activeRoomId);
      var dmMembers = dmAgentMembers(chatWs.activeRoomId);
      var dmSelected = dmMembers.filter(function(a){ return a.id === dmState.selectedAgentId; })[0] || null;
      if(dmState.selectedAgentId && !dmSelected) dmState.selectedAgentId = null; // addressed agent left the DM since
      updateComposerPlaceholder(dmSelected, null);
      return;
    }
    updateComposerPlaceholder(null, null);
  }

  function setComposerBoundState(bound){
    var input = el('#ccInput');
    var send = el('#ccSend');
    var plus = el('#ccPlusBtn');
    var model = el('#ccModelBtn');
    var mic = el('#ccMicBtn');
    var wrap = el('.chat-composer-wrap');
    // Model choice is independent of conversation binding. Keeping this
    // control available also avoids a short first-run room-loading race from
    // making the configured model look permanently unclickable.
    [input, send, plus, mic].forEach(function(control){ if(control) control.disabled = !bound; });
    if(model) model.disabled = false;
    if(input && !bound) input.placeholder = '';
    if(wrap){
      wrap.classList.toggle('chat-composer-unbound', !bound);
      wrap.setAttribute('aria-disabled', bound ? 'false' : 'true');
    }
  }

  function updateComposerPlaceholder(selectedAgent, deptName){
    var input = el('#ccInput');
    if(!input) return;
    setComposerBoundState(true);
    if(STYLED_SKIN){
      // The styled composer uses the inline Tab suggestion as its empty-state
      // prompt, so a second placeholder would compete with it.
      input.placeholder = '';
      return;
    }
    input.placeholder = selectedAgent ? 'Message ' + selectedAgent.name + '…'
      : deptName ? 'Message #' + deptName + '…'
      : 'Ask the OS anything...';
  }

  // One strong inline prompt suggestion replaces the old batch of pills. The
  // suggestion is intentionally stable and easy to accept with Tab, so it
  // reads like a nudge inside the composer rather than another control row.
  var LS_AGENT_SUGGESTIONS = 'miaos.agentSuggestions';
  var CHAT_INLINE_SUGGESTION = 'Can we create a newsletter agent?';
  function agentSuggestionsEnabled(){
    return localStorage.getItem(LS_AGENT_SUGGESTIONS) !== 'off';
  }
  function chatInlineSuggestionText(){
    if(localBrowserState.open) return LOCAL_BROWSER_PROMPTS[localBrowserPromptIndex] || LOCAL_BROWSER_PROMPTS[0];
    var roomId = chatWs.activeRoomId;
    if(miaOnboardingChat && miaOnboardingChat.phase === 'name' && miaOnboardingChat.conversationId === roomId){
      return miaOnboardingChat.suggestedName ? 'Confirm your name, or tell Mia what to call you' : 'Call me…';
    }
    if(!roomId) return 'What should Mia help with first?';
    var state = chatRoomState(roomId);
    var hasMessages = state.messages.some(function(m){ return !m.system && !m.pending; });
    if(!hasMessages){
      if(chatWs.activeKind === 'department') return 'What should Mia help us with in ' + (chatWs.activeLabel || 'this team') + '?';
      if(chatWs.activeKind === 'home') return 'What should Mia help with first?';
      if(chatWs.activeKind === 'agent') return 'What should I ask ' + (chatWs.activeLabel || 'this bot') + '?';
      if(chatWs.activeKind === 'dm' || chatWs.activeKind === 'group') return 'What should we work on together?';
    }
    return CHAT_INLINE_SUGGESTION;
  }
  function updateChatSuggestions(roomId){
    renderChatSuggestions();
  }

  var miaOnboardingChat = null;
  var miaOnboardingSending = false;
  var newsOnboardingDraft = {topics:[], custom:'', schedule:'daily', time:'09:00', day:'Monday', utcOffsetMinutes:new Date().getTimezoneOffset()};

  function newsTimeZoneLabel(offset){
    var minutes = Math.abs(offset);
    return 'UTC' + (offset <= 0 ? '+' : '−') + String(Math.floor(minutes / 60)).padStart(2,'0') + ':' + String(minutes % 60).padStart(2,'0');
  }

  function sendMiaOnboardingAction(body, endpoint){
    if(miaOnboardingSending) return Promise.resolve();
    miaOnboardingSending = true;
    return api(endpoint || '/api/onboarding/chat', {method:'POST', body:body}).then(function(res){
      if(res.status !== 200 || !res.data || res.data.error) throw new Error(res.data && res.data.error || 'Could not save your briefing.');
      miaOnboardingChat = res.data;
      return loadChatRoom(res.data.conversationId, 'agent', 'Mia');
    }).catch(function(error){ showToast(error.message); }).finally(function(){ miaOnboardingSending = false; renderChatThread(); });
  }

  function newsOnboardingFormHtml(){
    var disabled = miaOnboardingSending ? ' disabled' : '';
    if(miaOnboardingChat.phase === 'topics'){
      return '<form class="mia-news-form" id="miaNewsTopics"><div class="mia-news-topics">' + ['Technology & AI','Business & finance','Science & health','Arts & culture'].map(function(topic){
        return '<label><input type="checkbox" name="topic" value="' + esc(topic) + '"' + (newsOnboardingDraft.topics.indexOf(topic) !== -1 ? ' checked' : '') + '><span>' + esc(topic) + '</span></label>';
      }).join('') + '</div><label class="cip-field"><span class="cip-field-label">Or add your own topic</span><input name="custom" maxlength="120" placeholder="For example, architecture in Mexico" value="' + esc(newsOnboardingDraft.custom) + '"></label><button class="styled-btn-primary" type="submit"' + disabled + '>Continue</button></form>';
    }
    var options = '';
    for(var offset = 720; offset >= -840; offset -= 15) options += '<option value="' + offset + '"' + (offset === newsOnboardingDraft.utcOffsetMinutes ? ' selected' : '') + '>' + newsTimeZoneLabel(offset) + '</option>';
    return '<form class="mia-news-form" id="miaNewsSchedule"><label class="cip-field"><span class="cip-field-label">Schedule</span><select name="schedule">' + [['daily','Every morning'],['weekdays','Weekdays'],['weekly','Weekly — choose a day']].map(function(item){ return '<option value="' + item[0] + '"' + (item[0] === newsOnboardingDraft.schedule ? ' selected' : '') + '>' + item[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="cip-field" data-news-weekday' + (newsOnboardingDraft.schedule !== 'weekly' ? ' hidden' : '') + '><span class="cip-field-label">Day</span><select name="day">' + ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(function(day){return '<option' + (day === newsOnboardingDraft.day ? ' selected' : '') + '>' + day + '</option>';}).join('') + '</select></label>' +
      '<div class="mia-news-schedule-row"><label class="cip-field"><span class="cip-field-label">Time</span><input name="time" type="time" required value="' + esc(newsOnboardingDraft.time) + '"></label><label class="cip-field"><span class="cip-field-label">Time zone</span><select name="utcOffsetMinutes">' + options + '</select></label></div><p class="mia-news-hint">Uses this fixed UTC offset. Mia needs to be running and online to deliver your briefing.</p><button class="styled-btn-primary" type="submit"' + disabled + '>' + (miaOnboardingSending ? 'Creating…' : 'Create my news briefing') + '</button></form>';
  }

  function wireNewsOnboarding(root){
    var topics = el('#miaNewsTopics', root), schedule = el('#miaNewsSchedule', root);
    if(topics){
      topics.addEventListener('input', function(){ newsOnboardingDraft.topics = Array.from(topics.querySelectorAll('input[name="topic"]:checked')).map(function(input){return input.value;}); newsOnboardingDraft.custom = topics.elements.custom.value; });
      topics.addEventListener('submit', function(event){ event.preventDefault(); sendMiaOnboardingAction({action:'topics', topics:newsOnboardingDraft.topics.concat(newsOnboardingDraft.custom.trim() ? [newsOnboardingDraft.custom.trim()] : [])}); });
    }
    if(schedule){
      schedule.addEventListener('input', function(){ ['schedule','time','day'].forEach(function(key){newsOnboardingDraft[key] = schedule.elements[key].value;}); newsOnboardingDraft.utcOffsetMinutes = Number(schedule.elements.utcOffsetMinutes.value); schedule.querySelector('[data-news-weekday]').hidden = newsOnboardingDraft.schedule !== 'weekly'; });
      schedule.addEventListener('submit', function(event){ event.preventDefault(); var request = sendMiaOnboardingAction(Object.assign({}, newsOnboardingDraft, {modelSelection:chatModelSelectionMetadata()}), '/api/onboarding/news'); renderChatThread(); return request; });
    }
  }
  function startMiaOnboardingChat(){
    return api('/api/onboarding/chat', {method:'POST', body:{}}).then(function(res){
      if(res.status !== 200 || !res.data) throw new Error(res.data && res.data.error || 'Could not start onboarding.');
      miaOnboardingChat = res.data;
      if(['name','topics','schedule','news-created'].indexOf(res.data.phase) !== -1){
        loadChatRoom(res.data.conversationId, 'agent', 'Mia');
      } else if(chatWs.activeRoomId === res.data.conversationId){
        renderChatThread();
      }
    }).catch(function(error){ showToast(error.message); });
  }

  function sendMiaOnboardingAnswer(text){
    if(miaOnboardingSending) return Promise.resolve({status:409});
    miaOnboardingSending = true;
    var roomId = miaOnboardingChat.conversationId;
    return api('/api/onboarding/chat', {method:'POST', body:{text:text}}).then(function(res){
      if(res.status !== 200 || !res.data) throw new Error(res.data && res.data.error || 'Could not save your answer.');
      miaOnboardingChat = res.data;
      if(!res.data.handled) return sendNativeConversationEvent(text, null, null, roomId);
      return api('/api/me').then(function(profile){
        if(profile.status === 200){
          mergeUserProfile(profile.data.email || currentUser, profile.data);
          renderSettingsAccount();
          if(el('#chatAcctName')) el('#chatAcctName').textContent = displayNameForEmail(currentUser);
        }
        if(chatWs.activeRoomId === roomId) loadChatRoom(roomId, 'agent', 'Mia');
        return res;
      });
    }).catch(function(error){
      showToast(error.message);
      var input = el('#ccInput');
      if(input && !input.value) input.value = text;
      return {status:0};
    }).finally(function(){ miaOnboardingSending = false; renderChatThread(); });
  }

  function miaOnboardingChoicesHtml(message, state){
    if(!miaOnboardingChat || chatWs.activeRoomId !== miaOnboardingChat.conversationId) return '';
    var prompts = state.messages.filter(function(item){
      var event = item.nativeEvent;
      return event && event.senderType === 'agent' && event.metadata && event.metadata.onboarding && !item.deleted;
    });
    var latest = prompts[prompts.length - 1];
    if(!latest || latest.id !== message.id) return '';
    var hasLaterTask = state.messages.slice(state.messages.indexOf(latest) + 1).some(function(item){
      return !item.system && !(item.nativeEvent && item.nativeEvent.metadata && item.nativeEvent.metadata.onboarding);
    });
    if(hasLaterTask) return '';
    if(['topics','schedule'].indexOf(miaOnboardingChat.phase) !== -1) return newsOnboardingFormHtml() + '<div class="mia-news-actions">' + (miaOnboardingChat.phase === 'schedule' ? '<button class="mia-news-skip" data-mia-onboarding-choice="Change topics">Change topics</button>' : '') + '<button class="mia-news-skip" data-mia-onboarding-choice="Skip news briefing">Skip for now</button></div>';
    var choices = miaOnboardingChat.phase === 'name'
      ? (miaOnboardingChat.suggestedName ? ['Yes', 'Use another name', 'Skip for now'] : ['Skip for now'])
      : miaOnboardingChat.phase === 'news-created' ? ['Show my briefing'] : ['Work on an idea', 'Help with a task', 'Show me around'].concat(miaOnboardingChat.newsBotId ? [] : ['Set up my news briefing']);
    return '<div class="agent-setup-actions mia-onboarding-actions">' + choices.map(function(label){
      return '<button type="button" class="agent-setup-later" data-mia-onboarding-choice="' + esc(label) + '"' +
        (miaOnboardingSending ? ' disabled' : '') + '>' + esc(label) + '</button>';
    }).join('') + '</div>';
  }

  function renderChatSuggestions(){
    var wrap = el('#chatChips');
    if(wrap) wrap.innerHTML = '';
    syncInlineChatSuggestion();
  }

  function syncInlineChatSuggestion(){
    var suggestion = el('#ccInlineSuggestion');
    var input = el('#ccInput');
    if(!suggestion || !input) return;
    var mentionOpen = typeof chatMention !== 'undefined' && chatMention.open;
    var show = chatWs.activeKind !== 'agent-setup' && agentSuggestionsEnabled() && !!chatWs.activeRoomId && chatWs.configured !== false && !mentionOpen && !input.value.trim();
    var text = suggestion.querySelector('span');
    if(text) text.textContent = chatInlineSuggestionText();
    suggestion.hidden = !show;
    suggestion.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  // Detailed output includes additional execution progress; concise output
  // keeps only the final reply. The setting is shared across sessions.
  (function(){
    var select = el('#settingsOutputMode');
    if(!select) return;
    select.addEventListener('change', function(){
      var desired = select.value === 'verbose' ? 'verbose' : 'concise';
      var previous = desired === 'verbose' ? 'concise' : 'verbose';
      renderOutputSetting(desired);
      api('/api/settings/output', {method:'POST', body:{output: desired}}).then(function(result){
        if(result.status < 200 || result.status >= 300) throw new Error('output update failed');
        renderOutputSetting(result.data && result.data.chatOutput === 'verbose' ? 'verbose' : 'concise');
      }).catch(function(){
        renderOutputSetting(previous);
        showBenchToast('Output setting could not be applied');
      });
    });
  })();

  // Inline prompt suggestion setting: purely local, no server round trip —
  // same localStorage on/off pattern as the inter-agent-messages toggle.
  // Placed here (after agentSuggestionsEnabled/updateChatSuggestions exist)
  // rather than alongside the other settings-drawer wiring above, since this
  // module executes top-to-bottom and chatWs isn't initialized that early.
  (function(){
    var toggle = el('#settingsAgentSuggestions');
    if(!toggle) return;
    toggle.checked = agentSuggestionsEnabled();
    toggle.addEventListener('change', function(){
      localStorage.setItem(LS_AGENT_SUGGESTIONS, toggle.checked ? 'on' : 'off');
      if(toggle.checked){
        if(chatWs.activeRoomId) updateChatSuggestions(chatWs.activeRoomId);
      } else {
        renderChatSuggestions(); // clears #chatChips immediately, per agentSuggestionsEnabled() check
      }
    });
  })();

  /* Mobile (<=760px): chat becomes a two-screen flow -- the sidebar is the
     "Chats" list, opening a room shows the conversation full-screen, and the
     header grows a back chevron that returns to the list. body.chat-room-open
     is the single switch CSS keys on; syncMobileChatView keeps it true
     exactly while a room is active (harmless no-op on desktop widths). */
  var mobileChatMq = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
  function isMobileChat(){ return !!(mobileChatMq && mobileChatMq.matches); }
  function syncMobileChatView(){
    document.body.classList.toggle('chat-room-open', !!chatWs.activeRoomId);
  }
  function closeMobileChatRoom(){
    closeMentionPopover();
    chatRoster.open = null;
    closeNativeChatSocket();
    chatWs.activeRoomId = null;
    chatWs.activeKind = null;
    chatWs.activeLabel = '';
    saveActiveChatLocation(null);
    renderChatSidebar();
    refreshChatMain();
  }
  function refreshChatMain(){
    syncMobileChatView();
    renderChatHeaderBar();
    renderChatThread();
    renderDeptAgentSelector();
    renderChatSuggestions();
    renderComposerTaskControl();
  }

  function stopChatThinking(roomId){
    var state = chatRoomState(roomId);
    if(state.thinkingTimer){ clearTimeout(state.thinkingTimer); state.thinkingTimer = null; }
    state.thinking = false;
    state.thinkingSince = null;
    state.thinkingAgentName = null;
    if(chatWs.activeRoomId === roomId){ renderChatHeaderBar(); renderChatThread(); }
    if(chatInfo.open && (chatInfo.mode === 'agents' || chatInfo.mode === 'automations')) renderChatInfoPane();
  }
  function startChatThinking(roomId){
    var state = chatRoomState(roomId);
    state.thinking = true;
    state.thinkingSince = Date.now();
    if(chatWs.activeRoomId === roomId){ renderChatHeaderBar(); renderChatThread(); }
    if(chatInfo.mode === 'agents' && chatInfo.open) renderChatInfoPane();
    if(state.thinkingTimer) clearTimeout(state.thinkingTimer);
    state.thinkingTimer = null;
    startChatThinkingTicker();
  }

  /* One global 1s ticker that rewrites the elapsed-seconds text of whatever
     "thinking…" bubble is currently on screen, in place — no re-render, so
     it can never fight the user's scroll position or composer focus. Ticks
     only while the ACTIVE room is thinking; stops itself otherwise. */
  var chatThinkingTicker = null;
  function startChatThinkingTicker(){
    if(chatThinkingTicker) return;
    chatThinkingTicker = setInterval(function(){
      var state = chatWs.activeRoomId && chatWs.byRoom[chatWs.activeRoomId];
      if(!state || !state.thinking || !state.thinkingSince){
        clearInterval(chatThinkingTicker); chatThinkingTicker = null;
        return;
      }
      // Only the LOCAL bridge bubble gets the rotating canned text. The
      // gateway's status row also carries .chat-msg-thinking for styling,
      // and rewriting it here was clobbering Hermes' own words.
      var node = document.querySelector('.chat-msg-thinking-local');
      if(node){
        var status = node.querySelector('.chat-thinking-shimmer') || node;
        status.textContent = chatThinkingText(state);
      }
    }, 1000);
  }
  function chatThinkingText(state){
    var secs = state.thinkingSince ? Math.max(0, Math.floor((Date.now() - state.thinkingSince) / 1000)) : 0;
    var statuses = ['Thinking through this', 'Checking the context', 'Preparing a response'];
    return statuses[Math.floor(secs / 4) % statuses.length];
  }

  function startChatPolling(){
    if(chatWs.pollTimer) clearInterval(chatWs.pollTimer);
    if(chatWs.attentionTimer) clearInterval(chatWs.attentionTimer);
    chatWs.pollTimer = null;
    chatWs.attentionTimer = null;
    syncDesktopNotificationControl();
  }
  function stopChatPolling(){
    if(chatWs.pollTimer){ clearInterval(chatWs.pollTimer); chatWs.pollTimer = null; }
    if(chatWs.attentionTimer){ clearInterval(chatWs.attentionTimer); chatWs.attentionTimer = null; }
    if(chatWs.native) closeNativeChatSocket();
  }

  function loadOlderChatMessages(roomId){
    var state = roomId && chatWs.byRoom[roomId];
    if(!state || chatWs.activeRoomId !== roomId || state.historyLoading || state.historyComplete || !state.historyCursor) return Promise.resolve();
    var requestedWorkspace = activeWorkspaceKey;
    var requestId = Number(state.historyRequestId || 0) + 1;
    state.historyRequestId = requestId;
    state.historyLoading = true;
    var advancedSuccessfully = false;
    if(chatWs.activeRoomId === roomId) renderChatThread();

    function fetchOlderPage(){
      var cursor = state.historyCursor;
      if(!cursor) return Promise.resolve();
      return api(nativeEventsUrl(roomId, 0, 100, false, cursor)).then(function(res){
        if(state.historyRequestId !== requestId || activeWorkspaceKey !== requestedWorkspace || chatWs.activeRoomId !== roomId) return;
        if(res.status !== 200) throw new Error('older history unavailable');
        var rawEvents = (res.data && res.data.events) || [];
        var incoming = nativeEventsToMessages(rawEvents);
        var known = {};
        (state.messages || []).forEach(function(message){ if(message && message.id) known[message.id] = true; });
        var added = incoming.filter(function(message){ return message && message.id && !known[message.id]; });
        state.messages = normalizeChatMessages(added.concat(state.messages || []));
        var nextCursor = res.data && res.data.nextBeforeSequence || null;
        state.historyCursor = nextCursor && Number(nextCursor) < Number(cursor) ? nextCursor : null;
        state.historyComplete = !state.historyCursor;
        advancedSuccessfully = true;
        // Sanitized tool-only pages may add no visible transcript row. Keep
        // advancing the raw sequence cursor until a visible page or EOF so
        // those rows never become an artificial history boundary.
        var addedVisible = added.some(function(message){
          return message.system || isHumanSender(message.sender) || displayBotBody(message.body) || chatMessageHasAttachments(message);
        });
        if(!addedVisible && state.historyCursor) return fetchOlderPage();
      });
    }

    return fetchOlderPage().catch(function(){
      // Retain the cursor so a later upward scroll can retry safely.
      advancedSuccessfully = false;
    }).then(function(){
      if(state.historyRequestId !== requestId || activeWorkspaceKey !== requestedWorkspace || chatWs.activeRoomId !== roomId) return;
      state.historyLoading = false;
      if(chatWs.activeRoomId === roomId){
        renderChatThread();
        var thread = el('#chatThread');
        if(advancedSuccessfully && thread && thread.scrollTop <= 64 && state.historyCursor) setTimeout(function(){ loadOlderChatMessages(roomId); }, 0);
      }
    });
  }

  (function(){
    var thread = el('#chatThread');
    if(!thread) return;
    thread.addEventListener('scroll', function(){
      var roomId = thread.getAttribute('data-chat-scroll-room');
      var state = roomId && chatWs.byRoom[roomId];
      var movedSinceRestore = state && Math.abs(Number(thread.scrollTop || 0) - Number(state.chatScrollTop || 0)) > 0.5;
      if(state && window.MiaChatScroll) window.MiaChatScroll.capture(thread, state, {invalidatePending:movedSinceRestore});
      syncChatJumpLatest(thread, state);
      if(thread.scrollTop <= 64 && chatWs.activeRoomId) loadOlderChatMessages(chatWs.activeRoomId);
    }, {passive:true});
    var jump = el('#chatJumpLatest');
    if(jump) jump.addEventListener('click', function(){
      var roomId = thread.getAttribute('data-chat-scroll-room');
      var state = roomId && chatWs.byRoom[roomId];
      if(state && window.MiaChatScroll) window.MiaChatScroll.jumpToLatest(thread, state);
      syncChatJumpLatest(thread, state);
    });
  })();

  /* Switching rooms loads the durable native event history before opening the
     realtime subscription. */
  function loadChatRoom(roomId, kind, label){
    setLocalChatTypingActivity(false);
    closeMentionPopover();
    chatRoster.open = null;
    clearChatAttention(roomId);
    if(chatWs.native && chatWs.nativeSocketConversationId !== roomId) closeNativeChatSocket();
    chatWs.activeRoomId = roomId;
    chatWs.activeKind = kind;
    chatWs.activeLabel = label;
    if(roomId !== AGENT_SETUP_ROOM_ID) saveActiveChatLocation(roomId);
    renderChatSidebar();
    refreshChatMain();
    if(chatWs.configured === false) return;
    loadMentionRoster(roomId); // also feeds the header's roster chips
    loadActiveNativeDispatches(roomId);
    var state = chatRoomState(roomId);
    var localWelcome = state.localWelcome;
    state.historyRequestId = Number(state.historyRequestId || 0) + 1;
    var roomRequestId = state.historyRequestId;
    var requestedWorkspace = activeWorkspaceKey;
    state.historyLoading = false;
    var hadInitializedHistory = state.historyInitialized;
    return api(nativeEventsUrl(roomId, 0, 100, true)).then(function(res){
      if(state.historyRequestId !== roomRequestId || activeWorkspaceKey !== requestedWorkspace || chatWs.activeRoomId !== roomId) return;
      if(res.status !== 200) return;
      var rawEvents = (res.data && res.data.events) || [];
      var messages = nativeEventsToMessages(rawEvents);
      var stillPending = state.messages.filter(function(message){ return message.pending; });
      var cachedMessageIds = {};
      state.messages.forEach(function(message){ if(message && message.id) cachedMessageIds[message.id] = true; });
      var latestOverlapsCache = messages.some(function(message){ return message && message.id && cachedMessageIds[message.id]; });
      if(messages.length) state.localWelcome = null;
      var existingDurable = hadInitializedHistory ? state.messages.filter(function(message){ return !message.pending && message !== localWelcome; }) : [];
      var merged = messages.concat(existingDurable, stillPending, messages.length || !localWelcome ? [] : [localWelcome]);
      var seenMessages = {};
      state.messages = normalizeChatMessages(merged.filter(function(message){
        if(!message || !message.id || seenMessages[message.id]) return false;
        seenMessages[message.id] = true;
        return true;
      }).sort(function(left, right){
        var leftSequence = Number(left && left.nativeEvent && left.nativeEvent.sequence || Number.MAX_SAFE_INTEGER);
        var rightSequence = Number(right && right.nativeEvent && right.nativeEvent.sequence || Number.MAX_SAFE_INTEGER);
        return leftSequence - rightSequence || Number(left.ts || 0) - Number(right.ts || 0);
      }));
      state.lastSequence = rawEvents.reduce(function(sequence, event){ return Math.max(sequence, Number(event.sequence || 0)); }, Number(state.lastSequence || 0));
      state.lastTs = rawEvents.reduce(function(timestamp, event){
        return Math.max(timestamp, Date.parse(event.createdAt) || 0);
      }, Number(state.lastTs || 0));
      if(!hadInitializedHistory){
        state.historyCursor = res.data && res.data.nextBeforeSequence || null;
        state.historyComplete = !state.historyCursor;
      } else if(!latestOverlapsCache && res.data && res.data.nextBeforeSequence){
        // More than one latest-page window may have arrived while this room
        // was inactive. Restart backward paging at the newest page boundary;
        // dedupe reconnects it to the retained cache without leaving a gap.
        state.historyCursor = res.data.nextBeforeSequence;
        state.historyComplete = false;
      }
      state.historyInitialized = true;
      state.sidebarPreviewLoaded = true;
      connectNativeChatSocket(roomId);
      renderChatSidebar();
      if(chatWs.activeRoomId === roomId) renderChatThread();
    }).catch(function(){});
  }

  function selectHomeRoom(){
    if(!chatWs.rooms.home) return;
    loadChatRoom(chatWs.rooms.home.roomId, 'home', chatWs.rooms.home.name || 'Multiplayer Test');
  }

  function selectAgentRoom(agent){
    if(agent.roomId || agent.nativeConversationId){
      return loadChatRoom(agent.roomId || agent.nativeConversationId, 'agent', agent.name);
    }
    if(chatWs.configured === false) return;
    var isMia = agent.id === 'gateway';
    return api('/api/conversations', {method:'POST', body:{
      type: isMia ? 'agent' : 'bot',
      name: agent.name,
      metadata: isMia
        ? {agentId: 'gateway', source: 'native-ui'}
        : {botId: agent.id, source: 'native-ui'}
    }}).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation) return;
      chatWs.nativeConversations.push(res.data.conversation);
      applyNativeConversationList(chatWs.nativeConversations);
      renderChatSidebar();
      loadChatRoom(res.data.conversation.id, 'agent', agent.name);
    }).catch(function(){});
  }

  function selectDepartmentRoom(dept, displayName){
    var name = dept.department;
    var label = displayName || name;
    if(dept.roomId){
      loadChatRoom(dept.roomId, 'department', label);
      return Promise.resolve(dept.nativeConversation || dept);
    }
    if(chatWs.configured === false) return Promise.reject(new Error('Chat is offline'));
    return api('/api/conversations', {method:'POST', body:{
      type: 'channel',
      name: name,
      metadata: {department: name, source: 'native-ui'}
    }}).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
        throw new Error(res.data && (res.data.message || res.data.error) || 'Channel creation failed');
      }
      chatWs.nativeConversations.push(res.data.conversation);
      applyNativeConversationList(chatWs.nativeConversations);
      renderChatSidebar();
      loadChatRoom(res.data.conversation.id, 'department', label);
      return res.data.conversation;
    });
  }

  function nativeThinkingAgentName(roomId, text, threadRootId){
    var body = String(text || '').toLowerCase();
    var state = chatRoomState(roomId);
    var rosterAgents = state.mentionRoster && !state.mentionRoster.loading
      ? (state.mentionRoster.agents || []).concat(state.mentionRoster.privateAgents || []) : [];
    var hasPrivateMia = chatWs.activeKind === 'agent' || rosterAgents.some(function(agent){ return agent && agent.id === 'gateway'; });
    if(/(^|\s)@mia\b/.test(body) && hasPrivateMia) return 'Mia';
    if(/@all_bots\b|@all\b/.test(body)) return 'Bots';
    if(chatWs.activeKind === 'agent') return chatWs.activeLabel || 'Agent';
    var mentioned = rosterAgents.filter(function(agent){
      if(!agent || !agent.name) return false;
      var normalized = agent.name.trim().toLowerCase();
      if(!normalized || agent.id === 'gateway') return false;
      var escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9_])@' + escaped + '(?![a-z0-9_-])').test(body);
    });
    if(mentioned.length === 1) return mentioned[0].name;
    if(mentioned.length > 1) return 'Bots';
    if(threadRootId){
      var root = (state.messages || []).filter(function(message){ return message.id === threadRootId; })[0];
      if(root && !isHumanSender(root.sender)) return root.nativeAgentName || chatWs.activeLabel || 'Agent';
    }
    return null;
  }

  // threadRootId, when given, is the thread this send belongs to — set by
  // the thread box's inline reply composer. Everything else about the send
  // (addressing resolution, agent mentions) is identical to a main-timeline
  // send, except that an untagged thread reply implicitly addresses the
  // thread root's author instead of going silent — see the resolution
  // block below.
  function sendNativeConversationEvent(text, threadRootId, preparedAttachment, roomId){
    var state = chatRoomState(roomId);
    var activeDispatchAtSend = activeRoomTask();
    var thinkingAgentName = nativeThinkingAgentName(roomId, text, threadRootId);
    state.thinkingAgentName = thinkingAgentName;
    var clientIdempotencyKey = 'native-ui-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var content = {text: String(text || '')};
    if(preparedAttachment && preparedAttachment.attachment){
      content.attachments = [preparedAttachment.attachment];
    }
    var pendingId = 'pending-' + Date.now();
    var pendingMsg = {
      id: pendingId,
      sender: chatSenderLabel(),
      body: String(text || ''),
      ts: Date.now(),
      pending: true,
      clientIdempotencyKey: clientIdempotencyKey
    };
    if(threadRootId) pendingMsg.threadRoot = threadRootId;
    state.messages.push(pendingMsg);
    // A running dispatch already owns the animated progress row. A steering
    // message stays sendable, but must not create a second thinking bubble.
    if(thinkingAgentName && !activeDispatchAtSend) startChatThinking(roomId);
    renderChatSidebar();
    if(chatWs.activeRoomId === roomId) renderChatThread();
    var chatModelMetadata = chatModelSelectionMetadata();
    return api(nativeConversationPath(roomId, '/events'), {method:'POST', body:{
      type: preparedAttachment ? 'image' : 'message',
      content: content,
      parentEventId: threadRootId || null,
      clientIdempotencyKey: clientIdempotencyKey,
      ...(chatModelMetadata ? {metadata: {chatModelSelection: chatModelMetadata}} : {})
    }}).then(function(res){
      if(res.status !== 201 && res.status !== 200){
        stopChatThinking(roomId);
        state.messages = state.messages.filter(function(message){ return message.id !== pendingId; });
        renderChatSidebar();
        if(chatWs.activeRoomId === roomId) renderChatThread();
        return res;
      }
      if(res.data && res.data.event) applyNativeEvent(res.data.event);
      else state.messages = state.messages.filter(function(message){ return message.id !== pendingId; });
      if(!activeDispatchAtSend && res.data && res.data.dispatch && Array.isArray(res.data.dispatch.dispatches)){
        setRoomNativeDispatches(roomId, res.data.dispatch.dispatches);
        renderComposerTaskControl();
      }
      renderChatSidebar();
      if(chatWs.activeRoomId === roomId) renderChatThread();
      return res;
    }).catch(function(err){
      stopChatThinking(roomId);
      state.messages = state.messages.filter(function(message){ return message.id !== pendingId; });
      renderChatSidebar();
      if(chatWs.activeRoomId === roomId) renderChatThread();
      return {status: 0, data: {error: err && err.message || 'Message send failed.'}};
    });
  }

  function sendActiveRoomMessage(text, threadRootId, preparedAttachment, boundRoomId){
    if((!text && !preparedAttachment) || !(boundRoomId || chatWs.activeRoomId)) return;
    if(chatWs.activeKind === 'agent-setup'){
      submitAgentSetupIntent(text);
      return;
    }
    if(chatWs.configured === false) return;
    var explicitNameReply = /^(?:please )?(?:call me|my name is|i['’]d like(?: you to call me)?|i prefer)\s+/i.test(text);
    if(!threadRootId && !preparedAttachment && miaOnboardingChat && (miaOnboardingChat.phase === 'name' || explicitNameReply)
      && (boundRoomId || chatWs.activeRoomId) === miaOnboardingChat.conversationId){
      return sendMiaOnboardingAnswer(text);
    }
    // Bot setup is a native Mia workflow, not an open-ended Hermes task.
    // Route ordinary creation language into the existing review/confirmation
    // chat before persisting a message or starting a model dispatch. This keeps
    // a simple product action from turning into terminal/tool discovery.
    if(!threadRootId && !preparedAttachment && chatWs.activeKind === 'agent'
      && isMiaOrchestrator(chatWs.activeLabel, 'gateway') && isBotCreationIntent(text)){
      startAgentSetupChat();
      submitAgentSetupIntent(text);
      return Promise.resolve({status: 200, data: {botSetup: true}});
    }
    return sendNativeConversationEvent(text, threadRootId, preparedAttachment, boundRoomId || chatWs.activeRoomId);
  }

  function isBotCreationIntent(value){
    var text = String(value || '').trim();
    if(!text) return false;
    return /\b(?:create|build|make|add|set\s*up)\s+(?:(?:me|us)\s+)?(?:(?:a|an|new)\s+)?bot\b/i.test(text)
      || /\bget\s+(?:(?:me|us)\s+)?(?:a|an|new)\s+bot\b/i.test(text)
      || /\b(?:i\s+(?:want|need)|we\s+(?:want|need))\s+(?:a|an|new)\s+bot\b/i.test(text);
  }


  /* ============ CHAT: @-mention popover ============
     Typing "@" in the composer opens a roster popover: room members first
     ("IN THIS CHAT" — humans confirmed joined in the conversation, agents that are
     current department/agent-room members), then everyone else ("NOT IN
     CHAT"), filterable by whatever's typed after "@". Selecting an entry
     inserts "@Name " into the composer (and, for an agent in a department
     room, also sets the To: selector — that's who the reply job addresses).
     Selecting a NOT IN CHAT entry swaps the popover to an inline Add/Cancel
     confirm instead of acting immediately, since it's a real side effect
     (an invite, or a department membership change), not just a text
     insertion. Roster is cached per room on chatRoomState() alongside
     messages/thinking state — a realtime outage after the initial load just
     means a stale roster, not a broken popover. Positioned the same way as
     .bench-dept-dropdown-panel: fixed off the input's own rect so it
     escapes the composer card's rounded-corner clipping instead of being
     laid out in flow. */
  var chatMention = {open: false, atPos: -1, query: '', matches: [], highlight: 0, confirmEntry: null, confirmBusy: false, groupSend: null};

  function humanDirectoryMatches(user, query){
    var q = String(query || '').trim().toLowerCase();
    if(!q) return true;
    var email = String(user && user.email || '').trim().toLowerCase();
    var localpart = email.split('@')[0];
    var name = String(user && (user.displayName || user.name) || displayNameForEmail(email) || '').toLowerCase();
    return name.indexOf(q) !== -1 || (q.indexOf('@') !== -1 ? email.indexOf(q) !== -1 : localpart.indexOf(q) !== -1);
  }

  function loadMentionRoster(roomId){
    var state = chatRoomState(roomId);
    if(state.mentionRoster || chatWs.configured === false) return;
    var requestedWorkspaceKey = activeWorkspaceKey;
    state.mentionRoster = {humans: [], agents: [], privateAgents: [], notInChatAgents: [], loading: true};
    Promise.all([
      api(nativeConversationPath(roomId, '/members')),
      loadHumanDirectoryResponse(),
      api('/api/bots'),
      api('/api/agents')
    ]).then(function(results){
      if(activeWorkspaceKey !== requestedWorkspaceKey){
        clearSoloHumanDirectoryState();
        return;
      }
      var membersRes = results[0], usersRes = results[1], agentsRes = results[2], privateAgentsRes = results[3];
      if(membersRes.status !== 200){ state.mentionRoster = null; return; }
      var members = (membersRes.data && membersRes.data.members) || [];
      var activeHumansByEmail = {};
      var humans = members.filter(function(member){ return member.principalType === 'user'; }).map(function(member){
        var email = member.principalId;
        activeHumansByEmail[String(email).toLowerCase()] = true;
        return {email: email, name: (member.metadata && member.metadata.name) || email, inChat: true, membership: member.state || 'active'};
      });
      var directoryHumans = usersRes.status === 200 && usersRes.data ? (usersRes.data.users || []) : [];
      directoryHumans.forEach(function(user){
        var email = String(user.email || '').trim();
        if(!email || activeHumansByEmail[email.toLowerCase()]) return;
        humans.push(Object.assign({}, user, {inChat: false, membership: 'none'}));
      });
      var activeAgentsById = {};
      var agents = members.filter(function(member){ return member.principalType === 'agent' || member.principalType === 'bot'; }).map(function(member){
        activeAgentsById[member.principalId] = true;
        return {id: member.principalId, name: (member.metadata && member.metadata.name) || member.principalId,
          principalType: member.principalType, inChat: true};
      });
      var directoryAgents = agentsRes.status === 200 && agentsRes.data ? (agentsRes.data.bots || []) : [];
      var notInChatAgents = directoryAgents.filter(function(agent){
        return agent && agent.id && agent.id !== 'gateway' && !activeAgentsById[agent.id];
      }).map(function(agent){
        return {id: agent.id, name: agent.name || agent.id, department: agent.department, inChat: false};
      });
      var privateAgents = privateAgentsRes.status === 200 && privateAgentsRes.data
        ? (privateAgentsRes.data.agents || []).filter(function(agent){ return agent && agent.id && agent.private === true; }).map(function(agent){
            return {id: agent.id, name: agent.name || agent.id, conversationId: agent.conversationId, inChat: true, privateAgent: true};
          })
        : [];
      humans.forEach(function(human){ mergeUserProfile(human.email, human); });
      state.mentionRoster = {humans: humans, agents: agents, privateAgents: privateAgents, notInChatAgents: notInChatAgents, loading: false};
      if(chatMention.open && chatWs.activeRoomId === roomId) renderMentionPopover();
      if(chatWs.activeRoomId === roomId){ renderChatHeaderBar(); renderChatThread(); }
      var isSidebarChannel = (chatWs.rooms.home && chatWs.rooms.home.roomId === roomId) ||
        chatWs.rooms.departments.some(function(d){ return d.roomId === roomId; });
      if(isSidebarChannel) renderChatSidebar();
    }).catch(function(){ state.mentionRoster = null; });
  }

  // #17 calls this after an invite/add-to-department succeeds so the next
  // "@" popover reflects the change instead of the stale membership snapshot.
  function invalidateMentionRoster(roomId){
    if(roomId) chatRoomState(roomId).mentionRoster = null;
  }

  // Finds an unclosed "@query" token ending at the caret — "unclosed" meaning
  // preceded by start-of-string or whitespace and containing no whitespace
  // of its own, so "email@x.com" or "a @ b" don't trigger the popover.
  function mentionTriggerAt(input){
    var caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    var before = input.value.slice(0, caret);
    var match = /(^|\s)@([^\s@]*)$/.exec(before);
    if(!match) return null;
    return {atPos: caret - match[2].length - 1, query: match[2]};
  }

  function mentionEntryList(){
    var roomId = chatWs.activeRoomId;
    if(!roomId) return {privateAgents: [], inChat: [], notInChat: []};
    var roster = chatRoomState(roomId).mentionRoster;
    if(!roster || roster.loading) return {privateAgents: [], inChat: [], notInChat: []};
    var q = chatMention.query.toLowerCase();
    function human(u){ return {kind: 'human', key: 'human:' + u.email, label: u.email, searchUser: u, inChat: u.inChat}; }
    function agent(a, inChat){ return {kind: 'agent', key: 'agent:' + a.id, label: a.name, id: a.id, department: a.department, inChat: inChat, privateAgent: a.privateAgent === true}; }
    // Group tags: '@all' = everyone, '@all_users' = humans, '@all_bots' =
    // agents. Inserted as the literal tag, never expanded into individual
    // mentions — the server resolves who they cover per room scope.
    function group(name){ return {kind: 'group', key: 'group:' + name, label: name, inChat: true}; }
    var entries = {
      privateAgents: (roster.privateAgents || []).map(function(a){ return agent(a, true); }),
      inChat: [group('all'), group('all_users'), group('all_bots')]
        .concat(roster.humans.filter(function(u){ return u.inChat; }).map(human))
        .concat(roster.agents.map(function(a){ return agent(a, true); })),
      notInChat: roster.humans.filter(function(u){ return !u.inChat; }).map(human)
        .concat(roster.notInChatAgents.map(function(a){ return agent(a, false); }))
    };
    function matches(entry){
      if(!q) return true;
      if(entry.kind === 'human') return humanDirectoryMatches(entry.searchUser, q);
      return entry.label.toLowerCase().indexOf(q) !== -1;
    }
    // Prefix matches outrank substring matches (stable sort keeps the rest
    // in roster order): "@mia" must highlight Mia, not teammate@EXAMPLE.com —
    // Enter on the auto-highlighted first entry is the common path, and a
    // substring hit on an email there sent the message to a human instead.
    function rank(list){
      if(!q) return list;
      return list.filter(matches).sort(function(a, b){
        var ap = a.label.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bp = b.label.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return ap - bp;
      });
    }
    return {privateAgents: rank(entries.privateAgents), inChat: rank(entries.inChat), notInChat: rank(entries.notInChat)};
  }

  function positionMentionPopover(){
    var input = el('#ccInput');
    var pop = el('#chatMentionPopover');
    if(!input || !pop) return;
    var r = input.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    pop.style.top = 'auto';
  }

  function renderMentionPopover(){
    var pop = el('#chatMentionPopover');
    if(!pop || !chatMention.open) return;
    if(chatMention.confirmEntry) return renderMentionConfirm();
    var lists = mentionEntryList();
    chatMention.matches = lists.privateAgents.concat(lists.inChat, lists.notInChat);
    if(chatMention.highlight >= chatMention.matches.length) chatMention.highlight = 0;
    var ix = 0;
    function optionHtml(entry){
      var i = ix++;
      var avatar = entry.kind === 'group' ? '@' : entry.kind === 'human' ? humanAvatarInitialsHtml(entry.label) : agentAvatarHtml(entry.label, entry.id, 22);
      var sub = entry.kind === 'agent' && !entry.inChat ? '<span class="cmp-option-sub">add</span>' : '';
      var kind = entry.kind === 'agent' ? '<span class="cmp-option-kind">' + (entry.id === 'gateway' ? 'Agent' : 'Bot') + '</span>' : '';
      var highlighted = i === chatMention.highlight ? ' highlighted' : '';
      return '<button type="button" class="cmp-option' + highlighted + '" data-mention-ix="' + i + '"><span class="dm-avatar">' + avatar + '</span><span class="cmp-option-label">' + esc(entry.label) + '</span>' + kind + sub + '</button>';
    }
    var html = '<div class="cmp-section-label">YOUR AGENT</div>';
    html += lists.privateAgents.length ? lists.privateAgents.map(optionHtml).join('') : '<div class="cmp-empty">no matches</div>';
    html += '<div class="cmp-section-label">IN THIS CHAT</div>';
    html += lists.inChat.length ? lists.inChat.map(optionHtml).join('') : '<div class="cmp-empty">no matches</div>';
    html += '<div class="cmp-section-label">NOT IN CHAT</div>';
    html += lists.notInChat.length ? lists.notInChat.map(optionHtml).join('') : '<div class="cmp-empty">no matches</div>';
    pop.innerHTML = html;
    els('.cmp-option', pop).forEach(function(btn){
      // mousedown (not click) + preventDefault so the composer input never
      // loses focus/selection to the popover click, matching how the dept
      // dropdown avoids stealing focus from its trigger button.
      btn.addEventListener('mousedown', function(e){
        e.preventDefault();
        selectMentionEntry(chatMention.matches[parseInt(btn.getAttribute('data-mention-ix'), 10)]);
      });
    });
  }

  // NOT IN CHAT entries need a real side effect (invite a human, or add an
  // agent to the current department) — the popover swaps to this inline
  // confirm instead of acting on the first click/Enter, per spec. An agent
  // in a non-department room (home or a 1:1 agent room) has no membership
  // concept to add it to, so that combination never reaches here — see the
  // kind==='agent' branch in selectMentionEntry.
  function renderMentionConfirm(){
    var pop = el('#chatMentionPopover');
    var entry = chatMention.confirmEntry;
    var desc = entry.kind === 'agent'
      ? 'Add ' + entry.label + ' to #' + chatWs.activeLabel + '?'
      : 'Invite ' + entry.label + ' to this chat?';
    pop.innerHTML = '<div class="cmp-confirm">' +
      '<div class="cmp-confirm-text">' + esc(desc) + '</div>' +
      '<div class="cmp-confirm-actions">' +
        '<button type="button" class="cmp-confirm-btn cmp-confirm-add" data-mention-confirm="add"' + (chatMention.confirmBusy ? ' disabled' : '') + '>' + (chatMention.confirmBusy ? 'Adding&hellip;' : 'Add') + '</button>' +
        '<button type="button" class="cmp-confirm-btn cmp-confirm-cancel" data-mention-confirm="cancel">Cancel</button>' +
      '</div>' +
    '</div>';
    var addBtn = el('[data-mention-confirm="add"]', pop);
    var cancelBtn = el('[data-mention-confirm="cancel"]', pop);
    if(addBtn) addBtn.addEventListener('mousedown', function(e){ e.preventDefault(); if(!chatMention.confirmBusy) confirmMentionAdd(); });
    if(cancelBtn) cancelBtn.addEventListener('mousedown', function(e){ e.preventDefault(); cancelMentionConfirm(); });
  }

  function cancelMentionConfirm(){
    chatMention.confirmEntry = null;
    chatMention.confirmBusy = false;
    renderMentionPopover();
  }

  function confirmMentionAdd(){
    var entry = chatMention.confirmEntry;
    if(!entry) return;
    var roomId = chatWs.activeRoomId;
    chatMention.confirmBusy = true;
    renderMentionPopover();
    var isMia = entry.kind === 'agent' && entry.id === 'gateway';
    var req = api(nativeConversationPath(roomId, '/members'), {method: 'POST', body: {
      principalId: entry.kind === 'agent' ? entry.id : entry.label,
      principalType: entry.kind === 'agent' ? (isMia ? 'agent' : 'bot') : 'user',
      role: entry.kind === 'agent' ? (isMia ? 'agent' : 'bot') : 'member',
      state: 'active',
      metadata: {name: entry.label, manager: false, departments: []}
    }});
    req.then(function(res){
      chatMention.confirmBusy = false;
      if(res.status !== 200 && res.status !== 201){
        cancelMentionConfirm();
        return;
      }
      invalidateMentionRoster(roomId);
      // ...and refetch right away: the header's member/agent chips render
      // from this same cache, so leaving it empty until the next room
      // switch made a just-added agent invisible in the header.
      loadMentionRoster(roomId);
      // Adding an agent to a department changes chatWs.allAgents (the To:
      // chip row's source, separate from the mention roster fetched above)
      // — refetch it first so the new chip shows up immediately instead of
      // only after the next unrelated loadAgents() call (room switch, etc).
      var refreshed = entry.kind === 'agent' ? loadAgents().then(function(apiAgents){ syncChatBotRecords(apiAgents); }) : Promise.resolve();
      refreshed.then(function(){
        insertMentionText(Object.assign({}, entry, {inChat: true}));
        closeMentionPopover();
        addSystemChatLine(roomId, entry.label + ' was added to this chat.', {kind: entry.kind, id: entry.id || null, label: entry.label});
      });
    }).catch(function(){
      chatMention.confirmBusy = false;
      cancelMentionConfirm();
    });
  }

  function openMentionPopover(trigger){
    chatMention.open = true;
    chatMention.atPos = trigger.atPos;
    chatMention.query = trigger.query;
    chatMention.highlight = 0;
    chatMention.confirmEntry = null;
    chatMention.confirmBusy = false;
    if(chatWs.activeRoomId) loadMentionRoster(chatWs.activeRoomId);
    var pop = el('#chatMentionPopover');
    if(pop) pop.classList.add('open');
    positionMentionPopover();
    renderMentionPopover();
  }

  function closeMentionPopover(){
    chatMention.open = false;
    chatMention.matches = [];
    chatMention.confirmEntry = null;
    chatMention.confirmBusy = false;
    chatMention.groupSend = null;
    var pop = el('#chatMentionPopover');
    if(pop){ pop.classList.remove('open'); pop.innerHTML = ''; }
    renderChatSuggestions(); // was deferred while the popover was open
  }

  // How many people a draft's group tags (@all/@all_users/@all_bots) would
  // reach in the active room — null when the draft has no group tag. Humans
  // exclude the sender; agents exclude home's synthetic gateway entry.
  function groupTagCounts(text){
    var t = (text || '').toLowerCase();
    var all = /@all\b/.test(t);
    var bots = all || /@all_bots\b/.test(t);
    var users = all || /@all_users\b/.test(t);
    if(!bots && !users) return null;
    var roster = (chatWs.activeRoomId && chatRoomState(chatWs.activeRoomId).mentionRoster) || {};
    var agents = bots ? ((roster.agents || []).filter(function(a){ return a.id !== 'gateway'; }).length) : 0;
    var humans = users ? ((roster.humans || []).filter(function(h){
      return h.inChat && h.email.toLowerCase() !== (currentUser || '').toLowerCase();
    }).length) : 0;
    return {agents: agents, humans: humans};
  }

  // Reuses the mention popover's confirm look; Cancel (or clicking away)
  // leaves the draft in the composer.
  function openGroupSendConfirm(counts, onSend){
    var pop = el('#chatMentionPopover');
    if(!pop) return onSend();
    var parts = [];
    if(counts.agents) parts.push(counts.agents + (counts.agents === 1 ? ' bot' : ' bots'));
    if(counts.humans) parts.push(counts.humans + (counts.humans === 1 ? ' user' : ' users'));
    var desc = 'You will message ' + parts.join(' and ') + '. Do you want to continue?';
    chatMention.open = true;
    chatMention.matches = [];
    chatMention.groupSend = onSend;
    pop.classList.add('open');
    positionMentionPopover();
    pop.innerHTML = '<div class="cmp-confirm">' +
      '<div class="cmp-confirm-text">' + esc(desc) + '</div>' +
      '<div class="cmp-confirm-actions">' +
        '<button type="button" class="cmp-confirm-btn cmp-confirm-add" data-group-send="go">Send</button>' +
        '<button type="button" class="cmp-confirm-btn cmp-confirm-cancel" data-group-send="cancel">Cancel</button>' +
      '</div>' +
    '</div>';
    var go = el('[data-group-send="go"]', pop);
    var cancel = el('[data-group-send="cancel"]', pop);
    if(go) go.addEventListener('mousedown', function(e){ e.preventDefault(); onSend(); });
    if(cancel) cancel.addEventListener('mousedown', function(e){ e.preventDefault(); closeMentionPopover(); });
  }

  // Splices "@Name " into the composer at the token the popover opened for,
  // and — for an agent selected in a department room — also sets it as the
  // To: addressee, since picking who you're @-mentioning and picking who
  // the reply goes to are the same decision in a department room.
  function insertMentionText(entry){
    var input = el('#ccInput');
    if(input){
      var before = input.value.slice(0, chatMention.atPos);
      var afterCaret = input.value.slice(chatMention.atPos + 1 + chatMention.query.length);
      var inserted = '@' + entry.label + ' ';
      input.value = before + inserted + afterCaret;
      var caret = before.length + inserted.length;
      input.setSelectionRange(caret, caret);
      input.focus();
    }
    // 'gateway' is home's synthetic bot entry, not a real agents row — it
    // can't be an agentId payload, so never set it as the addressee.
    if(entry.kind === 'agent' && entry.id !== 'gateway' && (chatWs.activeKind === 'department' || chatWs.activeKind === 'dm' || chatWs.activeKind === 'group' || chatWs.activeKind === 'home') && chatWs.activeRoomId){
      chatRoomState(chatWs.activeRoomId).selectedAgentId = entry.id;
      renderDeptAgentSelector();
    }
  }

  function selectMentionEntry(entry){
    if(!entry) return;
    if(entry.inChat){
      insertMentionText(entry);
      closeMentionPopover();
      return;
    }
    // NOT IN CHAT agent outside a department room (home / a 1:1 agent room /
    // a DM) has nothing to "add" it to — those rooms' membership isn't ours
    // to change, so it's a plain mention insert, same as an IN CHAT pick. A
    // DM's roster is fixed at creation time, so that
    // same reasoning applies to a NOT IN CHAT *human* there too, unlike
    // home/department/agent rooms where a human can still be invited.
    if(chatWs.activeKind === 'dm' || chatWs.activeKind === 'group' || (entry.kind === 'agent' && chatWs.activeKind !== 'department')){
      insertMentionText(entry);
      closeMentionPopover();
      return;
    }
    chatMention.confirmEntry = entry;
    chatMention.confirmBusy = false;
    renderMentionPopover();
  }

  // Called from the composer's keydown handler before its own Enter-sends
  // logic — returns true when it consumed the key (nav/select/close), so the
  // caller knows not to also treat Enter as "send".
  function chatMentionHandleKeydown(e){
    if(!chatMention.open) return false;
    if(chatMention.groupSend){
      if(e.key === 'Enter'){ e.preventDefault(); chatMention.groupSend(); return true; }
      if(e.key === 'Escape'){ e.preventDefault(); closeMentionPopover(); return true; }
      return true; // swallow other keys while the send confirm is showing
    }
    if(chatMention.confirmEntry){
      if(e.key === 'Enter'){ e.preventDefault(); if(!chatMention.confirmBusy) confirmMentionAdd(); return true; }
      if(e.key === 'Escape'){ e.preventDefault(); cancelMentionConfirm(); return true; }
      return true; // swallow other keys while the confirm step is showing
    }
    if(e.key === 'ArrowDown'){
      e.preventDefault();
      if(chatMention.matches.length) chatMention.highlight = (chatMention.highlight + 1) % chatMention.matches.length;
      renderMentionPopover();
      return true;
    }
    if(e.key === 'ArrowUp'){
      e.preventDefault();
      if(chatMention.matches.length) chatMention.highlight = (chatMention.highlight - 1 + chatMention.matches.length) % chatMention.matches.length;
      renderMentionPopover();
      return true;
    }
    if(e.key === 'Enter'){
      var entry = chatMention.matches[chatMention.highlight];
      if(entry){ e.preventDefault(); selectMentionEntry(entry); return true; }
      closeMentionPopover();
      return false; // no match under an empty/no-hit query — let Enter send as usual
    }
    if(e.key === 'Escape'){
      e.preventDefault();
      closeMentionPopover();
      return true;
    }
    return false;
  }

  document.addEventListener('click', function(e){
    if(!chatMention.open) return;
    var pop = el('#chatMentionPopover');
    if(pop && pop.contains(e.target)) return;
    if(e.target === el('#ccInput')) return;
    closeMentionPopover();
  });

  (function(){
    var input = el('#ccInput');
    if(!input) return;
    input.addEventListener('input', function(){
      var trigger = mentionTriggerAt(input);
      if(trigger) openMentionPopover(trigger);
      else closeMentionPopover();
    });
  })();

  // Web links from agent responses stay inside Mia. The handler is
  // delegated because both the main timeline and docked thread are rebuilt
  // whenever native events arrive.
  (function(){
    function openInsideMia(event){
      var link = event.target.closest('a[data-chat-web-link]');
      if(!link) return;
      event.preventDefault();
      event.stopPropagation();
      var href = link.href;
      openWebBrowserTool();
      localBrowserNavigate(href);
    }
    var thread = el('#chatThread');
    if(thread) thread.addEventListener('click', openInsideMia);
    var panel = el('#ctpBody');
    if(panel) panel.addEventListener('click', openInsideMia);
  })();

  function clearChatActive(){
    els('.chat-recent-row.active', el('#panel-chat')).forEach(function(r){ r.classList.remove('active'); });
  }

  function loadNativeSidebarPreviews(options){
    options = options || {};
    if(chatWs.configured === false) return Promise.resolve();
    var requests = chatSidebarRoomIds().map(function(roomId){
      var state = chatRoomState(roomId);
      if(state.messages.length){
        state.sidebarPreviewLoaded = true;
        return Promise.resolve();
      }
      if(state.sidebarPreviewLoaded || state.sidebarPreviewLoading) return Promise.resolve();
      state.sidebarPreviewLoading = true;
      return api(nativeEventsUrl(roomId, 0, 10, true)).then(function(res){
        if(res.status !== 200) return;
        var rawMessages = (res.data && res.data.events) || [];
        var messages = nativeEventsToMessages(rawMessages);
        if(!state.messages.length){
          state.messages = messages;
          state.lastTs = rawMessages.reduce(function(timestamp, event){
            return Math.max(timestamp, Date.parse(event.createdAt) || 0);
          }, state.lastTs || 0);
          state.lastSequence = rawMessages.reduce(function(sequence, event){
            return Math.max(sequence, Number(event.sequence || 0));
          }, state.lastSequence || 0);
        }
        state.sidebarPreviewLoaded = true;
        if(options.render !== false) renderChatSidebar();
      }).catch(function(){}).then(function(){
        state.sidebarPreviewLoading = false;
      });
    });
    return Promise.all(requests);
  }

  function renderChatSidebar(){
    var pinnedWrap = el('#chatPinned');
    var allWrap = el('#chatAllConversations');
    var pinnedCountEl = el('#chatPinnedCount');
    var allCountEl = el('#chatAllCount');
    var syncDot = el('#chatSyncDot');
    var syncFooter = el('#chatSyncFooter');
    if(!pinnedWrap || !allWrap) return;
    updateChatBackButton();

    if(syncDot) syncDot.classList.toggle('offline', chatWs.configured === false);
    if(syncFooter){
      syncFooter.textContent = chatWs.configured === false ? 'Chat Failure' : (chatWs.configured === true ? 'Chat Online' : 'Connecting…');
      syncFooter.classList.toggle('chat-sync-fail', chatWs.configured === false);
    }

    // A room's last-message time only appears once we've actually loaded it
    // this session (chatWs.byRoom[roomId].lastTs) — no fabricated numbers
    // for rooms we haven't fetched yet.
    function roomTimeTag(roomId){
      var state = roomId && chatWs.byRoom[roomId];
      if(!state || !state.lastTs) return '';
      return '<span class="chat-dm-time">' + esc(chatRelTime(state.lastTs)) + '</span>';
    }
    function lastTsFor(roomId){
      var state = roomId && chatWs.byRoom[roomId];
      return (state && state.lastTs) || 0;
    }
    function roomPreview(roomId){
      var state = roomId && chatWs.byRoom[roomId];
      if(!state || !state.messages || !state.messages.length) return '';
      var real = state.messages.filter(function(m){ return !m.system && (m.body || chatMessageHasAttachments(m)); });
      if(!real.length) return '';
      var last = real[real.length - 1];
      if(!last.body && chatMessageHasAttachments(last)) return 'Attachment';
      // Bot messages must go through displayBotBody to strip internal plumbing
      // text and legacy filler placeholders, matching the main thread renderer.
      var body = isHumanSender(last.sender) ? last.body : displayBotBody(last.body);
      if(!body) return '';
      var parsed = isHumanSender(last.sender) ? parseSignedHumanBody(body) : parseSignedBody(body);
      var text = parsed && parsed.text ? parsed.text : body;
      return excerpt(markdownPreviewText(text).replace(/\s+/g, ' ').trim(), 58);
    }
    function sidebarRowText(name, roomId, hasActivity){
      var indicator = renderChatActivityIndicator(hasActivity, chatNeedsAttention(roomId));
      return '<span class="row-text"><span class="row-line1"><span class="row-label">' + esc(name) + '</span>' + indicator + roomTimeTag(roomId) +
        '</span><span class="row-preview">' + esc(roomPreview(roomId)) + '</span></span>';
    }

    // Official channels are represented by their own square initials mark,
    // never by the current member list. The room roster is still loaded
    // lazily for header counts and the @-mention picker.
    function channelMemberEntries(roomId, label, isHome){
      var state = roomId && chatRoomState(roomId);
      var roster = state && state.mentionRoster;
      if(roster && !roster.loading){
        var humans = (roster.humans || []).filter(function(h){
          return h.inChat || h.membership === 'join' || h.membership === 'invite';
        }).map(function(h){ return {kind: 'human', email: h.email, name: displayNameForEmail(h.email)}; });
        var agents = (roster.agents || []).map(function(a){ return {kind: 'agent', id: a.id, name: a.name}; });
        return humans.concat(agents);
      }
      if(STYLED_SKIN && chatWs.configured === false){
        return localDepartmentAgentRoster(label, isHome).map(function(a){ return {kind: 'agent', id: a.id, name: a.name}; });
      }
      // Do not fabricate room members from the global directory while the
      // authoritative room roster is loading. A neutral placeholder is less
      // confusing than briefly showing humans from another chat.
      return [];
    }
    function channelMemberStack(roomId, label, isHome){
      var entries = channelMemberEntries(roomId, label, isHome);
      var localAgentsOnly = STYLED_SKIN && chatWs.configured === false;
      if(!entries.length){
        var state = roomId && chatRoomState(roomId);
        var roster = state && state.mentionRoster;
        var message = localAgentsOnly ? 'Local agent assignments unavailable; human membership unavailable' : (!roster || roster.loading ? 'Channel members unavailable' : 'No channel members listed');
        return '<span class="chat-row-members unavailable" title="' + esc(message) + '" aria-label="' + esc(message) + '">' +
          '<span class="chat-channel-members-unavailable" aria-hidden="true">?</span></span>';
      }
      var visible = entries.slice(0, 3);
      var avatars = visible.map(function(member, index){
        var content = member.kind === 'human' ? humanAvatarContent(member.email) : agentAvatarHtml(member.name, member.id, 27, null, null, true);
        var top = index === 1 ? 11 : 4;
        return '<span class="chat-channel-avatar ' + (member.kind === 'human' ? 'human' : 'agent') + '" style="--member-index:' + index + ';--member-top:' + top + 'px">' + content + '</span>';
      }).join('');
      var remaining = entries.length - visible.length;
      var more = remaining > 0 ? '<span class="chat-channel-members-more">+' + remaining + '</span>' : '';
      var names = entries.map(function(member){ return member.name || member.email; }).join(', ');
      var unavailable = localAgentsOnly ? ' · Human membership unavailable' : '';
      return '<span class="chat-row-members" title="' + esc(names + unavailable) + '" aria-label="Channel agents: ' + esc(names) + (localAgentsOnly ? '. Human membership unavailable' : '') + '">' + avatars + more + '</span>';
    }
    function primeChannelRosters(){
      if(chatWs.configured === false) return;
      var roomIds = [];
      if(chatWs.rooms.home && chatWs.rooms.home.roomId) roomIds.push(chatWs.rooms.home.roomId);
      chatWs.rooms.departments.forEach(function(d){ if(d.roomId) roomIds.push(d.roomId); });
      roomIds.forEach(function(roomId){ loadMentionRoster(roomId); });
    }
    // All conversations: departments, people, agents, and group DMs share one
    // activity-ordered list. The native workspace-home room remains loaded as
    // the workspace root, but the top switcher already represents it, so it
    // is deliberately not duplicated as a conversation row. Opening a room is selection only; it
    // must never change the ordering. A brand-new empty channel uses its
    // durable creation timestamp so it starts at the top; later message
    // activity supersedes that timestamp normally.
    var conversationEntries = [];
    var deptEntries = chatWs.allDepartments.slice().sort(function(a, b){
      return a < b ? -1 : (a > b ? 1 : 0);
    }).map(function(name){
      var room = chatWs.rooms.departments.filter(function(d){ return d.department === name; })[0] || null;
      return {name: name, sourceDepartment: name, room: room};
    });
    deptEntries.forEach(function(entry){
      var deptRoom = entry.room;
      conversationEntries.push({kind: 'department', name: entry.name, department: entry.name, sourceDepartment: entry.sourceDepartment,
        roomId: deptRoom && deptRoom.roomId || null, lastTs: lastTsFor(deptRoom && deptRoom.roomId),
        createdTs: Date.parse(deptRoom && deptRoom.createdAt || '') || 0,
        mockupOrder: entry.mockupOrder});
    });
    primeChannelRosters();
    loadNativeSidebarPreviews();

    // Keep known people visible even before a human DM room exists, then
    // preserve the existing agent and group-DM rows. A direct human room is
    // joined to its person's row so it never appears twice.
    var me = String(currentUser || '').toLowerCase();
    var humanEntries = humanDirectoryUsersForWorkspace(activeWorkspaceKey, chatWs.humans).filter(function(h){
      return String(h.email || '').toLowerCase() !== me;
    }).map(function(h){
      var room = directHumanDmFor(h.email);
      return {kind: 'human', name: displayNameForEmail(h.email), email: h.email, roomId: room && room.roomId || null,
        lastTs: lastTsFor(room && room.roomId)};
    });
    var directHumanRoomIds = {};
    humanEntries.forEach(function(e){ if(e.roomId) directHumanRoomIds[e.roomId] = true; });
    var sidebarAgents = (chatWs.gatewayAgent ? [{id: 'gateway', name: 'Mia', roomId: chatWs.gatewayAgent.roomId, agent: chatWs.gatewayAgent}] : []).concat(chatWs.allAgents);
    var agentEntries = sidebarAgents
      .map(function(a){
        return {kind: 'agent', name: a.name, roomId: a.roomId || a.nativeConversationId || null, agent: a, mockupOrder: a.mockupOrder};
      });
    var dmEntries = chatWs.rooms.dms.filter(function(d){ return !directHumanRoomIds[d.roomId]; }).map(function(d){
      return {kind: d.kind === 'group' ? 'group' : 'dm', name: dmLabel(d), roomId: d.roomId, dm: d};
    });
    var allDmEntries = humanEntries.concat(agentEntries, dmEntries).map(function(e){
      if(e.lastTs == null) e.lastTs = lastTsFor(e.roomId);
      // Hide/unhide keys on ids, not room ids — an agent row can exist
      // before its native conversation does.
      e.hideKey = e.kind === 'agent' ? 'agent:' + e.agent.id : e.kind === 'dm' ? 'dm:' + e.dm.id : e.kind === 'human' ? 'human:' + String(e.email || '').toLowerCase() : null;
      return e;
    });
    conversationEntries = conversationEntries.concat(allDmEntries);
    function pinKeyFor(entry){
      if(entry.roomId) return 'room:' + entry.roomId;
      if(entry.kind === 'home') return 'home';
      if(entry.kind === 'department') return 'department:' + String(entry.department || '').toLowerCase();
      if(entry.kind === 'human') return 'human:' + String(entry.email || '').toLowerCase();
      if(entry.kind === 'agent') return 'agent:' + String(entry.agent && entry.agent.id || '').toLowerCase();
      return 'dm:' + String(entry.dm && entry.dm.id || '').toLowerCase();
    }
    conversationEntries.forEach(function(entry){ entry.pinKey = pinKeyFor(entry); });
    function conversationSortTs(entry){
      return Math.max(Number(entry.lastTs) || 0, Number(entry.createdTs) || 0);
    }
    conversationEntries.sort(function(a, b){
      return conversationSortTs(b) - conversationSortTs(a) || a.name.localeCompare(b.name);
    });
    var hiddenSet = {};
    (chatWs.hiddenChats || []).forEach(function(k){ hiddenSet[k] = true; });
    var visibleEntries = conversationEntries.filter(function(e){ return !hiddenSet[e.hideKey]; });
    var hiddenEntries = allDmEntries.filter(function(e){ return hiddenSet[e.hideKey]; });
    var pinnedEntries = visibleEntries.filter(function(e){ return isChatPinned(e.pinKey); });
    var allEntries = visibleEntries.filter(function(e){ return !isChatPinned(e.pinKey); });

    pinnedCountEl && (pinnedCountEl.textContent = pinnedEntries.length || '');
    allCountEl && (allCountEl.textContent = allEntries.length || '');
    function conversationRowHtml(e){
      var active = e.kind === 'home'
        ? chatWs.activeKind === 'home'
        : e.kind === 'department'
        ? (chatWs.activeKind === 'department' && chatWs.activeLabel === e.department)
        : e.kind === 'human'
        ? (chatWs.activeKind === 'dm' && !!e.roomId && chatWs.activeRoomId === e.roomId)
        : e.kind === 'agent'
        ? (chatWs.activeKind === 'agent' && !!e.roomId && chatWs.activeRoomId === e.roomId)
        : ((chatWs.activeKind === 'dm' || chatWs.activeKind === 'group') && chatWs.activeRoomId === e.roomId);
      var attr = e.kind === 'home' ? 'data-chat-kind="home"' : e.kind === 'department' ? 'data-dept="' + esc(e.department) + '" data-dept-source="' + esc(e.sourceDepartment || e.department) + '"' : e.kind === 'human' ? 'data-dm-human-email="' + esc(e.email) + '"' : e.kind === 'agent' ? 'data-agent-id="' + esc(e.agent.id) + '"' : 'data-dm-id="' + esc(e.dm.id) + '"';
      attr += ' data-chat-key="' + esc(e.pinKey) + '" data-chat-menu-kind="' + esc(e.kind) + '" data-chat-menu-name="' + esc(e.name) + '"' + (e.roomId ? ' data-chat-room-id="' + esc(e.roomId) + '"' : '');
      if(e.hideKey) attr += ' data-chat-menu-hide-key="' + esc(e.hideKey) + '"';
      if(e.kind === 'human') attr += ' data-chat-menu-human-email="' + esc(e.email) + '"';
      if(e.kind === 'agent') attr += ' data-chat-menu-agent-id="' + esc(e.agent.id) + '"';
      var hasActivity = sidebarEntryHasActivity(e);
      var titleAttr = hasActivity ? ' title="Active now"' : '';
      var mark = e.kind === 'home' || e.kind === 'department'
        ? '<span class="chat-row-mark channel" title="Official channel">' + esc(benchMark(e.name || 'Multiplayer Test')) + '</span>'
        : e.kind === 'human'
        ? '<span class="chat-row-mark tile human">' + humanAvatarContent(e.email) + '</span>'
        : '<span class="chat-row-mark tile">' + (e.kind === 'agent' ? agentAvatarHtml(e.name, e.agent && e.agent.id, 40, isMiaOrchestrator(e.name, e.agent && e.agent.id) ? 'sidebar' : null, null, true) : esc(benchMark(e.name))) + '</span>';
      var hide = e.hideKey && !isChatPinned(e.pinKey) ? '<span class="chat-row-hide" data-hide-key="' + esc(e.hideKey) + '" title="Hide from sidebar (the chat and its history are kept)">&times;</span>' : '';
      return '<button type="button" class="chat-recent-row' + (active ? ' active' : '') + '" ' + attr + titleAttr + '>' + mark +
        sidebarRowText(e.name, e.roomId, hasActivity) +
        hide + '</button>';
    }
    pinnedWrap.innerHTML = pinnedEntries.length ? pinnedEntries.map(conversationRowHtml).join('') : '<div class="chat-sidebar-empty chat-pinned-empty">No pinned conversations yet</div>';
    var dmRowsHtml = allEntries.length ? allEntries.map(conversationRowHtml).join('') : '<div class="chat-sidebar-empty">no conversations yet</div>';
    // Hidden chats live behind a collapsed toggle at the bottom of the
    // group — hiding is a sidebar-tidiness action, never a delete, so the
    // way back stays one click away.
    var hiddenHtml = '';
    if(hiddenEntries.length){
      hiddenHtml = '<button type="button" class="chat-hidden-toggle" id="chatHiddenToggle">' +
        (chatWs.showHiddenChats ? '&#9662;' : '&#9656;') + ' hidden (' + hiddenEntries.length + ')</button>';
      if(chatWs.showHiddenChats){
        hiddenHtml += hiddenEntries.map(function(e){
          var hiddenMark = e.kind === 'agent' ? agentAvatarHtml(e.name, e.agent && e.agent.id, 40, null, null, true) : e.kind === 'human' ? humanAvatarContent(e.email) : esc(benchMark(e.name));
          return '<button type="button" class="chat-recent-row chat-row-hidden" data-unhide-key="' + esc(e.hideKey) + '"><span class="chat-row-mark tile' + (e.kind === 'human' ? ' human' : '') + '">' + hiddenMark + '</span><span class="row-label">' + esc(e.name) + '</span><span class="chat-dm-time">unhide</span></button>';
        }).join('');
      }
    }
    allWrap.innerHTML = dmRowsHtml + hiddenHtml;
    renderChatStarterBots();
    [pinnedWrap, allWrap].forEach(function(wrap){
      var homeRow = el('.chat-recent-row[data-chat-kind="home"]', wrap);
      if(homeRow) homeRow.addEventListener('click', function(){ clearChatBack(); clearChatActive(); homeRow.classList.add('active'); selectHomeRoom(); });
      els('.chat-recent-row[data-dept]', wrap).forEach(function(row){
        row.addEventListener('click', function(){
          clearChatBack(); clearChatActive(); row.classList.add('active');
          var name = row.getAttribute('data-dept');
          var sourceName = row.getAttribute('data-dept-source') || name;
          var room = chatWs.rooms.departments.filter(function(d){ return d.department === sourceName; })[0];
          selectDepartmentRoom(room || {department: sourceName}, name).catch(function(){});
        });
      });
      els('.chat-recent-row[data-agent-id]', wrap).forEach(function(row){
        row.addEventListener('click', function(){
          var id = row.getAttribute('data-agent-id');
          var agent = id === 'gateway' ? chatWs.gatewayAgent : chatWs.allAgents.filter(function(a){ return a.id === id; })[0];
          if(agent) navigateToAgentChat(agent, true);
        });
      });
      els('.chat-recent-row[data-dm-human-email]', wrap).forEach(function(row){
        row.addEventListener('click', function(){
          clearChatBack(); clearChatActive(); row.classList.add('active');
          openHumanDirectMessage(row.getAttribute('data-dm-human-email'), false);
        });
      });
      els('.chat-recent-row[data-dm-id]', wrap).forEach(function(row){
        row.addEventListener('click', function(){
          clearChatBack(); clearChatActive(); row.classList.add('active');
          var id = row.getAttribute('data-dm-id');
          var dm = chatWs.rooms.dms.filter(function(d){ return d.id === id; })[0];
          if(dm) loadChatRoom(dm.roomId, dm.kind || 'dm', dmLabel(dm));
        });
      });
    });
    els('.chat-row-hide', allWrap).forEach(function(x){
      x.addEventListener('click', function(ev){
        ev.stopPropagation();
        hideChatEntry(x.getAttribute('data-hide-key'));
      });
    });
    var hiddenToggle = el('#chatHiddenToggle');
    if(hiddenToggle) hiddenToggle.addEventListener('click', function(){
      chatWs.showHiddenChats = !chatWs.showHiddenChats;
      renderChatSidebar();
    });
    els('.chat-recent-row[data-unhide-key]', allWrap).forEach(function(row){
      row.addEventListener('click', function(){
        unhideChatEntry(row.getAttribute('data-unhide-key'));
      });
    });

    applyChatSearchFilter();
  }

  function nativeConversationIdForChatKey(key){
    if(!key) return null;
    if(key.indexOf('room:') === 0) return key.slice(5);
    var rooms = (chatWs.rooms.dms || []).concat(chatWs.rooms.departments || []);
    if(chatWs.rooms.home) rooms.push(chatWs.rooms.home);
    if(key.indexOf('agent:') === 0){
      var agentId = key.slice(6);
      var agentRoom = (chatWs.nativeConversations || []).filter(function(conversation){
        var metadata = conversation.metadata || {};
        return agentId === 'gateway'
          ? conversation.type === 'agent' && (metadata.agentId === 'gateway' || String(conversation.name || '').toLowerCase() === 'mia')
          : conversation.type === 'bot' && metadata.botId === agentId;
      })[0];
      return agentRoom ? agentRoom.id : null;
    }
    if(key.indexOf('dm:') === 0){
      var dmId = key.slice(3);
      var dm = rooms.filter(function(room){ return (room.kind === 'dm' || room.kind === 'group') && (room.id === dmId || room.roomId === dmId); })[0];
      return dm ? dm.roomId : null;
    }
    return null;
  }

  function hideChatEntry(key){
    if(!key) return;
    if(chatWs.hiddenChats.indexOf(key) === -1) chatWs.hiddenChats.push(key);
    var conversationId = nativeConversationIdForChatKey(key);
    var activeIsHidden = conversationId === chatWs.activeRoomId;
    if(conversationId){
      api(nativeConversationPath(conversationId, '/state'), {method:'PATCH', body:{hidden:true}}).catch(function(){});
    }
    if(activeIsHidden){
      closeMobileChatRoom();
    }
    renderChatSidebar();
  }

  function deleteNativeConversation(entry){
    if(!entry || !entry.roomId) return;
    return appConfirm('Delete ' + (entry.name || 'this conversation') + '? This removes it from everyone\'s conversation list. Its history is retained.').then(function(ok){
      if(!ok) return;
      return api(nativeConversationPath(entry.roomId), {method:'DELETE'}).then(function(res){
        if(res.status !== 200){
          showBenchToast('Delete failed (' + res.status + ')');
          return;
        }
        var wasActive = chatWs.activeRoomId === entry.roomId;
        if(wasActive){
          closeNativeChatSocket();
          closeChatThread();
          clearChatBack();
        }
        var state = chatWs.byRoom[entry.roomId];
        if(state && state.thinkingTimer) clearTimeout(state.thinkingTimer);
        delete chatWs.byRoom[entry.roomId];
        delete chatAttentionRooms[entry.roomId];
        delete chatPinnedKeys[entry.pinKey];
        saveChatAttention();
        saveChatPinned();
        chatWs.nativeConversations = (chatWs.nativeConversations || []).filter(function(conversation){
          return conversation.id !== entry.roomId;
        });
        applyNativeConversationList(chatWs.nativeConversations);
        if(wasActive){
          chatWs.activeRoomId = null;
          chatWs.activeKind = null;
          chatWs.activeLabel = '';
          refreshChatMain();
        }
        renderChatSidebar();
        showBenchToast('Conversation deleted');
      }).catch(function(){ showBenchToast('Delete failed — network error'); });
    });
  }

  function unhideChatEntry(key){
    if(!key) return;
    chatWs.hiddenChats = chatWs.hiddenChats.filter(function(k){ return k !== key; });
    var conversationId = nativeConversationIdForChatKey(key);
    if(conversationId){
      api(nativeConversationPath(conversationId, '/state'), {method:'PATCH', body:{hidden:false}}).catch(function(){});
    }
    renderChatSidebar();
    if(key.indexOf('agent:') === 0){
      var agentId = key.slice(6);
      var agent = agentId === 'gateway' ? chatWs.gatewayAgent : chatWs.allAgents.filter(function(a){ return 'agent:' + a.id === key; })[0];
      if(agent){ clearChatBack(); selectAgentRoom(agent); }
    } else if(key.indexOf('human:') === 0){
      openHumanDirectMessage(key.slice(6), false);
    } else {
      var dm = chatWs.rooms.dms.filter(function(d){ return (d.kind === 'dm' || d.kind === 'group') && 'dm:' + d.id === key; })[0];
      if(dm){ clearChatBack(); loadChatRoom(dm.roomId, dm.kind || 'dm', dmLabel(dm)); }
    }
  }


  function chatSearchDirectorySnapshot(){
    var humans = humanDirectoryUsersForWorkspace(activeWorkspaceKey,
      chatSearchDirectory.loaded ? chatSearchDirectory.humans : (chatWs.humans || []));
    var agents = chatSearchDirectory.loaded ? chatSearchDirectory.agents : (chatWs.allAgents || []);
    agents = agents.slice();
    if(chatWs.gatewayAgent && !agents.some(function(agent){ return agent.id === 'gateway'; })){
      agents.unshift(chatWs.gatewayAgent);
    }
    return {humans: humans || [], agents: agents};
  }

  function chatSearchAgentRecord(agent){
    if(!agent) return null;
    if(agent.id === 'gateway') return chatWs.gatewayAgent || agent;
    var live = (chatWs.allAgents || []).filter(function(candidate){ return candidate.id === agent.id; })[0];
    return Object.assign({}, agent, live || {});
  }

  function renderChatSearchResults(){
    var wrap = el('#chatSearchResults');
    var input = el('#chatSearch');
    if(!wrap) return;
    var q = input ? input.value.trim().toLowerCase() : '';
    if(!q){
      wrap.classList.remove('open');
      wrap.innerHTML = '';
      if(input) input.setAttribute('aria-expanded', 'false');
      return;
    }
    var directory = chatSearchDirectorySnapshot();
    var people = directory.humans.filter(function(user){
      var email = String(user && user.email || '');
      var name = displayNameForEmail(email);
      var emailLower = email.toLowerCase();
      var emailLocalpart = emailLower.split('@')[0];
      var emailMatch = q.indexOf('@') !== -1 ? emailLower.indexOf(q) !== -1 : emailLocalpart.indexOf(q) !== -1;
      return emailMatch || name.toLowerCase().indexOf(q) !== -1;
    });
    var agents = directory.agents.filter(function(agent){
      var name = String(agent && agent.name || '');
      var id = String(agent && agent.id || '');
      return name.toLowerCase().indexOf(q) !== -1 || id.toLowerCase().indexOf(q) !== -1;
    });
    function personHtml(user){
      var email = String(user.email || '');
      return '<button type="button" class="chat-search-result" role="option" data-chat-search-kind="human" data-chat-search-id="' + esc(email) + '">' +
        '<span class="chat-search-result-avatar human">' + humanAvatarContent(email) + '</span>' +
        '<span class="chat-search-result-copy"><span class="chat-search-result-name">' + esc(displayNameForEmail(email)) + '</span><span class="chat-search-result-sub">' + esc(email) + '</span></span>' +
        '<span class="chat-search-result-kind">Person</span></button>';
    }
    function agentHtml(agent){
      var record = chatSearchAgentRecord(agent);
      var name = String(record && record.name || agent.name || agent.id || 'Bot');
      var id = String(record && record.id || agent.id || '');
      var kindLabel = id === 'gateway' ? 'Agent' : 'Bot';
      return '<button type="button" class="chat-search-result" role="option" data-chat-search-kind="agent" data-chat-search-id="' + esc(id) + '">' +
        '<span class="chat-search-result-avatar agent">' + agentAvatarHtml(name, id, 24, null, null, false) + '</span>' +
        '<span class="chat-search-result-copy"><span class="chat-search-result-name">' + esc(name) + '</span><span class="chat-search-result-sub">' + esc(id === 'gateway' ? 'Hermes gateway' : id) + '</span></span>' +
        '<span class="chat-search-result-kind">' + kindLabel + '</span></button>';
    }
    var html = '';
    if(people.length){
      html += '<div class="cmp-section-label">PEOPLE</div>' + people.slice(0, 8).map(personHtml).join('');
    }
    if(agents.length){
      html += '<div class="cmp-section-label">AGENTS &amp; BOTS</div>' + agents.slice(0, 12).map(agentHtml).join('');
    }
    if(!html) html = '<div class="chat-search-result-empty">' + (chatSearchDirectory.loading ? 'Searching people, agents, and bots&hellip;' : 'No people, agents, or bots found') + '</div>';
    wrap.innerHTML = html;
    wrap.classList.add('open');
    if(input) input.setAttribute('aria-expanded', 'true');
    els('.chat-search-result', wrap).forEach(function(button){
      button.addEventListener('click', function(){
        var kind = button.getAttribute('data-chat-search-kind');
        var id = button.getAttribute('data-chat-search-id');
        if(input) input.value = '';
        renderChatSearchResults();
        applyChatSearchFilter();
        if(kind === 'human'){
          openHumanDirectMessage(id, false);
          return;
        }
        var agent = directory.agents.filter(function(candidate){ return String(candidate.id || '') === id; })[0];
        if(agent) navigateToAgentChat(chatSearchAgentRecord(agent), true);
      });
    });
  }

  function loadChatSearchDirectory(){
    if(chatSearchDirectory.request) return chatSearchDirectory.request;
    chatSearchDirectory.loading = true;
    renderChatSearchResults();
    var request = Promise.all([loadChatHumans(), loadAgents()]).then(function(results){
      chatSearchDirectory.humans = Array.isArray(results[0]) ? results[0].slice() : [];
      chatSearchDirectory.agents = Array.isArray(results[1]) ? results[1].slice() : [];
    });
    chatSearchDirectory.request = request.catch(function(){}).then(function(){
      chatSearchDirectory.loaded = true;
      chatSearchDirectory.loading = false;
      chatSearchDirectory.request = null;
      renderChatSearchResults();
    });
    return chatSearchDirectory.request;
  }

  // Client-side filter over the two sidebar groups — it hides rows (and their
  // group heading, when a group filters to nothing) whose row-label doesn't
  // contain the query. Directory matches are rendered separately above.
  function applyChatSearchFilter(){
    var input = el('#chatSearch');
    var q = input ? input.value.trim().toLowerCase() : '';
    [
      {wrap: el('#chatPinned'), head: el('#chatPinned') && el('#chatPinned').previousElementSibling},
      {wrap: el('#chatAllConversations'), head: el('#chatAllConversations') && el('#chatAllConversations').previousElementSibling}
    ].forEach(function(group){
      if(!group.wrap) return;
      var rows = els('.chat-recent-row', group.wrap);
      var anyVisible = false;
      rows.forEach(function(row){
        var label = (el('.row-label', row) || row).textContent || '';
        var match = !q || label.toLowerCase().indexOf(q) !== -1;
        row.classList.toggle('filtered-out', !match);
        if(match) anyVisible = true;
      });
      if(group.head) group.head.classList.toggle('filtered-empty', !!q && !anyVisible && rows.length > 0);
    });
    renderChatSearchResults();
  }
  (function(){
    var search = el('#chatSearch');
    if(search) search.addEventListener('input', function(){
      applyChatSearchFilter();
      if(search.value.trim()) loadChatSearchDirectory();
    });
  })();

  function loadChatHumans(){
    return loadHumanDirectoryResponse().then(function(res){
      if(res.status !== 200) return chatWs.humans;
      chatWs.humans = humanDirectoryUsersForWorkspace(activeWorkspaceKey, (res.data && res.data.users) || []);
      setAppCollaborationMode(chatWs.humans);
      chatWs.humans.forEach(function(h){ mergeUserProfile(h.email, h); });
      return chatWs.humans;
    }).catch(function(){ return chatWs.humans; });
  }

  function initChatWorkspace(){
    return Promise.all([
      loadNativeConversations(),
      loadAgents(),
      loadChatHumans(),
      fetchDepartmentsSilently(),
      loadActiveAutomationRuns()
    ]).then(function(results){
      applyNativeConversationList(results[0]);
      chatWs.humans = Array.isArray(results[2]) ? results[2].slice() : [];
      return loadNativeSidebarPreviews({render:false}).then(function(){
        startChatPolling();
        renderChatSidebar();
        refreshChatMain();
        var rooms = chatWs.rooms.home ? [chatWs.rooms.home].concat(chatWs.rooms.departments, chatWs.rooms.dms) : chatWs.rooms.departments.concat(chatWs.rooms.dms);
        return loadNativeConversationStates(rooms).then(function(){
          restoreActiveChatLocation();
        });
      });
    }).catch(function(){
      chatWs.native = true;
      chatWs.configured = false;
      scheduleMiaServiceUnavailable();
      renderChatSidebar();
      refreshChatMain();
    });
  }

  /* Revisiting the Chat layer refreshes the room/department/agent lists
     (an agent built elsewhere may now exist) without discarding whatever's
     cached per-room in chatWs.byRoom or resetting the active thread. */
  function renderChatWorkspace(){
    var ready = initChatWorkspace();
    startChatPolling();
    return ready;
  }

  /* ============ LIVE REFRESH: app-wide "always fresh" agents/rooms poll ============
     One app-level timer (not per-view) polls GET /api/state/version every 4s. The
     counter is bumped server-side by every agent/department/conversation/profile
     mutation (see server.js bumpVersion()), so a change made by THIS session or by
     any OTHER logged-in session is picked up here without a reload — that's the
     "new agent doesn't show up for other users until they reload" bug this closes.
     Deliberately NOT the same mechanism as the chat message poller (native
     subscription/reconnect) — this one is about the agents/rooms/roster
     datasets (benchAgents, chatWs.allAgents, chatWs.rooms), never messages. */
  var liveRefresh = {lastSeenVersion: null, pendingApply: false, timer: null};

  /* True while the user is mid-interaction with something a full repaint would
     disrupt: the create/edit cinema, a focused input/textarea (mid-typing — e.g.
     a department rename row), or any of the app's overlay drawers. Data is still
     refreshed underneath (see applyLiveRefresh) — only the DOM repaint waits. */
  function liveRefreshBlocked(){
    if(typeof cinema !== 'undefined' && cinema.mode !== 'idle') return true;
    var active = document.activeElement;
    if(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
    var openOverlaySelectors = ['#settingsDrawer', '#benchDetail', '#benchCinema', '#dmComposeDrawer'];
    for(var i = 0; i < openOverlaySelectors.length; i++){
      var node = el(openOverlaySelectors[i]);
      if(node && node.classList.contains('open')) return true;
    }
    return false;
  }

  // Departments list, refreshed silently (no repaint here — paintAcpDepartments
  // can carry an in-progress rename <input>, so it's left to liveRefreshBlocked's
  // own guard rather than clobbered on a timer tick).
  function fetchDepartmentsSilently(){
    return api('/api/departments').then(function(res){
      var list = res.data && res.data.departments;
      if(Array.isArray(list)){
        deptCache = list.slice();
      }
    }).catch(function(){});
  }

  // Re-fetches the shared datasets every mutation above can touch and folds them
  // into the same module-level state every other code path already reads from
  // (benchAgents, chatWs.allAgents/allDepartments/rooms) — so once a repaint does
  // happen (here, or the next time the user navigates), it's reading live data,
  // not a stale closure copy.
  function fetchLiveSharedData(){
    return Promise.all([loadAgents(), loadChatHumans(), fetchDepartmentsSilently()]).then(function(results){
      var apiAgents = results[0];
      benchAgents = apiAgents.map(apiAgentToBench);
      syncChatBotRecords(apiAgents);
      if(chatWs.native){
        return loadNativeConversations().then(function(conversations){
          applyNativeConversationList(conversations);
        });
      }
      return Promise.resolve();
    });
  }

  // Repaints only the views that show agents/rooms — never the chat message
  // thread (chatMsgHtml/renderChatThread), which is handled by native events,
  // not this app-wide data refresh.
  function renderLiveViews(){
    refreshAgentsView();
    if(el('#chatPinned')) renderChatSidebar();
    if(el('#chatDeptAgents')) renderDeptAgentSelector();
    // Task counts feed the header popover's "N running tasks" link and the
    // docked tasks panel's live status/time-ago — both need a repaint
    // whenever chatWs.tasks changes, same as the sidebar dots above.
    if(chatWs.activeRoomId && el('#channelHeader')) renderChatHeaderBar();
    if(el('#chatTasksPanel')) syncChatTasksPanel();
    if(chatInfo.mode === 'agents' && chatInfo.open) renderChatInfoPane();
    Object.keys(chatTaskStopPending).forEach(function(taskId){
      if(!(chatWs.tasks || []).some(function(task){ return task.id === taskId; })) delete chatTaskStopPending[taskId];
    });
    renderComposerTaskControl();
  }

  function applyLiveRefresh(){
    fetchLiveSharedData().then(function(){
      if(liveRefreshBlocked()) return; // data is fresh; repaint retried next tick
      liveRefresh.pendingApply = false;
      renderLiveViews();
    });
  }

  function pollLiveState(){
    // Cron sessions begin and end outside Mia, so they do not bump the app's
    // state version. Poll their narrow status endpoint on every live tick.
    loadActiveAutomationRuns();
    api('/api/state/version').then(function(res){
      if(res.status !== 200 || !res.data) return;
      var v = res.data.version;
      // Startup already awaits the authoritative conversations, bots,
      // departments, and active automation runs before Electron reveals the
      // window. The first version response therefore establishes the polling
      // baseline only; forcing another full fetch here visibly repainted the
      // just-hydrated UI with a second startup pass.
      if(liveRefresh.lastSeenVersion === null){
        liveRefresh.lastSeenVersion = v;
      } else if(v !== liveRefresh.lastSeenVersion){
        liveRefresh.lastSeenVersion = v;
        liveRefresh.pendingApply = true;
      }
      if(liveRefresh.pendingApply) applyLiveRefresh();
    }).catch(function(){});
  }

  var LIVE_REFRESH_POLL_MS = 4000;
  function startLiveRefreshPolling(){
    if(liveRefresh.timer) return; // one app-level interval, not one per view
    liveRefresh.lastSeenVersion = null;
    liveRefresh.pendingApply = false;
    pollLiveState();
    liveRefresh.timer = setInterval(pollLiveState, LIVE_REFRESH_POLL_MS);
  }
  function stopLiveRefreshPolling(){
    if(liveRefresh.timer){ clearInterval(liveRefresh.timer); liveRefresh.timer = null; }
    liveRefresh.lastSeenVersion = null;
    liveRefresh.pendingApply = false;
  }

  var channelNameCompose = {open:false, busy:false};
  function closeChannelNameFlow(){
    channelNameCompose.open = false;
    channelNameCompose.busy = false;
    var overlay = el('#channelNameOverlay'), drawer = el('#channelNameDrawer');
    if(overlay) overlay.classList.remove('open');
    if(drawer) drawer.classList.remove('open');
  }
  function createNamedChannel(){
    var input = el('#channelNameInput');
    var name = input ? input.value.trim() : '';
    if(!name || channelNameCompose.busy) return;
    var existingRoom = (chatWs.rooms.departments || []).filter(function(room){
      return String(room.department || room.name || '').toLowerCase() === name.toLowerCase();
    })[0];
    if(existingRoom){ closeChannelNameFlow(); selectDepartmentRoom(existingRoom, name).catch(function(){}); return; }
    channelNameCompose.busy = true;
    var create = el('#channelNameCreate');
    if(create){ create.disabled = true; create.textContent = 'Creating…'; }
    // A channel is a conversation, not an organization-department setting.
    // Create the authoritative conversation directly so a failed request
    // cannot leave behind a phantom sidebar row or an unrelated department.
    selectDepartmentRoom({department:name}, name).then(function(){
      closeChannelNameFlow();
      if(create){ create.disabled = false; create.textContent = 'Create'; }
    }).catch(function(){
      channelNameCompose.busy = false;
      if(create){ create.disabled = false; create.textContent = 'Create'; }
      showBenchToast('Channel was not created');
    });
  }
  function openNewChannelFlow(){
    channelNameCompose.open = true;
    channelNameCompose.busy = false;
    var overlay = el('#channelNameOverlay'), drawer = el('#channelNameDrawer'), input = el('#channelNameInput');
    if(overlay) overlay.classList.add('open');
    if(drawer) drawer.classList.add('open');
    if(input){ input.value = ''; setTimeout(function(){ input.focus(); }, 0); }
  }

  (function(){
    var overlay = el('#channelNameOverlay'), close = el('#channelNameClose'), cancel = el('#channelNameCancel'), create = el('#channelNameCreate'), input = el('#channelNameInput');
    if(overlay) overlay.addEventListener('click', closeChannelNameFlow);
    if(close) close.addEventListener('click', closeChannelNameFlow);
    if(cancel) cancel.addEventListener('click', closeChannelNameFlow);
    if(create) create.addEventListener('click', createNamedChannel);
    if(input) input.addEventListener('keydown', function(event){ if(event.key === 'Enter') createNamedChannel(); });
  })();

  function openHarnessAgentSetup(){
    loadHarnessSettings(false).then(function(settings){ openHarnessOnboarding(settings); });
  }

  /* Tools can be pinned into the sidebar header as icon-only shortcuts.
     Pins are a per-workspace convenience, so they live in localStorage. */
  var SIDEBAR_PIN_LIMIT = 4;
  var SIDEBAR_PIN_DEFAULTS = ['web-browser'];
  function sidebarPinStorageKey(){ return 'miaSidebarToolPins:' + activeWorkspaceKey; }
  function sidebarPinMenuItem(action){
    var menu = el('#chatToolsMenu');
    return menu ? menu.querySelector('[data-tools-action="' + action + '"]') : null;
  }
  function sidebarPinnable(item){
    return !!item && item.getAttribute('aria-disabled') !== 'true';
  }
  function loadSidebarPins(){
    try {
      var raw = localStorage.getItem(sidebarPinStorageKey());
      if(raw){
        var list = JSON.parse(raw);
        if(Array.isArray(list)) return list.filter(function(action){ return sidebarPinnable(sidebarPinMenuItem(action)); });
      }
    } catch(_pinStorageError) {}
    return SIDEBAR_PIN_DEFAULTS.slice();
  }
  function saveSidebarPins(pins){
    try { localStorage.setItem(sidebarPinStorageKey(), JSON.stringify(pins)); } catch(_pinStorageError) {}
  }
  function toggleSidebarPin(action){
    var pins = loadSidebarPins();
    var index = pins.indexOf(action);
    if(index >= 0) pins.splice(index, 1);
    else {
      if(pins.length >= SIDEBAR_PIN_LIMIT) pins.shift();
      pins.push(action);
    }
    saveSidebarPins(pins);
    renderSidebarPins();
  }
  function renderSidebarPins(){
    var host = el('#chatSidebarPins');
    if(!host) return;
    var pins = loadSidebarPins();
    host.innerHTML = '';
    pins.slice(0, SIDEBAR_PIN_LIMIT).forEach(function(action){
      var item = sidebarPinMenuItem(action);
      if(!sidebarPinnable(item)) return;
      var icon = item.querySelector('.chat-new-menu-icon');
      var label = item.querySelector('.chat-new-menu-label');
      var name = label ? label.textContent.trim() : action;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-sidebar-tool-btn chat-sidebar-pin-btn';
      btn.title = name;
      btn.setAttribute('aria-label', name);
      /* Clone the menu's canonical Lucide SVG instead of maintaining a
         second set of custom paths with different optical bounds. */
      if(icon) btn.innerHTML = icon.innerHTML;
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        var menu = el('#chatToolsMenu');
        if(menu) menu.classList.remove('open');
        syncSidebarToolButtons();
        runToolsAction(action);
      });
      host.appendChild(btn);
    });
    els('[data-tools-pin]').forEach(function(pin){
      var owner = pin.closest('[data-tools-action]');
      var pinned = !!owner && pins.indexOf(owner.getAttribute('data-tools-action')) >= 0;
      pin.classList.toggle('pinned', pinned);
      pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      pin.setAttribute('aria-label', pinned ? 'Unpin from sidebar' : 'Pin to sidebar');
      pin.title = pinned ? 'Unpin from sidebar' : 'Pin to sidebar';
    });
  }
  function closeBrowserSidebarDrawer(){
    if(!document.body.classList.contains('browser-sidebar-open')) return;
    document.body.classList.remove('browser-sidebar-open');
    var sidebar = el('#localBrowserSidebarBtn');
    if(sidebar){
      sidebar.setAttribute('aria-expanded', 'false');
      sidebar.setAttribute('aria-label', 'Open your bots');
    }
  }
  function runToolsAction(action){
    // A tool action is a destination choice: collapse the browser-mode
    // sidebar drawer so the destination (browser page or side pane) is
    // immediately visible instead of staying covered by the drawer.
    closeBrowserSidebarDrawer();
    // Bot creation renders into the same side chat pane browser-collab-mode
    // already uses for agent/bot conversations, so it doesn't need the full
    // layout back — closing the browser here would kill browser mode for no
    // reason. Every other tools-menu action still needs the full layout.
    if(localBrowserState.open && action !== 'web-browser' && action !== 'new-bot' && action !== 'bot-store') closeLocalBrowser();
    if(action === 'new-chat') openDmCompose();
    else if(action === 'new-bot') startAgentSetupChat();
    else if(action === 'new-agent') openHarnessAgentSetup();
    else if(action === 'new-channel') openNewChannelFlow();
    else if(action === 'bot-store') openBotStorePane();
    else if(action === 'connected-apps') openPluginPane();
    else if(action === 'automations') openAutomationsFromTools();
    else if(action === 'web-browser') openWebBrowserTool();
  }

  /* The header has one action menu; every item delegates to its existing
     owning flow so creation and connector handlers remain single-sourced. */
  (function(){
    var toolsBtn = el('#chatSidebarToolsBtn');
    var menu = el('#chatToolsMenu');
    if(!toolsBtn || !menu) return;
    function closeMenu(){ menu.classList.remove('open'); syncSidebarToolButtons(); }
    els('[data-tools-action]', menu).forEach(function(item){
      if(!sidebarPinnable(item)) return;
      var pin = document.createElement('span');
      pin.className = 'chat-tools-pin';
      pin.setAttribute('data-tools-pin', '');
      pin.setAttribute('role', 'button');
      pin.setAttribute('tabindex', '0');
      pin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"></path><path d="M12 14v6"></path></svg>';
      pin.addEventListener('click', function(e){
        e.stopPropagation();
        toggleSidebarPin(item.getAttribute('data-tools-action'));
      });
      pin.addEventListener('keydown', function(e){
        if(e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarPin(item.getAttribute('data-tools-action'));
      });
      item.appendChild(pin);
    });
    renderSidebarPins();
    toolsBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var developerMenu = el('#chatDeveloperMenu');
      if(developerMenu) developerMenu.classList.remove('open');
      menu.classList.toggle('open');
      syncSidebarToolButtons();
    });
    document.addEventListener('click', function(e){
      if(menu.classList.contains('open') && !menu.contains(e.target) && e.target !== toolsBtn) closeMenu();
    });
    menu.addEventListener('click', function(e){
      var item = e.target.closest('[data-tools-action]');
      if(!item) return;
      var action = item.getAttribute('data-tools-action');
      closeMenu();
      if(item.getAttribute('aria-disabled') === 'true') return;
      runToolsAction(action);
    });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && menu.classList.contains('open')) closeMenu(); });
  })();

  (function(){
    var button = el('#chatSidebarDeveloperBtn');
    var menu = el('#chatDeveloperMenu');
    var themeSelect = el('#settingsThemeMode');
    if(themeSelect) themeSelect.addEventListener('change', function(){
      var dark = themeSelect.value === 'dark';
      try { localStorage.setItem(THEME_MODE_KEY, dark ? 'dark' : 'light'); } catch(_themeStorageError) {}
      // Theme switches are instant for now: the light↔dark transition video
      // is parked (pass {animate:true} again once a better version exists).
      if(dark) activateDeveloperMode();
      else deactivateDeveloperMode();
      syncDeveloperModeUI();
    });
    if(button && menu){
      function closeMenu(){ menu.classList.remove('open'); syncSidebarToolButtons(); }
      button.addEventListener('click', function(event){
        event.stopPropagation();
        var toolsMenu = el('#chatToolsMenu');
        if(toolsMenu) toolsMenu.classList.remove('open');
        menu.classList.toggle('open');
        syncSidebarToolButtons();
      });
      menu.addEventListener('click', function(event){
        var item = event.target.closest('[data-developer-action]');
        if(!item) return;
        var action = item.getAttribute('data-developer-action');
        closeMenu();
        if(action === 'diagnostics') toggleAppDevPanel(true);
        else if(action === 'clean-slate') cleanSlateSoloWorkspace();
      });
      document.addEventListener('click', function(event){
        if(menu.classList.contains('open') && !menu.contains(event.target) && event.target !== button) closeMenu();
      });
      document.addEventListener('keydown', function(event){ if(event.key === 'Escape' && menu.classList.contains('open')) closeMenu(); });
    }
    syncDeveloperModeUI();
  })();

  (function(){
    var toggle = el('#workspaceSwitcherToggle');
    var menu = el('#workspaceSwitcherMenu');
    if(!toggle || !menu) return;
    function closeMenu(){
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', function(event){
      event.stopPropagation();
      var open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    els('[data-workspace-key]').forEach(function(option){
      option.addEventListener('click', function(){
        var key = option.getAttribute('data-workspace-key');
        var workspace = WORKSPACE_OPTIONS[key];
        if(!workspace) return;
        if(key === activeWorkspaceKey){ closeMenu(); return; }
        activateWorkspace(key);
        closeMenu();
        setAppLoading(true);
        // A workspace owns several independent module caches (native rooms,
        // bots, departments, pinned state, sockets). Reloading from the new
        // persisted scope is the smallest atomic switch: no response started
        // in the previous workspace can repaint into the next one.
        location.reload();
      });
    });
    document.addEventListener('click', function(event){
      if(menu.classList.contains('open') && !menu.contains(event.target) && event.target !== toggle) closeMenu();
    });
    document.addEventListener('keydown', function(event){
      if(event.key === 'Escape' && menu.classList.contains('open')) closeMenu();
    });
    renderWorkspaceSwitcher();
  })();

  (function(){
    var back = el('#chatBackBtn');
    if(back) back.addEventListener('click', function(e){
      e.stopPropagation();
      chatGoBack();
    });
    var manageAgents = el('#chatSidebarManageAgentsBtn');
    if(manageAgents) manageAgents.addEventListener('click', function(e){
      e.stopPropagation();
      if(chatInfo.mode === 'agents' && chatInfo.open) closeManageAgentsPane();
      else openManageAgentsPane();
      syncSidebarToolButtons();
    });
  })();

  // The account and Connectors rows replace the hidden Mia topbar controls in
  // the styled shell. Keep the original logout handler as the single source
  // of truth so auth behavior stays unchanged.
  (function(){
    var account = el('#chatAcctBtn');
    var menu = el('#chatAcctMenu');
    var admin = el('#chatAcctAdmin');
    if(account && menu){
      account.addEventListener('click', function(e){
        e.stopPropagation();
        var open = menu.classList.toggle('open');
        account.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', function(e){
        if(menu.classList.contains('open') && !menu.contains(e.target) && !account.contains(e.target)){
          menu.classList.remove('open');
          account.setAttribute('aria-expanded', 'false');
        }
      });
    }
    if(admin) admin.addEventListener('click', function(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      if(activeWorkspaceKey !== 'multiplayer_test') return;
      location.href = '/admin?workspace=multiplayer_test';
    });
    var manageAgentsBack = el('#styledAgentAdminBack');
    if(manageAgentsBack) manageAgentsBack.addEventListener('click', function(){
      location.hash = '#/chat';
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && (chatInfo.mode === 'agents' || chatInfo.mode === 'agent-edit' || chatInfo.mode === 'bot-store')){
        if(chatInfo.mode === 'agent-edit') closeCinema();
        else if(chatInfo.mode === 'bot-store') closeBotStorePane();
        else
        closeManageAgentsPane();
      }
    });
    if(menu){
      els('[data-chat-acct-toast]', menu).forEach(function(item){
        item.addEventListener('click', function(){
          menu.classList.remove('open');
          if(account) account.setAttribute('aria-expanded', 'false');
          showBenchToast(item.getAttribute('data-chat-acct-toast'));
        });
      });
    }
    var feedback = el('#chatAcctFeedback');
    if(feedback) feedback.addEventListener('click', function(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      prepareBetaFeedback();
    });
    var aboutBtn = el('#chatAcctAbout');
    var aboutOverlay = el('#aboutOverlay');
    var aboutDialog = el('#aboutDialog');
    var aboutClose = el('#aboutClose');
    function closeAbout(){
      if(aboutOverlay) aboutOverlay.classList.remove('open');
      if(aboutDialog) aboutDialog.classList.remove('open');
      document.body.classList.remove('native-browser-occluded-about');
    }
    function openAbout(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      if(aboutOverlay) aboutOverlay.classList.add('open');
      if(aboutDialog) aboutDialog.classList.add('open');
      document.body.classList.add('native-browser-occluded-about');
      if(aboutClose) aboutClose.focus();
    }
    if(aboutBtn) aboutBtn.addEventListener('click', openAbout);
    if(aboutClose) aboutClose.addEventListener('click', closeAbout);
    if(aboutOverlay) aboutOverlay.addEventListener('click', closeAbout);
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && aboutDialog && aboutDialog.classList.contains('open')){
        closeAbout();
        if(aboutBtn) aboutBtn.focus();
      }
    });
    var logout = el('#chatAcctLogout');
    if(logout) logout.addEventListener('click', function(){
      var original = el('#logoutBtn');
      if(original) original.click();
    });
    // Connected apps is available from the same compact account surface as
    // the browser and bot tools. The connector itself owns provider auth.
    var backToChat = el('#styledIntegrationsBack');
    if(backToChat) backToChat.addEventListener('click', closePluginPane);
    var settingsBtn = el('#chatAcctSettings');
    if(settingsBtn) settingsBtn.addEventListener('click', function(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      openSettingsDrawer();
    });
    var notifications = el('#chatAcctNotifications');
    if(notifications) notifications.addEventListener('click', function(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      requestDesktopNotifications();
    });
    var setup = el('#chatAcctSetup');
    if(setup) setup.addEventListener('click', function(){
      if(menu) menu.classList.remove('open');
      if(account) account.setAttribute('aria-expanded', 'false');
      openHarnessOnboarding(harnessSettingsCache);
    });
    syncDesktopNotificationControl();
  })();

  /* ============ STYLED: Hermes connector catalog ============ */
  (function(){
    var grid = el('#hermesConnectorGrid');
    var search = el('#hermesConnectorSearch');
    var category = el('#hermesConnectorCategory');
    var count = el('#hermesConnectorCount');
    var empty = el('#hermesConnectorEmpty');
    var GOOGLE_ACCOUNT_ID = 'skill-google-workspace';
    var googleAccountStatus = {state:'loading', connected:false, canStart:false};
    var googleAccountPanelOpen = false;
    var googleAccountFeedback = '';
    var googleAccountPollTimer = null;
    var googleAccountPollAttempts = 0;
    if(!grid || !search || !category) return;
    var catalog = window.MIA_HERMES_CONNECTORS;
    if(!catalog || !Array.isArray(catalog.entries)){
      if(count) count.textContent = 'The connector catalog could not be loaded. Reload to try again.';
      search.disabled = true;
      category.disabled = true;
      return;
    }
    var clientCopy = catalog.clientCopy || {};
    var entryNames = clientCopy.entryNames || {};
    var categoryLabels = clientCopy.categoryLabels || {};
    var descriptionTemplates = clientCopy.descriptions || {};
    var connectionCatalog = catalog.connections || {};
    var iconCatalog = catalog.icons || {};
    var defaultIcon = catalog.defaultIcon || 'assets/icons/plugins-network.png';
    var hiddenIds = {};
    var hiddenEntryIds = catalog.curation && Array.isArray(catalog.curation.hiddenEntryIds)
      ? catalog.curation.hiddenEntryIds : [];
    var visibleEntryIds = catalog.curation && Array.isArray(catalog.curation.visibleEntryIds)
      ? catalog.curation.visibleEntryIds : null;
    hiddenEntryIds.forEach(function(id){ hiddenIds[id] = true; });
    var entries = catalog.entries.filter(function(entry){ return (!visibleEntryIds || visibleEntryIds.indexOf(entry.id) !== -1) && !hiddenIds[entry.id]; })
      .slice().sort(function(a, b){ return a.name.localeCompare(b.name); });
    var categories = [];
    entries.forEach(function(entry){
      if(categories.indexOf(entry.category) === -1) categories.push(entry.category);
    });
    categories.sort().forEach(function(name){
      var option = document.createElement('option');
      option.value = name;
      option.textContent = categoryLabels[name] || name;
      category.appendChild(option);
    });

    function clientCategory(entry){
      return categoryLabels[entry.category] || entry.category;
    }

    function clientName(entry){
      return entryNames[entry.id] || entry.name;
    }

    function clientDescription(entry){
      var template = descriptionTemplates[entry.category] || 'Add {name} to the workflows your team chooses.';
      return template.replace(/\{name\}/g, clientName(entry));
    }

    function connectionFor(entry){
      var connection = connectionCatalog[entry.id];
      return connection && connection.mode === 'direct' ? connection : null;
    }

    function iconAssetsFor(entry){
      var assets = iconCatalog[entry.id];
      if(!Array.isArray(assets)) assets = assets ? [assets] : [];
      return assets.length ? assets : [defaultIcon];
    }

    function connectorIcon(entry){
      var assets = iconAssetsFor(entry);
      var clusterClass = assets.length > 1 ? ' hermes-connector-icon-cluster' : '';
      return '<span class="styled-connector-icon styled-connector-icon--asset' + clusterClass + '" aria-hidden="true">' +
        assets.map(function(src){ return '<img src="' + esc(src) + '" alt="" />'; }).join('') +
        '</span>';
    }

    function googleAccountStatusLabel(){
      var state = googleAccountStatus.state;
      if(state === 'not_connected' && googleAccountStatus.canStart === false) return 'Unavailable';
      if(state === 'connected') return 'Connected';
      if(state === 'awaiting_approval' || state === 'starting') return 'Connecting';
      if(state === 'needs_reconnect') return 'Reconnect';
      if(state === 'unavailable' || state === 'setup_required') return 'Unavailable';
      if(state === 'connection_error') return 'Connection unavailable';
      if(state === 'loading') return 'Checking';
      return 'Not connected';
    }

    function googleAccountPanel(entry, panelId){
      var state = googleAccountStatus.state;
      var connected = state === 'connected';
      var pending = state === 'awaiting_approval' || state === 'starting';
      var checking = state === 'loading';
      var unavailable = state === 'unavailable' || state === 'setup_required' || (state === 'not_connected' && googleAccountStatus.canStart === false);
      var statusClass = connected ? ' connected' : (unavailable || state === 'connection_error' ? ' error' : '');
      var body = connected
        ? 'Your Google Account is connected securely. Mia can use the Google content you approved.'
        : pending
          ? 'Finish signing in and approving access in the Google tab. Mia will return to Connected apps when it is ready.'
          : unavailable
            ? 'Direct Google connection is not available in this Mia environment yet.'
              : state === 'needs_reconnect'
                ? 'Reconnect your Google Account and approve access again so Mia can continue.'
                : state === 'connection_error'
                  ? 'Mia could not verify this connection. Try again.'
                  : 'Mia will open Google so you can sign in and approve access, then return here.';
      var actions = '';
      if(connected){
        actions = '<button type="button" class="hermes-connector-copy" data-google-account-action="check">Check connection</button>' +
          '<button type="button" class="hermes-connector-cancel" data-google-account-action="disconnect">Disconnect</button>';
      } else if(pending){
        actions = '<button type="button" class="hermes-connector-copy" data-google-account-action="check">Check connection</button>' +
          '<button type="button" class="hermes-connector-cancel" data-google-account-action="start">Open Google again</button>';
      } else if(!unavailable){
        actions = '<button type="button" class="hermes-connector-copy" data-google-account-action="start">Connect with Google</button>' +
          '<button type="button" class="hermes-connector-cancel" data-google-account-action="check">Check status</button>';
      }
      var actionLabel = connected ? 'Manage' : pending ? 'Connecting…' : checking ? 'Checking…' : unavailable ? 'Unavailable' : state === 'needs_reconnect' ? 'Reconnect' : 'Connect';
      var trigger = connected || pending ? 'toggle' : 'start';
      var actionButton = unavailable || checking
        ? '<button type="button" class="hermes-connector-setup hermes-connector-setup--disabled" disabled aria-disabled="true">' + actionLabel + '</button>'
        : '<button type="button" class="hermes-connector-setup" data-google-account-action="' + trigger + '" aria-expanded="' + (googleAccountPanelOpen ? 'true' : 'false') + '" aria-controls="' + esc(panelId) + '"' + (pending ? ' disabled' : '') + '>' + actionLabel + '</button>';
      return '<article class="hermes-connector hermes-google-account" data-hermes-connector="' + GOOGLE_ACCOUNT_ID + '">' +
        '<div class="styled-connector-item">' + connectorIcon(entry) +
        '<span class="styled-connector-copy"><span class="styled-connector-name">Google Account <span class="styled-connector-status' + statusClass + '">' + esc(googleAccountStatusLabel()) + '</span></span>' +
        '<span class="hermes-connector-category">' + esc(clientCategory(entry)) + '</span>' +
        '<span class="styled-connector-desc">Connect Gmail, Calendar, Drive, Contacts, Docs, Sheets, and Slides with one secure sign-in.</span></span>' +
        actionButton + '</div>' +
        '<section class="hermes-connector-setup-panel" id="' + esc(panelId) + '" tabindex="-1"' + (googleAccountPanelOpen ? '' : ' hidden') + '>' +
        '<h3>' + esc(googleAccountStatusLabel()) + '</h3><p>' + esc(body) + '</p>' +
        '<p class="hermes-connector-setup-note"><strong>Access requested:</strong> Gmail, Calendar, Drive, Contacts, Docs, Sheets, and Slides. Delete, clear, and trash actions are blocked.</p>' +
        (actions ? '<div class="hermes-connector-setup-actions">' + actions + '</div>' : '') +
        '<p class="hermes-connector-setup-feedback" data-google-account-feedback aria-live="polite">' + esc(googleAccountFeedback) + '</p></section></article>';
    }

    function renderConnectors(){
      var query = search.value.trim().toLowerCase();
      var matches = entries.filter(function(entry){
        return (!category.value || entry.category === category.value)
          && (!query || [clientName(entry), entry.name, clientDescription(entry), clientCategory(entry), entry.description].join(' ').toLowerCase().indexOf(query) !== -1);
      });
      if(count) count.textContent = matches.length === entries.length
        ? entries.length + ' apps'
        : matches.length + ' of ' + entries.length + ' apps';
      if(empty) empty.hidden = matches.length > 0;
      grid.innerHTML = matches.map(function(entry){
        var panelId = 'hermesConnectorSetup-' + entry.id.replace(/[^A-Za-z0-9_-]/g, '-');
        if(entry.id === GOOGLE_ACCOUNT_ID && connectionFor(entry)) return googleAccountPanel(entry, panelId);
        return '<article class="hermes-connector" data-hermes-connector="' + esc(entry.id) + '">' +
          '<div class="styled-connector-item">' + connectorIcon(entry) +
          '<span class="styled-connector-copy"><span class="styled-connector-name">' + esc(clientName(entry)) + '</span>' +
          '<span class="hermes-connector-category">' + esc(clientCategory(entry)) + '</span>' +
          '<span class="styled-connector-desc">' + esc(clientDescription(entry)) + '</span></span>' +
          '<span class="hermes-connector-unavailable">Unavailable</span></div>' +
          '<p class="hermes-connector-unavailable-copy">Direct connection is not available in Mia for this capability yet.</p></article>';
      }).join('');
    }

    function setGoogleAccountStatus(data, feedback, preservePending){
      var next = data && typeof data === 'object' ? data : {state:'connection_error', connected:false};
      if(preservePending && googleAccountStatus.state === 'awaiting_approval' && !next.connected && (next.state === 'not_connected' || next.state === 'setup_required')){
        next = Object.assign({}, next, {state:'awaiting_approval'});
      }
      googleAccountStatus = next;
      if(typeof feedback === 'string') googleAccountFeedback = feedback;
      renderConnectors();
      if(next.connected && googleAccountPollTimer){
        clearTimeout(googleAccountPollTimer);
        googleAccountPollTimer = null;
      }
    }

    function loadGoogleAccountStatus(feedback, preservePending){
      return api('/api/connections/google/account').then(function(res){
        setGoogleAccountStatus(res.data, feedback, preservePending);
        return res.data;
      }).catch(function(){
        setGoogleAccountStatus({state:'connection_error', connected:false}, feedback || 'Connection status could not be checked.');
        return null;
      });
    }

    function pollGoogleAccountStatus(){
      if(googleAccountPollTimer) clearTimeout(googleAccountPollTimer);
      googleAccountPollAttempts = 0;
      function poll(){
        googleAccountPollAttempts += 1;
        loadGoogleAccountStatus('', true).then(function(data){
          if(data && data.connected) return;
          if(googleAccountPollAttempts >= 48){
            googleAccountFeedback = 'Sign-in is still pending. Finish in Google, then choose Check connection.';
            renderConnectors();
            googleAccountPollTimer = null;
            return;
          }
          googleAccountPollTimer = setTimeout(poll, 2500);
        });
      }
      googleAccountPollTimer = setTimeout(poll, 1500);
    }

    function startGoogleAccountConnection(){
      var popup = null;
      var nativeBrowser = window.miaNativeBrowser;
      if(!nativeBrowser){
        try { popup = window.open('about:blank', '_blank'); } catch(_error) { popup = null; }
      }
      googleAccountPanelOpen = true;
      setGoogleAccountStatus(Object.assign({}, googleAccountStatus, {state:'starting'}), 'Preparing secure Google sign-in…');
      api('/api/connections/google/account/start', {method:'POST'}).then(function(res){
        var data = res.data || {};
        if(data.authorizationUrl){
          if(nativeBrowser){
            openWebBrowserTool();
            nativeBrowser.openTab(data.authorizationUrl);
          } else if(popup){
            try { popup.opener = null; popup.location.replace(data.authorizationUrl); } catch(_error) {}
          } else {
            window.open(data.authorizationUrl, '_blank', 'noopener');
          }
          setGoogleAccountStatus(data, 'Complete sign-in in the Google tab. Mia will update when it finishes.');
          pollGoogleAccountStatus();
          return;
        }
        if(popup) try { popup.close(); } catch(_error) {}
        setGoogleAccountStatus(data, data.state === 'unavailable'
          ? 'Direct Google connection is not available in this Mia environment yet.'
          : data.state === 'setup_required'
            ? 'Direct Google connection is not available in this Mia environment yet.'
            : 'Google sign-in could not be started.');
      }).catch(function(){
        if(popup) try { popup.close(); } catch(_error) {}
        setGoogleAccountStatus({state:'connection_error', connected:false}, 'Google sign-in could not be started.');
      });
    }

    grid.addEventListener('click', function(event){
      var googleButton = event.target.closest('[data-google-account-action]');
      if(googleButton && grid.contains(googleButton)){
        var action = googleButton.getAttribute('data-google-account-action');
        if(action === 'toggle'){
          googleAccountPanelOpen = !googleAccountPanelOpen;
          renderConnectors();
          if(googleAccountPanelOpen) loadGoogleAccountStatus();
          return;
        }
        if(action === 'start'){
          startGoogleAccountConnection();
          return;
        }
        if(action === 'check'){
          googleAccountFeedback = 'Checking your Google connection…';
          renderConnectors();
          api('/api/connections/google/account/test', {method:'POST'}).then(function(res){
            setGoogleAccountStatus(res.data, res.data && res.data.connected ? 'Connection verified.' : 'Google is not connected yet.');
          }).catch(function(){
            setGoogleAccountStatus({state:'connection_error', connected:false}, 'Connection status could not be checked.');
          });
          return;
        }
        if(action === 'disconnect'){
          if(!window.confirm('Disconnect this Google Account from Mia?')) return;
          googleAccountFeedback = 'Disconnecting…';
          renderConnectors();
          api('/api/connections/google/account/disconnect', {method:'POST'}).then(function(res){
            setGoogleAccountStatus(res.data, res.data && res.data.state === 'connection_error' ? 'Google Account could not be disconnected.' : 'Google Account disconnected.');
          }).catch(function(){
            setGoogleAccountStatus({state:'connection_error', connected:false}, 'Google Account could not be disconnected.');
          });
          return;
        }
      }
    });
    search.addEventListener('input', renderConnectors);
    category.addEventListener('change', renderConnectors);
    renderConnectors();
    loadGoogleAccountStatus();
  })();

  /* ============ CHAT: conversation history + creation drawer ============
     History and creation intentionally share one small surface. Conversation
     storage, membership, and pinning remain owned by the existing native
     primitives; this is only a clearer way to reach them. */
  var conversationDrawer = {mode: 'history', tab: 'chats', agentId: null, scopeKey: null, agentMenuOpen: false};
  var dmCompose = {open: false, humans: [], agents: [], selected: {}, query: '', busy: false};
  var freshBotConversationRequest = null;

  function conversationHistoryAgentIds(conversation){
    var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
    var ids = {};
    function add(value){
      var id = String(value || '').trim();
      if(id) ids[id] = true;
    }
    add(metadata.botId || metadata.agentId);
    (metadata.members || []).forEach(function(member){
      if(!member || (member.kind !== 'agent' && member.principalType !== 'agent' && member.principalType !== 'bot')) return;
      add(member.agentId || member.principalId || member.id);
    });
    return Object.keys(ids);
  }

  function activeConversationHistoryAgentId(){
    var roomId = chatWs.activeRoomId;
    var state = roomId && chatWs.byRoom[roomId];
    if(state && state.selectedAgentId) return String(state.selectedAgentId);
    var conversation = (chatWs.nativeConversations || []).filter(function(item){ return item.id === roomId; })[0];
    var directIds = conversationHistoryAgentIds(conversation);
    if((conversation && (conversation.type === 'agent' || conversation.type === 'bot')) && directIds.length) return directIds[0];
    var messages = state && state.messages || [];
    for(var index = messages.length - 1; index >= 0; index--){
      var event = messages[index] && messages[index].nativeEvent;
      if(event && (event.senderType === 'agent' || event.senderType === 'bot') && event.senderId) return String(event.senderId);
    }
    return directIds.length === 1 ? directIds[0] : null;
  }

  function syncConversationHistoryScope(){
    var activeAgentId = activeConversationHistoryAgentId();
    var scopeKey = activeWorkspaceKey + ':' + String(chatWs.activeRoomId || '') + ':' + String(activeAgentId || 'all');
    if(conversationDrawer.scopeKey !== scopeKey){
      conversationDrawer.scopeKey = scopeKey;
      conversationDrawer.agentId = activeAgentId || 'all';
      conversationDrawer.agentMenuOpen = false;
    }
  }

  function conversationHistoryAgentOptions(){
    var options = [];
    var seen = {};
    function add(id, name){
      id = String(id || '').trim();
      if(!id || seen[id]) return;
      seen[id] = true;
      options.push({id:id, name:String(name || id)});
    }
    if(chatWs.gatewayAgent) add('gateway', chatWs.gatewayAgent.name || 'Mia');
    (chatWs.allAgents || []).forEach(function(agent){ add(agent.id, agent.name); });
    (chatWs.nativeConversations || []).forEach(function(conversation){
      conversationHistoryAgentIds(conversation).forEach(function(id){
        var metadata = conversation.metadata || {};
        add(id, conversation.type === 'agent' || conversation.type === 'bot' ? (conversation.name || metadata.name) : id);
      });
    });
    return options.sort(function(left, right){ return left.name.localeCompare(right.name); });
  }

  function conversationMatchesHistoryAgent(conversation, agentId){
    return agentId === 'all' || conversationHistoryAgentIds(conversation).indexOf(String(agentId || '')) !== -1;
  }

  function conversationHistoryRowAgent(conversation, selectedAgentId){
    var ids = conversationHistoryAgentIds(conversation);
    if(!ids.length) return null;
    var id = selectedAgentId !== 'all' && ids.indexOf(String(selectedAgentId || '')) !== -1 ? String(selectedAgentId) : null;
    var state = conversation && chatWs.byRoom[conversation.id];
    var messages = state && state.messages || [];
    if(!id){
      for(var index = messages.length - 1; index >= 0; index--){
        var event = messages[index] && messages[index].nativeEvent;
        if(event && (event.senderType === 'agent' || event.senderType === 'bot') && ids.indexOf(String(event.senderId || '')) !== -1){
          id = String(event.senderId);
          break;
        }
      }
    }
    id = id || ids[0];
    var option = conversationHistoryAgentOptions().filter(function(candidate){ return candidate.id === id; })[0];
    return {id:id, name:option && option.name || conversation.name || id};
  }

  function renderConversationHistoryAgentFilter(){
    syncConversationHistoryScope();
    var button = el('#conversationHistoryAgentButton');
    var menu = el('#conversationHistoryAgentMenu');
    if(!button || !menu) return;
    var options = conversationHistoryAgentOptions();
    var selected = options.filter(function(option){ return option.id === conversationDrawer.agentId; })[0] || null;
    var selectedName = selected ? selected.name : 'All bots and agents';
    button.innerHTML = selected
      ? agentAvatarHtml(selected.name, selected.id, 24, null, null, false)
      : '<span class="conversation-history-agent-all" aria-hidden="true">ALL</span>';
    button.setAttribute('aria-label', 'Filter history: ' + selectedName);
    button.setAttribute('aria-expanded', conversationDrawer.agentMenuOpen ? 'true' : 'false');
    menu.hidden = !conversationDrawer.agentMenuOpen;
    menu.innerHTML = [{id:'all', name:'All bots and agents'}].concat(options).map(function(option){
      var active = option.id === conversationDrawer.agentId;
      var avatar = option.id === 'all' ? '<span class="conversation-history-agent-all">ALL</span>' : agentAvatarHtml(option.name, option.id, 24, null, null, false);
      return '<button type="button" class="conversation-history-agent-option" data-history-agent-id="' + esc(option.id) + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '">' +
        '<span class="conversation-history-agent-option-avatar">' + avatar + '</span><span>' + esc(option.name) + '</span></button>';
    }).join('');
  }

  function renderConversationHeaderActions(){
    var pinned = isChatPinned('room:' + chatWs.activeRoomId);
    var activeConversation = (chatWs.nativeConversations || []).filter(function(item){ return item.id === chatWs.activeRoomId; })[0] || null;
    var activeMetadata = activeConversation && activeConversation.metadata || {};
    var canCreateFreshBotConversation = !!activeConversation && activeConversation.type === 'bot' && !!activeMetadata.botId;
    var freshDisabled = !canCreateFreshBotConversation || !!freshBotConversationRequest;
    var freshTitle = canCreateFreshBotConversation
      ? (freshBotConversationRequest ? 'Creating a new conversation…' : 'New conversation with this bot')
      : (isNativeMiaConversation(activeConversation) ? 'Mia uses one continuous conversation' : 'Open a bot chat to start another conversation');
    // Canonical Lucide v0.545.0 geometry. Keep this set together so these
    // adjacent actions share one optical grid instead of drifting as custom
    // paths are edited independently.
    return '<div class="conversation-header-actions" role="group" aria-label="Conversation actions">' +
      '<button type="button" class="ch-icon-btn conversation-action-btn" id="chatShareConversation" title="Copy conversation ID" aria-label="Copy conversation ID"><svg data-icon-set="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v13"></path><path d="m16 6-4-4-4 4"></path><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path></svg></button>' +
      '<button type="button" class="ch-icon-btn conversation-action-btn' + (pinned ? ' active' : '') + '" id="chatBookmarkConversation" title="' + (pinned ? 'Remove bookmark' : 'Bookmark conversation') + '" aria-label="' + (pinned ? 'Remove bookmark' : 'Bookmark conversation') + '" aria-pressed="' + (pinned ? 'true' : 'false') + '"><svg data-icon-set="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path></svg></button>' +
      '<button type="button" class="ch-icon-btn conversation-action-btn" id="chatHistoryBtn" title="History" aria-label="Open conversation history"><svg data-icon-set="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg></button>' +
      '<button type="button" class="ch-icon-btn conversation-action-btn" id="chatNewConversationBtn" title="' + esc(freshTitle) + '" aria-label="' + esc(freshTitle) + '"' + (freshDisabled ? ' disabled' : '') + '><svg data-icon-set="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path></svg></button>' +
    '</div>';
  }

  function createFreshConversationForActiveBot(){
    if(freshBotConversationRequest) return freshBotConversationRequest.promise;
    var source = (chatWs.nativeConversations || []).filter(function(item){ return item.id === chatWs.activeRoomId; })[0] || null;
    var metadata = source && source.metadata || {};
    if(!source || source.type !== 'bot' || !metadata.botId) return Promise.resolve(null);
    var requestedWorkspace = activeWorkspaceKey;
    var requestedRoomId = source.id;
    var request = {
      roomId: requestedRoomId,
      workspace: requestedWorkspace,
      promise: null
    };
    freshBotConversationRequest = request;
    request.promise = api(nativeConversationPath(requestedRoomId, '/fresh'), {method:'POST', body:{}}).then(function(res){
      if((res.status !== 201 && res.status !== 200) || !res.data || !res.data.conversation){
        throw new Error(res.data && (res.data.message || res.data.error) || 'Could not create a new conversation.');
      }
      var conversation = res.data.conversation;
      if(activeWorkspaceKey !== requestedWorkspace || chatWs.activeRoomId !== requestedRoomId) return conversation;
      if(!(chatWs.nativeConversations || []).some(function(item){ return item.id === conversation.id; })){
        chatWs.nativeConversations.push(conversation);
      }
      applyNativeConversationList(chatWs.nativeConversations);
      renderChatSidebar();
      loadChatRoom(conversation.id, 'agent', conversation.name || source.name || 'Bot');
      return conversation;
    }).catch(function(error){
      if(activeWorkspaceKey === requestedWorkspace && chatWs.activeRoomId === requestedRoomId){
        showBenchToast(error && error.message ? error.message : 'Could not create a new conversation.');
      }
      return null;
    }).then(function(conversation){
      if(freshBotConversationRequest === request) freshBotConversationRequest = null;
      if(activeWorkspaceKey === requestedWorkspace) renderChatHeaderBar();
      return conversation;
    });
    renderChatHeaderBar();
    return request.promise;
  }

  function wireConversationHeaderActions(header){
    var share = el('#chatShareConversation', header);
    var bookmark = el('#chatBookmarkConversation', header);
    var history = el('#chatHistoryBtn', header);
    var create = el('#chatNewConversationBtn', header);
    if(share) share.addEventListener('click', function(){
      copySidebarText(chatWs.activeRoomId, 'Conversation ID copied');
    });
    if(bookmark) bookmark.addEventListener('click', function(){
      var key = 'room:' + chatWs.activeRoomId;
      setChatPinned(key, !isChatPinned(key));
      renderChatHeaderBar();
      if(dmCompose.open && conversationDrawer.mode === 'history') renderConversationHistory();
    });
    if(history) history.addEventListener('click', function(){ openConversationHistory('chats'); });
    if(create) create.addEventListener('click', createFreshConversationForActiveBot);
  }

  function openConversationDrawer(mode){
    conversationDrawer.mode = mode;
    dmCompose.open = true;
    var overlay = el('#dmComposeOverlay'), drawer = el('#dmComposeDrawer');
    var historyView = el('#conversationHistoryView'), composeView = el('#conversationComposeView');
    var actions = el('#conversationComposeActions'), title = el('#conversationDrawerTitle');
    var composing = mode === 'compose';
    if(title) title.textContent = composing ? 'New conversation' : 'History';
    if(historyView) historyView.hidden = composing;
    if(composeView) composeView.hidden = !composing;
    if(actions) actions.hidden = !composing;
    if(overlay) overlay.classList.add('open');
    if(drawer) drawer.classList.add('open');
    document.body.classList.add('native-browser-occluded-conversation');
    if(!composing) renderConversationHistory();
  }

  function openConversationHistory(tab){
    conversationDrawer.tab = tab || conversationDrawer.tab || 'chats';
    openConversationDrawer('history');
  }

  function conversationHistoryLabel(conversation){
    var room = nativeConversationToRoom(conversation);
    return room.kind === 'dm' || room.kind === 'group' ? dmLabel(room) : room.name;
  }

  function conversationHistoryTimestamp(conversation){
    var state = conversation && chatWs.byRoom[conversation.id];
    return Math.max(
      Number(state && state.lastTs) || 0,
      Date.parse(conversation && conversation.updatedAt || '') || 0,
      Date.parse(conversation && conversation.createdAt || '') || 0
    );
  }

  function conversationHistoryDay(timestamp){
    var day = new Date(timestamp || Date.now());
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var itemStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    var days = Math.round((start - itemStart) / 86400000);
    if(days === 0) return 'Today';
    if(days === 1) return 'Yesterday';
    if(days > 1 && days < 7) return day.toLocaleDateString(undefined, {weekday:'long'});
    return day.toLocaleDateString(undefined, {month:'short', day:'numeric', year:day.getFullYear() === now.getFullYear() ? undefined : 'numeric'});
  }

  function conversationHistoryEmpty(tab){
    if(tab === 'bookmarks') return 'Bookmark a conversation to keep it here.';
    if(tab === 'images') return 'Images from conversations you open will appear here.';
    return 'No conversations yet.';
  }

  function renderConversationHistory(){
    var list = el('#conversationHistoryList');
    if(!list) return;
    renderConversationHistoryAgentFilter();
    var tab = conversationDrawer.tab || 'chats';
    var agentId = conversationDrawer.agentId || 'all';
    els('[data-conversation-tab]').forEach(function(button){
      var active = button.getAttribute('data-conversation-tab') === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if(tab === 'images'){
      var images = [];
      Object.keys(chatWs.byRoom || {}).forEach(function(roomId){
        var conversation = (chatWs.nativeConversations || []).filter(function(item){ return item.id === roomId; })[0];
        if(!conversation || !conversationMatchesHistoryAgent(conversation, agentId)) return;
        var state = chatWs.byRoom[roomId];
        (state.messages || []).forEach(function(message){
          (message.attachments || []).forEach(function(attachment){
            if(String(attachment.mimeType || '').indexOf('image/') !== 0) return;
            images.push({roomId:roomId, attachment:attachment, ts:message.ts || 0});
          });
        });
      });
      images.sort(function(a, b){ return b.ts - a.ts; });
      list.innerHTML = images.length ? '<div class="conversation-image-grid">' + images.map(function(item){
        return '<button type="button" class="conversation-image-card" data-history-room-id="' + esc(item.roomId) + '" title="Open conversation"><img src="' + esc(item.attachment.previewUrl || item.attachment.url) + '" alt="' + esc(item.attachment.filename || 'Conversation image') + '" loading="lazy" /></button>';
      }).join('') + '</div>' : '<div class="conversation-history-empty">' + conversationHistoryEmpty(tab) + '</div>';
    } else {
      var conversations = (chatWs.nativeConversations || []).slice().filter(function(conversation){
        return conversationMatchesHistoryAgent(conversation, agentId) && (tab !== 'bookmarks' || isChatPinned('room:' + conversation.id));
      }).sort(function(a, b){ return conversationHistoryTimestamp(b) - conversationHistoryTimestamp(a); });
      var currentGroup = '';
      list.innerHTML = conversations.length ? conversations.map(function(conversation){
        var timestamp = conversationHistoryTimestamp(conversation);
        var group = conversationHistoryDay(timestamp);
        var heading = group !== currentGroup ? '<h3 class="conversation-history-day">' + esc(group) + '</h3>' : '';
        currentGroup = group;
        var active = conversation.id === chatWs.activeRoomId;
        var bookmarked = isChatPinned('room:' + conversation.id);
        var rowAgent = conversationHistoryRowAgent(conversation, agentId);
        return heading + '<button type="button" class="conversation-history-row' + (active ? ' active' : '') + '" data-history-room-id="' + esc(conversation.id) + '">' +
          '<span class="conversation-history-name">' + esc(conversationHistoryLabel(conversation)) + '</span>' +
          (bookmarked ? '<svg class="conversation-history-bookmark" viewBox="0 0 24 24" aria-label="Bookmarked"><path d="M6.5 4.5h11v15l-5.5-3.5-5.5 3.5z"></path></svg>' : '') +
          (rowAgent ? '<span class="conversation-history-row-agent" title="' + esc(rowAgent.name) + '">' + agentAvatarHtml(rowAgent.name, rowAgent.id, 26, null, null, false) + '</span>' : '') +
        '</button>';
      }).join('') : '<div class="conversation-history-empty">' + conversationHistoryEmpty(tab) + '</div>';
    }
    els('[data-history-room-id]', list).forEach(function(row){
      row.addEventListener('click', function(){
        var id = row.getAttribute('data-history-room-id');
        var conversation = (chatWs.nativeConversations || []).filter(function(item){ return item.id === id; })[0];
        if(!conversation) return;
        var room = nativeConversationToRoom(conversation);
        closeDmCompose();
        loadChatRoom(room.roomId, room.kind, conversationHistoryLabel(conversation));
      });
    });
  }

  function openDmCompose(){
    dmCompose.selected = {};
    dmCompose.query = '';
    dmCompose.busy = false;
    var nameInput = el('#dmComposeName');
    if(nameInput) nameInput.value = '';
    var searchInput = el('#dmComposeSearch');
    if(searchInput) searchInput.value = '';
    openConversationDrawer('compose');
    renderDmComposeList();
    Promise.all([loadHumanDirectoryResponse(), api('/api/bots')]).then(function(results){
      var usersRes = results[0], agentsRes = results[1];
      if(usersRes.status !== 200 || agentsRes.status !== 200) return;
      dmCompose.humans = humanDirectoryUsersForWorkspace(activeWorkspaceKey, (usersRes.data && usersRes.data.users) || []);
      dmCompose.humans.forEach(function(h){ mergeUserProfile(h.email, h); });
      dmCompose.agents = (agentsRes.data && agentsRes.data.bots) || [];
      if(dmCompose.open) renderDmComposeList();
    }).catch(function(){});
  }
  function closeDmCompose(){
    dmCompose.open = false;
    var overlay = el('#dmComposeOverlay'), drawer = el('#dmComposeDrawer');
    if(overlay) overlay.classList.remove('open');
    if(drawer) drawer.classList.remove('open');
    document.body.classList.remove('native-browser-occluded-conversation');
  }
  function dmComposeSelectedCount(){
    return Object.keys(dmCompose.selected).length;
  }
  function renderDmComposeList(){
    var wrap = el('#dmComposeList');
    if(!wrap) return;
    var q = dmCompose.query.toLowerCase();
    var humanRows = dmCompose.humans
      .filter(function(h){ return h.email !== currentUser; })
      .filter(function(h){ return humanDirectoryMatches(h, q); })
      .map(function(h){
        var key = 'human:' + h.email;
        var checked = !!dmCompose.selected[key];
        return '<button type="button" class="dm-compose-row' + (checked ? ' checked' : '') + '" data-dm-key="' + esc(key) + '"><span class="dm-avatar">' + humanAvatarInitialsHtml(h.email) + '</span><span class="dm-compose-row-label">' + esc(displayNameForEmail(h.email)) + '</span><span class="dm-compose-row-check">' + (checked ? '&#10003;' : '') + '</span></button>';
      });
    var agentRows = dmCompose.agents
      .filter(function(a){ return !q || a.name.toLowerCase().indexOf(q) !== -1; })
      .map(function(a){
        var key = 'agent:' + a.id;
        var checked = !!dmCompose.selected[key];
        var kind = a.id === 'gateway' ? 'Agent' : 'Bot';
        return '<button type="button" class="dm-compose-row' + (checked ? ' checked' : '') + '" data-dm-key="' + esc(key) + '"><span class="dm-avatar">' + esc(benchMark(a.name)) + '</span><span class="dm-compose-row-label">' + esc(a.name) + ' <span class="dm-compose-row-kind">' + kind + '</span></span><span class="dm-compose-row-check">' + (checked ? '&#10003;' : '') + '</span></button>';
      });
    var html = '';
    html += '<div class="cmp-section-label">PEOPLE</div>';
    html += humanRows.length ? humanRows.join('') : '<div class="cmp-empty">no matches</div>';
    html += '<div class="cmp-section-label">AGENTS &amp; BOTS</div>';
    html += agentRows.length ? agentRows.join('') : '<div class="cmp-empty">no matches</div>';
    wrap.innerHTML = html;
    els('.dm-compose-row', wrap).forEach(function(row){
      row.addEventListener('click', function(){
        var key = row.getAttribute('data-dm-key');
        if(dmCompose.selected[key]) delete dmCompose.selected[key];
        else dmCompose.selected[key] = true;
        renderDmComposeList();
      });
    });
    updateDmComposeCreateBtn();
  }
  function updateDmComposeCreateBtn(){
    var btn = el('#dmComposeCreate');
    if(!btn) return;
    var count = dmComposeSelectedCount();
    btn.disabled = count === 0 || dmCompose.busy;
    btn.textContent = dmCompose.busy ? 'Creating…' : 'Create';
  }
  function dmComposeCreate(){
    var count = dmComposeSelectedCount();
    if(!count || dmCompose.busy) return;
    var members = Object.keys(dmCompose.selected).map(function(key){
      var ix = key.indexOf(':');
      var kind = key.slice(0, ix), value = key.slice(ix + 1);
      return kind === 'human' ? {kind: 'human', email: value} : {kind: 'agent', agentId: value};
    });
    var nameInput = el('#dmComposeName');
    var name = nameInput ? nameInput.value.trim() : '';
    dmCompose.busy = true;
    updateDmComposeCreateBtn();
    createNativeGroupConversation(members, name).then(function(conversation){
      dmCompose.busy = false;
      chatWs.nativeConversations.push(conversation);
      applyNativeConversationList(chatWs.nativeConversations);
      closeDmCompose();
      renderChatSidebar();
      loadChatRoom(conversation.id, 'group', dmLabel(nativeConversationToRoom(conversation)));
    }).catch(function(){
      dmCompose.busy = false;
      updateDmComposeCreateBtn();
    });
  }
  (function(){
    var overlay = el('#dmComposeOverlay');
    var closeBtn = el('#dmComposeClose');
    var cancelBtn = el('#dmComposeCancel');
    var createBtn = el('#dmComposeCreate');
    var searchInput = el('#dmComposeSearch');
    var tabs = els('[data-conversation-tab]');
    var agentButton = el('#conversationHistoryAgentButton');
    var agentMenu = el('#conversationHistoryAgentMenu');
    if(overlay) overlay.addEventListener('click', function(event){
      event.preventDefault();
      event.stopPropagation();
      closeDmCompose();
    });
    if(closeBtn) closeBtn.addEventListener('click', closeDmCompose);
    if(cancelBtn) cancelBtn.addEventListener('click', closeDmCompose);
    if(createBtn) createBtn.addEventListener('click', dmComposeCreate);
    if(searchInput) searchInput.addEventListener('input', function(){
      dmCompose.query = searchInput.value.trim();
      renderDmComposeList();
    });
    tabs.forEach(function(tab){
      tab.addEventListener('click', function(){
        conversationDrawer.tab = tab.getAttribute('data-conversation-tab') || 'chats';
        renderConversationHistory();
      });
    });
    if(agentButton) agentButton.addEventListener('click', function(){
      conversationDrawer.agentMenuOpen = !conversationDrawer.agentMenuOpen;
      renderConversationHistoryAgentFilter();
    });
    if(agentMenu) agentMenu.addEventListener('click', function(event){
      var option = event.target.closest('[data-history-agent-id]');
      if(!option || !agentMenu.contains(option)) return;
      conversationDrawer.agentId = option.getAttribute('data-history-agent-id') || 'all';
      conversationDrawer.agentMenuOpen = false;
      renderConversationHistory();
    });
  })();

  /* ============ CHAT: quick "+" direct-message popover (DIRECT MESSAGES header) ============
     A lighter alternative to the "+ New chat" drawer above: click the "+"
     next to "Direct messages", type a name/email, pick a human. One click,
     one person, no group name / multi-select — for that, "+ New chat" ->
     Direct message is still there through the native conversation endpoint.
     (members: [{kind:'human', email}]), which already dedupes to an
     existing 1:1 room instead of creating a duplicate. */
  var chatDmAdd = {open: false, humans: [], query: '', highlight: 0, busy: false};

  function chatDmAddMatches(){
    var q = chatDmAdd.query.trim().toLowerCase();
    return humanDirectoryUsersForWorkspace(activeWorkspaceKey, chatDmAdd.humans).filter(function(h){ return h.email !== currentUser; }).filter(function(h){
      return humanDirectoryMatches(h, q);
    });
  }

  function renderChatDmAddList(){
    var list = el('#chatDmAddList');
    if(!list) return;
    var matches = chatDmAddMatches();
    if(chatDmAdd.highlight >= matches.length) chatDmAdd.highlight = 0;
    list.innerHTML = matches.length ? matches.map(function(h, i){
      var highlighted = i === chatDmAdd.highlight ? ' highlighted' : '';
      return '<button type="button" class="cmp-option' + highlighted + '" data-dm-add-ix="' + i + '"><span class="dm-avatar">' + humanAvatarInitialsHtml(h.email) + '</span>' + esc(displayNameForEmail(h.email)) + '</button>';
    }).join('') : '<div class="cmp-empty">no matches</div>';
    els('[data-dm-add-ix]', list).forEach(function(btn){
      btn.addEventListener('mousedown', function(e){
        e.preventDefault(); // keep focus on the search input, matching the mention popover's own click handling
        selectChatDmAdd(matches[parseInt(btn.getAttribute('data-dm-add-ix'), 10)]);
      });
    });
  }

  function openChatDmAddPopover(){
    chatDmAdd.open = true;
    chatDmAdd.query = '';
    chatDmAdd.highlight = 0;
    var pop = el('#chatDmAddPopover');
    if(pop) pop.classList.add('open');
    var input = el('#chatDmAddInput');
    if(input){ input.value = ''; setTimeout(function(){ input.focus(); }, 0); }
    renderChatDmAddList();
    loadHumanDirectoryResponse().then(function(res){
      if(res.status !== 200 || !chatDmAdd.open) return;
      chatDmAdd.humans = humanDirectoryUsersForWorkspace(activeWorkspaceKey, (res.data && res.data.users) || []);
      chatDmAdd.humans.forEach(function(h){ mergeUserProfile(h.email, h); });
      renderChatDmAddList();
    }).catch(function(){});
  }

  function closeChatDmAddPopover(){
    chatDmAdd.open = false;
    var pop = el('#chatDmAddPopover');
    if(pop) pop.classList.remove('open');
  }

  function selectChatDmAdd(h){
    if(!h || chatDmAdd.busy) return;
    chatDmAdd.busy = true;
    createNativeDirectConversation(h.email).then(function(conversation){
      chatDmAdd.busy = false;
      closeChatDmAddPopover();
      chatWs.nativeConversations.push(conversation);
      applyNativeConversationList(chatWs.nativeConversations);
      clearChatActive();
      renderChatSidebar();
      loadChatRoom(conversation.id, 'dm', dmLabel(nativeConversationToRoom(conversation)));
    }).catch(function(){ chatDmAdd.busy = false; });
  }

  (function(){
    var btn = el('#chatDmAddBtn');
    var pop = el('#chatDmAddPopover');
    var input = el('#chatDmAddInput');
    if(!btn || !pop) return;
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      if(chatDmAdd.open) closeChatDmAddPopover(); else openChatDmAddPopover();
    });
    if(input){
      input.addEventListener('input', function(){
        chatDmAdd.query = input.value;
        chatDmAdd.highlight = 0;
        renderChatDmAddList();
      });
      input.addEventListener('keydown', function(e){
        var matches = chatDmAddMatches();
        if(e.key === 'ArrowDown'){ e.preventDefault(); chatDmAdd.highlight = Math.min(chatDmAdd.highlight + 1, matches.length - 1); renderChatDmAddList(); }
        else if(e.key === 'ArrowUp'){ e.preventDefault(); chatDmAdd.highlight = Math.max(chatDmAdd.highlight - 1, 0); renderChatDmAddList(); }
        else if(e.key === 'Enter'){ e.preventDefault(); if(matches[chatDmAdd.highlight]) selectChatDmAdd(matches[chatDmAdd.highlight]); }
        else if(e.key === 'Escape'){ e.preventDefault(); closeChatDmAddPopover(); }
      });
    }
    document.addEventListener('click', function(e){
      if(chatDmAdd.open && !pop.contains(e.target) && e.target !== btn) closeChatDmAddPopover();
    });
  })();

  (function(){
    var input = el('#ccInput');
    var sendBtn = el('#ccSend');
    var plusBtn = el('#ccPlusBtn');
    var fileInput = el('#ccFileInput');
    var attachStrip = el('#ccAttachStrip');
    var hint = el('#ccHint');
    var defaultHint = hint ? hint.textContent : '';
    if(!input || !sendBtn) return;
    function submit(){
      if(!chatWs.activeRoomId) return;
      var text = input.value.trim();
      var file = chatAttachment.file;
      if((!text && !file) || chatAttachment.busy) return;
      setLocalChatTypingActivity(false);
      function reallySend(){
        closeMentionPopover();
        if(!file){
          input.value = '';
          syncDraftState();
          sendActiveRoomMessage(text);
          return;
        }
        if(chatWs.activeKind === 'agent-setup'){
          chatAttachment.error = 'Finish creating the agent before attaching an image.';
          renderChatAttachment();
          return;
        }
        var roomId = chatWs.activeRoomId;
        chatAttachment.busy = true;
        chatAttachment.error = '';
        renderChatAttachment();
        syncDraftState();
        prepareChatAttachment(file, roomId, null).then(function(prepared){
          if(input.value.trim() === text) input.value = '';
          return sendActiveRoomMessage(text, null, prepared, roomId).then(function(result){
            if(result && (result.status === 200 || result.status === 201)){
              clearChatAttachment();
            } else {
              chatAttachment.busy = false;
              chatAttachment.error = result && result.data && result.data.error || 'Message send failed.';
              if(!input.value) input.value = text;
              renderChatAttachment();
            }
            syncDraftState();
          });
        }).catch(function(err){
          chatAttachment.busy = false;
          chatAttachment.error = err && err.message || 'Image upload failed.';
          renderChatAttachment();
          syncDraftState();
        });
      }
      // Group tags reach many people at once — confirm the blast radius
      // first. Cancel keeps the draft in the composer untouched.
      var counts = groupTagCounts(text);
      if(counts && (counts.agents || counts.humans)){ openGroupSendConfirm(counts, reallySend); return; }
      reallySend();
    }
    // Send lights up (and the hint swaps to how-to-send) only once there's
    // a real draft — mirrors the mock's sendStyle/hint being keyed off
    // state.draft.trim(), not a permanent enabled state.
    function syncDraftState(){
      var hasDraft = !!input.value.trim() || !!chatAttachment.file;
      var task = activeRoomTask();
      var stopping = !!(task && (task.status === 'stopping' || chatTaskStopPending[task.id]));
      sendBtn.classList.toggle('has-draft', hasDraft);
      sendBtn.disabled = !chatWs.activeRoomId || !!chatAttachment.busy || stopping;
      if(hint) hint.textContent = hasDraft ? 'Enter to send' : defaultHint;
      syncInlineChatSuggestion();
      renderComposerTaskControl();
      setLocalChatTypingActivity(!!input.value.trim() && document.activeElement === input);
    }
    if(plusBtn && fileInput){
      plusBtn.addEventListener('click', function(){
        if(chatWs.activeRoomId && !chatAttachment.busy) fileInput.click();
      });
      fileInput.addEventListener('change', function(){
        if(stageChatAttachment(fileInput.files && fileInput.files[0])) syncDraftState();
      });
    }
    if(attachStrip){
      attachStrip.addEventListener('click', function(e){
        if(e.target.closest('.cc-attach-remove') && !chatAttachment.busy){
          clearChatAttachment();
          syncDraftState();
        }
      });
    }
    input.addEventListener('paste', function(e){
      var items = e.clipboardData && e.clipboardData.items;
      if(!items) return;
      for(var i = 0; i < items.length; i++){
        if(items[i].kind === 'file' && /^image\//.test(items[i].type || '')){
          var pasted = items[i].getAsFile();
          if(pasted && stageChatAttachment(pasted)) syncDraftState();
          break;
        }
      }
    });
    input.addEventListener('input', syncDraftState);
    input.addEventListener('focus', syncDraftState);
    input.addEventListener('blur', function(){ setLocalChatTypingActivity(false); });
    sendBtn.addEventListener('click', function(){
      var taskId = sendBtn.getAttribute('data-stop-task-id');
      if(taskId){ stopTaskFromComposer(taskId); return; }
      submit();
    });
    input.addEventListener('keydown', function(e){
      if(chatMentionHandleKeydown(e)) return;
      if(e.key === 'Tab' && !input.value.trim()){
        var suggestion = el('#ccInlineSuggestion');
        if(suggestion && !suggestion.hidden){
          e.preventDefault();
          input.value = chatInlineSuggestionText();
          syncDraftState();
          input.focus();
          return;
        }
      }
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); submit(); }
    });
    syncDraftState();
    renderComposerTaskControl();
  })();

  // Thread pill (↳ N replies · last …) under a root message's body — a
  // plain click, unrelated to the right-click context menu below.
  (function(){
    var thread = el('#chatThread');
    if(!thread) return;
    thread.addEventListener('click', function(e){
      var pill = e.target.closest('[data-thread-toggle]');
      if(pill) openChatThread(pill.getAttribute('data-root-id'));
    });
  })();

  // Mote avatars in chat open the matching agent profile. The click is
  // delegated because the timeline and docked thread are rebuilt as messages
  // arrive; the header is delegated for the same reason. Roster Motes use the
  // styled profile editor for every editable bot, while Mia retains the
  // general Agents & Bots surface.
  (function(){
    function resolveAgent(profileRef, profileName){
      var agent = findBenchAgent(profileRef) || findBenchAgentByServerId(profileRef);
      if(!agent && profileName){
        var wanted = String(profileName).trim().toLowerCase();
        agent = benchAgents.filter(function(item){ return String(item.name || '').trim().toLowerCase() === wanted; })[0] || null;
      }
      if(!agent){
        var wantedId = String(profileRef || '').trim();
        var wantedName = String(profileName || '').trim().toLowerCase();
        var record = (chatWs.allAgents || []).filter(function(item){
          return (wantedId && String(item.id || '') === wantedId) ||
            (wantedName && String(item.name || '').trim().toLowerCase() === wantedName);
        })[0] || null;
        agent = cacheBenchAgent(benchAgentFromApiRecord(record));
      }
      return agent;
    }
    function openProfile(target){
      var profileRef = target.getAttribute('data-agent-profile-id');
      var profileName = target.getAttribute('data-agent-profile-name');
      var agent = resolveAgent(profileRef, profileName);
      agentEditFocusReturn = target;
      // Opening the editor from the browser's "Your bots" drawer is a
      // destination choice like picking a chat, so tuck the drawer away —
      // otherwise it sits on top of the browser next to the editor it just
      // opened, covering the page for no reason.
      if(document.body.classList.contains('browser-sidebar-open')){
        document.body.classList.remove('browser-sidebar-open');
        var sidebarBtn = el('#localBrowserSidebarBtn');
        if(sidebarBtn){ sidebarBtn.setAttribute('aria-expanded', 'false'); sidebarBtn.setAttribute('aria-label', 'Open your bots'); }
      }
      if(agent){
        closeChatThread();
        closeChatTasksPanel();
        closeChatUtilityPane();
        if(styledAgentEditPaneAvailable() && agent.id !== 'gateway'){
          openEditCinema(agent.id);
          renderChatHeaderBar();
          return;
        }
        openManageAgentsPane();
        return;
      }
      // A first-load message can arrive before the agent roster. Refresh the
      // roster once, then resolve by the same stable reference/name.
      loadBenchAgents().then(function(){
        var refreshed = resolveAgent(profileRef, profileName);
        if(refreshed){
          closeChatThread();
          closeChatTasksPanel();
          closeChatUtilityPane();
          if(styledAgentEditPaneAvailable() && refreshed.id !== 'gateway'){
            openEditCinema(refreshed.id);
            renderChatHeaderBar();
            return;
          }
          openManageAgentsPane();
        }
      });
    }
    function bind(container, useCapture){
      if(!container) return;
      container.addEventListener('click', function(e){
        var target = e.target && e.target.closest ? e.target.closest('[data-agent-profile-id][role="button"]') : null;
        if(!target || !container.contains(target)) return;
        e.preventDefault();
        e.stopPropagation();
        openProfile(target);
      }, useCapture);
      container.addEventListener('keydown', function(e){
        if(e.key !== 'Enter' && e.key !== ' ') return;
        var target = e.target && e.target.closest ? e.target.closest('[data-agent-profile-id][role="button"]') : null;
        if(!target || !container.contains(target)) return;
        e.preventDefault();
        e.stopPropagation();
        openProfile(target);
      }, useCapture);
    }
    // Bound on document, in the CAPTURE phase, so every surface that renders
    // an interactive Mote — chat timeline, docked thread, header, roster
    // panel, manage-agents pane, tiles — opens the matching profile surface
    // without each surface needing its own listener. Capture matters: some
    // of those Motes sit inside a larger clickable row/button (manage-agent
    // row, roster row, DM tile) that navigates elsewhere on click. Capturing
    // at document and calling stopPropagation() before the event ever
    // reaches that row's own bubble-phase listener means the Mote click
    // wins outright instead of both handlers firing.
    bind(document, true);
  })();

  // One shared context menu serves both the main timeline
  // (#chatThread) and the docked thread panel (#ctpBody); being a singleton,
  // only one can ever be open. Each row already carries data-can-thread /
  // data-can-delete / data-can-edit (set by chatMsgHtml from showThreadAction /
  // chatMsgDeletable / chatMsgEditable), so opening the menu never re-derives permissions —
  // it just reads what the row already says and dispatches to the exact
  // same handlers the old buttons called.
  (function(){
    var menu = el('#chatCtxMenu');
    var editItem = el('#chatCtxEdit');
    var threadItem = el('#chatCtxThread');
    var deleteItem = el('#chatCtxDelete');
    if(!menu || !editItem || !threadItem || !deleteItem) return;
    var openEventId = null;

    function closeMenu(){
      if(menu.hidden) return false;
      menu.hidden = true;
      openEventId = null;
      return true;
    }

    function openMenuFor(row, x, y){
      var canThread = row.getAttribute('data-can-thread') === '1';
      var canDelete = row.getAttribute('data-can-delete') === '1';
      var canEdit = row.getAttribute('data-can-edit') === '1';
      if(!canThread && !canDelete && !canEdit) return; // nothing to offer — leave the browser's own menu alone
      openEventId = row.getAttribute('data-event-id');
      editItem.style.display = canEdit ? '' : 'none';
      threadItem.style.display = canThread ? '' : 'none';
      deleteItem.style.display = canDelete ? '' : 'none';
      menu.hidden = false;
      // Clamp so it never renders off the right/bottom edge of the viewport.
      var w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    }

    function handleContextMenu(e){
      var row = e.target.closest('.chat-msg-row');
      if(!row) return;
      // Preserve the browser's native selection/copy menu when the user has
      // already selected text inside a prompt, especially on touch browsers.
      var selection = window.getSelection && window.getSelection();
      if(selection && selection.toString()) return;
      e.preventDefault();
      openMenuFor(row, e.clientX, e.clientY);
    }
    var thread = el('#chatThread');
    if(thread) thread.addEventListener('contextmenu', handleContextMenu);
    var ctpBody = el('#ctpBody');
    if(ctpBody) ctpBody.addEventListener('contextmenu', handleContextMenu);

    editItem.addEventListener('click', function(){
      var id = openEventId;
      closeMenu();
      if(id) handleEditChatMessage(id);
    });
    threadItem.addEventListener('click', function(){
      var id = openEventId;
      closeMenu();
      if(id) openChatThread(id);
    });
    deleteItem.addEventListener('click', function(){
      var id = openEventId;
      closeMenu();
      if(id) handleDeleteChatMessage(id);
    });

    // Close on click-away, a second right-click elsewhere, scroll (the
    // menu's screen position would otherwise go stale — capture:true so
    // this catches #chatThread/#ctpBody's own overflow scroll, not just
    // window scroll), or Esc (folded into the shared Escape handler below).
    document.addEventListener('click', function(e){
      if(!menu.hidden && !menu.contains(e.target)) closeMenu();
    });
    document.addEventListener('contextmenu', function(e){
      if(!menu.hidden && !e.target.closest('.chat-msg-row')) closeMenu();
    });
    document.addEventListener('scroll', closeMenu, true);
    chatCtxMenuClose = closeMenu;
  })();

  // Docked thread panel: X/Esc close it, its root+replies region reuses the
  // same right-click context menu as the main timeline (delegated above, on
  // #ctpBody), and its composer sends via the same
  // sendActiveRoomMessage(text, rootId) path as any other room send,
  // addressed at whichever root is currently open.
  (function(){
    var closeBtn = el('#ctpCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', closeChatThread);
    var input = el('#ctpComposerInput');
    if(input) input.addEventListener('keydown', function(e){
      if(e.key !== 'Enter') return;
      e.preventDefault();
      var text = input.value.trim();
      var roomId = chatWs.activeRoomId;
      var state = roomId && chatRoomState(roomId);
      var rootId = state && state.openThreadRoot;
      if(!text || !rootId) return;
      input.value = '';
      sendActiveRoomMessage(text, rootId);
    });
  })();

  (function(){
    var closeBtn = el('#ctskCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', closeChatTasksPanel);
  })();

  // Thread/tasks panel width is user-draggable via the .ctp-resize handle on
  // the panel's left edge. One width for both panels (they occupy the same
  // slot), remembered per browser in localStorage.
  (function(){
    var MIN_W = 300, MAX_W = 680, KEY = 'miaosThreadPanelW';
    function applyPanelWidth(w){
      els('.chat-thread-panel').forEach(function(p){
        p.style.flexBasis = w + 'px';
        p.style.width = w + 'px';
      });
    }
    // The styled skin starts from its CSS width (~35% of the screen), then
    // lets a saved drag override it when the user has resized the panel.
    var handleEl = el('[data-ctp-resize]');
    var draggable = !!handleEl && getComputedStyle(handleEl).display !== 'none';
    var saved = parseInt(localStorage.getItem(KEY), 10);
    if(saved && draggable) applyPanelWidth(Math.min(MAX_W, Math.max(MIN_W, saved)));
    els('[data-ctp-resize]').forEach(function(handle){
      handle.addEventListener('mousedown', function(e){
        e.preventDefault();
        var startX = e.clientX;
        var startW = handle.parentElement.getBoundingClientRect().width;
        var w = startW;
        function onMove(ev){
          w = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)));
          applyPanelWidth(w);
        }
        function onUp(){
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('ctp-resizing');
          localStorage.setItem(KEY, String(Math.round(w)));
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.classList.add('ctp-resizing');
      });
    });
  })();

  // The styled shell's left navigation is user-resizable and remembers its width. The
  // pointer path works for both a mouse drag and a touch drag on a compact
  // laptop/tablet viewport; the handle itself owns touch-action:none so it
  // never turns a resize gesture into page scrolling.
  (function(){
    // Default comes from the 20% CSS share. Once the user drags, keep the
    // chosen pixel width under a versioned key so an older 320px preference
    // cannot override the new proportional layout.
    var MIN_W = 180, MAX_W = 480, KEY = 'styledSidebarW:v3';
    function applySidebarWidth(w){
      w = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
      document.documentElement.style.setProperty('--sand-sidebar-width', w + 'px');
      return w;
    }
    var saved = parseInt(localStorage.getItem(KEY), 10);
    if(saved) applySidebarWidth(saved);
    els('[data-chat-sidebar-resize]').forEach(function(handle){
      handle.addEventListener('pointerdown', function(e){
        if(e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        var startX = e.clientX;
        var sidebar = handle.parentElement;
        var startW = sidebar.getBoundingClientRect().width;
        var width = startW;
        document.body.classList.add('chat-sidebar-resizing');
        if(handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
        function onMove(ev){
          width = applySidebarWidth(startW + ev.clientX - startX);
        }
        function onEnd(){
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onEnd);
          document.removeEventListener('pointercancel', onEnd);
          document.body.classList.remove('chat-sidebar-resizing');
          localStorage.setItem(KEY, String(width));
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onEnd);
        document.addEventListener('pointercancel', onEnd);
      });
    });
  })();

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closeChatThread(); closeChatTasksPanel(); if(chatCtxMenuClose) chatCtxMenuClose(); if(chatSidebarCtxMenuClose) chatSidebarCtxMenuClose(); }
  });

  /* ============ CHAT: mic dictation (interactive-mock, Claude.ai-style composer) ============ */
  (function(){
    var micBtn = el('#ccMicBtn');
    var pill = el('#ccRecordingPill');
    if(!micBtn) return;
    var recording = false;
    micBtn.addEventListener('click', function(){
      recording = !recording;
      micBtn.classList.toggle('recording', recording);
      if(pill) pill.classList.toggle('visible', recording);
    });
  })();

  /* ============ CHAT: connected model picker ============
     The picker is deliberately per-turn. It reads Hermes' authenticated
     inventory, walks model family -> variant -> reasoning effort -> speed,
     and sends the completed choice in native event metadata. It never writes
     the saved harness preference or invents a provider/model locally. */
  (function(){
    var btn = el('#ccModelBtn');
    var menu = el('#ccModelMenu');
    var optionsWrap = el('#ccModelOptions');
    var title = el('#ccModelMenuTitle');
    var back = el('#ccModelBack');
    var tags = el('#ccModelTags');
    var selectionSummary = el('#ccModelSelection');
    var pickerRoot = el('#ccModelSelect');
    if(!btn || !menu || !optionsWrap || !title || !back || !tags || !pickerRoot) return;

    var picker = chatModelPicker;
    var effortLabels = {none:'None', low:'Low', medium:'Medium', high:'High', xhigh:'Extra high', max:'Max', ultra:'Ultra'};

    // The "Choose a model family" back screen lists every provider offered by
    // initial setup (harnessProviderChoices in index.html), not just whatever
    // happens to be connected. Connection state and the connect flow itself
    // are the same ones setup uses (harnessConnectionState, openHarnessOnboarding,
    // the [data-harness-provider] choices and #harnessApiProvider select) — no
    // new state is invented here.
    // Claude and Gemini get no rows of their own: neither vendor allows
    // third-party apps on their consumer CLI subscriptions, so they connect
    // through the one generic API row (see operations/product.md).
    var COMPOSER_FAMILY_PROVIDERS = [
      {id:'managed-router', label:'Mia Router', harnessProvider:'managed-router', aliases:['managed-router', 'openrouter']},
      {id:'claude-subscription-directsdk-experimental', label:'Claude', harnessProvider:'claude-subscription-directsdk-experimental', aliases:['claude-subscription-directsdk-experimental']},
      {id:'openai-codex', label:'ChatGPT', harnessProvider:'openai-codex', aliases:['openai-codex', 'codex']},
      {id:'xai-oauth', label:'Grok', harnessProvider:'xai-oauth', aliases:['xai-oauth', 'xai', 'grok']},
      {id:'api', label:'API', harnessProvider:'openai-api', aliases:['openai-api', 'anthropic', 'gemini', 'openai', 'deepseek']}
    ];

    function familyProviderAliasMatch(providerId, aliases){
      var actual = String(providerId || '').toLowerCase();
      return aliases.indexOf(actual) !== -1;
    }

    function familyProviderConnected(row){
      // The picker's own inventory (already fetched for this menu) is the
      // most reliable signal — it only ever lists providers Hermes reports as
      // configured. harnessConnectionState is a secondary fallback: it is
      // only populated once Settings → Access or onboarding has loaded, so it
      // can lag or start out all-false on a fresh app session.
      if(familyProviderEntries(row).length) return true;
      if(harnessConnectionState[row.id] === true) return true;
      // Mia Router is stored under the Hermes provider id 'openrouter'.
      if(row.id === 'managed-router' && harnessConnectionState['openrouter'] === true) return true;
      return false;
    }

    function familyProviderEntries(row){
      return entries().filter(function(item){ return familyProviderAliasMatch(item.provider, row.aliases); });
    }

    // The active row mirrors what the composer pill is actually showing right
    // now (the per-turn cached choice, falling back to the saved harness
    // default) rather than picker.selection, which goBack() clears on its way
    // back up to this screen.
    function activeFamilyProviderId(){
      var cached = readCachedChatModelSelection();
      if(cached && cached.provider) return cached.provider;
      var current = currentEntry(entries());
      return current && current.provider;
    }

    // Opens the exact same connect flow initial setup uses: the onboarding
    // sheet, its [data-harness-provider] choice, and (for API-key providers)
    // its #harnessApiProvider select — triggered the same way a user's own
    // click would.
    function openConnectFlowForProvider(row){
      closeMenu();
      openHarnessOnboarding(harnessSettingsCache);
      var choice = el('[data-harness-provider="' + row.harnessProvider + '"]');
      if(choice) choice.click();
      if(row.apiProvider){
        var apiProviderSelect = el('#harnessApiProvider');
        if(apiProviderSelect){
          apiProviderSelect.value = row.apiProvider;
          var changeEvent;
          try { changeEvent = new Event('change', {bubbles:true}); } catch(_){ changeEvent = document.createEvent('Event'); changeEvent.initEvent('change', true, true); }
          apiProviderSelect.dispatchEvent(changeEvent);
        }
      }
    }

    function titleCase(value){ return chatModelTitleCase(value); }

    function modelParts(model){ return chatModelParts(model); }

    function providerMatches(id){
      var desired = String(harnessSettingsCache.provider === 'openai-api' ? harnessSettingsCache.apiProvider : harnessSettingsCache.provider || '').toLowerCase();
      var actual = String(id || '').toLowerCase();
      return actual === desired || (desired === 'openai-api' && actual === 'openai') || (desired === 'xai-oauth' && actual === 'xai');
    }

    function entries(){ return chatConnectedModelEntries(); }

    function currentEntry(all){
      var configuredProvider = harnessSettingsCache.provider === 'openai-api' ? harnessSettingsCache.apiProvider : harnessSettingsCache.provider;
      var configuredModel = harnessSettingsCache.model;
      var match = all.filter(function(item){
        return providerMatches(item.provider) && configuredModel && String(item.model).toLowerCase() === String(configuredModel).toLowerCase();
      })[0];
      if(match) return match;
      match = all.filter(function(item){ return providerMatches(item.provider); })[0];
      return match || all[0] || null;
    }

    function setEntry(item, complete){
      if(!item) return;
      picker.selection.provider = item.provider;
      picker.selection.family = item.family;
      picker.selection.familyKey = item.familyKey;
      picker.selection.variant = complete ? item.variant : '';
      picker.selection.model = complete ? item.model : null;
      if(complete){
        // Non-reasoning models (e.g. DeepSeek) skip the effort stage entirely.
        if(item.reasoning === false){
          picker.selection.reasoningEffort = 'none';
        } else {
          picker.selection.reasoningEffort = picker.selection.reasoningEffort || 'high';
        }
        picker.selection.speed = picker.selection.speed || (item.fast && harnessSettingsCache.fast ? 'fast' : 'normal');
      } else {
        picker.selection.reasoningEffort = '';
        picker.selection.speed = '';
      }
    }

    function hydrateSelection(){
      if(picker.selection.model || !picker.providers.length) return;
      var all = entries();
      var cached = readCachedChatModelSelection();
      var item = cached && all.filter(function(candidate){
        return candidate.provider === cached.provider && candidate.model === cached.model;
      })[0];
      if(item){
        setEntry(item, true);
        // For non-reasoning models, keep the 'none' effort that setEntry
        // already applied — ignore whatever the cache had.
        if(item.reasoning !== false) picker.selection.reasoningEffort = cached.reasoningEffort;
        picker.selection.speed = cached.speed === 'fast' && !item.fast ? 'normal' : cached.speed;
        return;
      }
      item = currentEntry(all);
      setEntry(item, true);
    }

    function stage(){
      if(!picker.selection.familyKey) return 'family';
      if(!picker.selection.model) return 'variant';
      // Skip the effort stage for non-reasoning models — effort is auto-set to
      // 'none' in setEntry, so the picker proceeds directly to speed.
      var chosen = selectedEntry();
      if(!picker.selection.reasoningEffort && !(chosen && chosen.reasoning === false)) return 'effort';
      // Models without a fast tier skip the speed stage entirely — a single
      // "Normal" button is not a choice; speed is auto-set to 'normal'.
      if(!picker.selection.speed && chosen && chosen.fast === true) return 'speed';
      return 'family';
    }

    function selectedEntry(){
      return entries().filter(function(item){
        return item.provider === picker.selection.provider && item.model === picker.selection.model;
      })[0] || null;
    }

    function button(label, meta, attrs){
      return '<button type="button" class="cc-model-option" ' + attrs + '><span class="cc-model-option-label">' + esc(label) + '</span>' + (meta ? '<span class="cc-model-option-meta">' + esc(meta) + '</span>' : '') + '</button>';
    }

    function renderTags(){
      var s = picker.selection;
      var chosen = selectedEntry();
      pickerRoot.classList.toggle('is-fast', s.speed === 'fast');
      if(!s.model){
        // Settings and live inventory arrive asynchronously. Prefer the last
        // validated per-turn choice so its effort does not flash or stick at
        // the generic High fallback while inventory is still hydrating.
        var cachedSelection = readCachedChatModelSelection();
        var pendingModel = cachedSelection && cachedSelection.model || harnessSettingsCache.model;
        if(pendingModel){
          var configured = modelParts(pendingModel);
          var configuredLabel = String(configured.variant || pendingModel).replace(/^GPT (\d)/, 'GPT-$1');
          var pendingEffort = cachedSelection && cachedSelection.reasoningEffort || 'high';
          // Don't show "None" effort in the pending label either.
          if(pendingEffort && pendingEffort !== 'none'){
            tags.textContent = configuredLabel + ' ' + (effortLabels[pendingEffort] || pendingEffort);
          } else {
            tags.textContent = configuredLabel;
          }
          return;
        }
        tags.innerHTML = '<span class="cc-model-placeholder">Model</span>';
        return;
      }
      var label = chosen ? chosen.variant : (s.variant || s.model);
      if(chosen && chosen.family && String(label).toLowerCase().indexOf(String(chosen.family).toLowerCase()) !== 0){
        label = chosen.family + ' ' + label;
      }
      label = String(label || '').replace(/^GPT (\d)/, 'GPT-$1');
      // Don't show "None" in the pill — it's the implicit default for
      // non-reasoning models and just adds noise (e.g. "DeepSeek V4 Flash None").
      if(s.reasoningEffort && s.reasoningEffort !== 'none') label += ' ' + (effortLabels[s.reasoningEffort] || s.reasoningEffort);
      tags.textContent = label;
    }

    function renderOptions(){
      // The provider switcher is a transient UI-only screen, not something
      // derived from picker.selection — it only opens via an explicit back-
      // button press at the (unchanged) default family stage, and stays out
      // of the normal family -> variant -> effort -> speed derivation.
      var currentStage = picker.showProviderSwitcher ? 'providers' : stage();
      picker.stage = currentStage;
      if(!picker.loaded){
        title.textContent = picker.loading ? 'Loading connected models…' : 'Choose a model';
        optionsWrap.innerHTML = '<div class="cc-model-selection">' + esc(picker.error || 'Open the picker to load connected models.') + '</div>';
        return;
      }
      if(picker.error){
        title.textContent = 'Connected models unavailable';
        optionsWrap.innerHTML = '<div class="cc-model-selection">' + esc(picker.error) + '</div>';
        return;
      }
      var all = entries();
      // Every other stage needs an actual selected family's entries to list;
      // the provider switcher must keep working even with zero connected
      // providers, since its whole job is to offer a way to connect one.
      if(!all.length && currentStage !== 'providers'){
        title.textContent = 'Connect a model';
        optionsWrap.innerHTML = '<div class="cc-model-selection">Connect a provider in Settings → Access.</div>';
        return;
      }
      var html = '';
      if(currentStage === 'family'){
        title.textContent = 'Choose a model family';
        var families = {};
        all.forEach(function(item){
          if(!families[item.familyKey]) families[item.familyKey] = {family:item.family, providers:[], key:item.familyKey, entries:[]};
          families[item.familyKey].entries.push(item);
          if(families[item.familyKey].providers.indexOf(item.providerLabel) === -1) families[item.familyKey].providers.push(item.providerLabel);
        });
        Object.keys(families).map(function(key){ return families[key]; }).forEach(function(item){
          html += button(item.family, item.providers.join(', '), 'data-choice="family" data-family-key="' + esc(item.key) + '" data-family="' + esc(item.family) + '"');
        });
      } else if(currentStage === 'providers'){
        // Reached only by pressing back at the family stage above. Lists
        // every provider offered by initial setup, not just what's connected:
        // connected rows are ordinary, selectable model options; unconnected
        // ones are a muted row with a plain-text "Connect" affordance, kept
        // visually quiet rather than a bordered call-to-action pill.
        title.textContent = 'Switch provider';
        var activeProviderId = activeFamilyProviderId();
        COMPOSER_FAMILY_PROVIDERS.forEach(function(row){
          var connected = familyProviderConnected(row);
          var active = connected && familyProviderAliasMatch(activeProviderId, row.aliases);
          if(connected){
            html += '<button type="button" class="cc-model-option cc-model-family-option' + (active ? ' is-active' : '') + '" data-choice="family-provider" data-family-provider-id="' + esc(row.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
              '<span class="cc-model-option-label">' + esc(row.label) + '</span>' +
              '<span class="cc-model-family-check" aria-hidden="true">' + (active ? '&#10003;' : '') + '</span>' +
              '</button>';
          } else {
            html += '<div class="cc-model-option cc-model-family-option cc-model-family-static">' +
              '<span class="cc-model-option-label">' + esc(row.label) + '</span>' +
              '<button type="button" class="cc-model-connect-link" data-connect-provider-id="' + esc(row.id) + '" aria-label="Connect ' + esc(row.label) + '">Connect</button>' +
              '</div>';
          }
        });
      } else if(currentStage === 'variant'){
        title.textContent = 'Choose a ' + (picker.selection.family || 'model') + ' model';
        var activeRow = COMPOSER_FAMILY_PROVIDERS.filter(function(row){ return row.id === picker.selection.familyProviderId; })[0];
        var variantEntries = activeRow ? familyProviderEntries(activeRow) : all.filter(function(item){
          return item.familyKey === picker.selection.familyKey;
        });
        variantEntries.forEach(function(item){
          html += button(item.variant, item.providerLabel, 'data-choice="variant" data-provider="' + esc(item.provider) + '" data-model="' + esc(item.model) + '"');
        });
      } else if(currentStage === 'effort'){
        title.textContent = 'Choose reasoning effort';
        Object.keys(effortLabels).forEach(function(value){
          html += button(effortLabels[value], value === 'high' ? 'recommended' : '', 'data-choice="effort" data-effort="' + value + '"');
        });
      } else {
        title.textContent = 'Choose response speed';
        var item = selectedEntry();
        ['normal', 'fast'].filter(function(value){ return value !== 'fast' || (item && item.fast); }).forEach(function(value){
          html += button(titleCase(value), value === 'fast' ? 'priority' : 'standard', 'data-choice="speed" data-speed="' + value + '"');
        });
      }
      optionsWrap.innerHTML = html || '<div class="cc-model-selection">No connected models are available.</div>';
      els('.cc-model-option', optionsWrap).forEach(function(choice){
        choice.addEventListener('click', function(){
          var kind = choice.getAttribute('data-choice');
          if(kind === 'family'){
            picker.selection.familyKey = choice.getAttribute('data-family-key');
            picker.selection.family = choice.getAttribute('data-family');
            picker.selection.familyProviderId = '';
            picker.selection.variant = '';
            picker.selection.model = null;
            picker.selection.provider = '';
            picker.selection.reasoningEffort = '';
            picker.selection.speed = '';
          } else if(kind === 'family-provider'){
            var rowId = choice.getAttribute('data-family-provider-id');
            var row = COMPOSER_FAMILY_PROVIDERS.filter(function(candidate){ return candidate.id === rowId; })[0];
            if(!row) return;
            // Picking a provider here always drills into its own variant
            // list next, so leave the switcher screen.
            picker.showProviderSwitcher = false;
            // A truthy familyKey is only used as the stage() gate here — the
            // actual filter for the variant list below keys off
            // familyProviderId, since this row does not correspond to the old
            // inventory-derived "provider:family" grouping.
            picker.selection.familyKey = row.id;
            picker.selection.familyProviderId = row.id;
            picker.selection.family = row.label;
            picker.selection.variant = '';
            picker.selection.model = null;
            picker.selection.provider = '';
            picker.selection.reasoningEffort = '';
            picker.selection.speed = '';
          } else if(kind === 'variant'){
            var item = entries().filter(function(candidate){ return candidate.provider === choice.getAttribute('data-provider') && candidate.model === choice.getAttribute('data-model'); })[0];
            if(item) setEntry(item, true);
            // Capability-gated stages: non-reasoning models get effort 'none',
            // models without a fast tier get speed 'normal' — neither shows a
            // stage the model can't act on.
            picker.selection.reasoningEffort = item && item.reasoning === false ? 'none' : '';
            picker.selection.speed = item && item.fast !== true ? 'normal' : '';
            if(picker.selection.reasoningEffort && picker.selection.speed){
              cacheChatModelSelection(picker.selection);
              closeMenu();
            }
          } else if(kind === 'effort'){
            picker.selection.reasoningEffort = choice.getAttribute('data-effort');
            var effortEntry = selectedEntry();
            if(effortEntry && effortEntry.fast !== true){
              // No fast tier -> the effort pick completes the selection.
              picker.selection.speed = 'normal';
              cacheChatModelSelection(picker.selection);
              closeMenu();
            } else {
              picker.selection.speed = '';
              // Effort is already a complete normal-speed selection. Persist it
              // immediately so closing the optional speed step cannot restore
              // the old effort (the reported Medium -> High regression).
              cacheChatModelSelection(Object.assign({}, picker.selection, {speed:'normal'}));
            }
          } else if(kind === 'speed'){
            picker.selection.speed = choice.getAttribute('data-speed');
            cacheChatModelSelection(picker.selection);
            closeMenu();
          }
          render();
        });
      });
      els('.cc-model-connect-link', optionsWrap).forEach(function(pill){
        pill.addEventListener('click', function(event){
          event.stopPropagation();
          var row = COMPOSER_FAMILY_PROVIDERS.filter(function(candidate){ return candidate.id === pill.getAttribute('data-connect-provider-id'); })[0];
          if(row) openConnectFlowForProvider(row);
        });
      });
    }

    function render(){
      renderTags();
      renderOptions();
      var chosen = selectedEntry();
      var s = picker.selection;
      var summary = chosen ? chosen.providerLabel + ' · ' + chosen.model : (s.family || 'No model selected');
      if(s.reasoningEffort && s.reasoningEffort !== 'none') summary += ' · ' + (effortLabels[s.reasoningEffort] || s.reasoningEffort);
      if(s.speed) summary += ' · ' + titleCase(s.speed);
      if(selectionSummary) selectionSummary.textContent = summary;
      btn.setAttribute('aria-expanded', menu.classList.contains('open') ? 'true' : 'false');
    }

    function goBack(){
      if(picker.showProviderSwitcher){
        // Deepest screen: one step back returns to the ordinary family stage.
        picker.showProviderSwitcher = false;
        render();
        return;
      }
      var currentStage = stage();
      if(currentStage === 'family'){
        // The default (unchanged) resting screen has nowhere shallower to go
        // — pressing back here reveals the full setup-provider switcher
        // instead of closing the menu.
        picker.showProviderSwitcher = true;
        render();
        return;
      } else if(currentStage === 'variant'){
        // Return to whichever screen this variant list was opened from: the
        // provider switcher when a family-provider row picked it, otherwise
        // the ordinary family stage.
        picker.showProviderSwitcher = !!picker.selection.familyProviderId;
        picker.selection.family = '';
        picker.selection.familyKey = '';
        picker.selection.familyProviderId = '';
        picker.selection.variant = '';
        picker.selection.model = null;
        picker.selection.provider = '';
        picker.selection.reasoningEffort = '';
        picker.selection.speed = '';
      } else if(currentStage === 'effort'){
        picker.selection.variant = '';
        picker.selection.model = null;
        picker.selection.provider = '';
        picker.selection.reasoningEffort = '';
        picker.selection.speed = '';
      } else {
        picker.selection.reasoningEffort = '';
        picker.selection.speed = '';
      }
      render();
    }

    function load(options){
      options = options || {};
      // An empty inventory is never a cacheable success: it usually means the
      // fetch raced the gateway boot, so reopening the picker must retry.
      if(picker.loading || (picker.loaded && !picker.error && picker.providers.length && options.refresh !== true)) return Promise.resolve();
      picker.loading = true;
      picker.error = '';
      render();
      var inventoryUrl = '/api/settings/harness/chat-models' + (options.refresh === true ? '?refresh=true' : '');
      return api(inventoryUrl).then(function(res){
        var providers = res.data && Array.isArray(res.data.providers) ? res.data.providers : [];
        if(res.status !== 200) throw new Error((res.data && res.data.error) || 'Connected model inventory unavailable.');
        picker.providers = normalizeChatModelProviders(providers);
        syncBenchModelsFromChatInventory();
        picker.loaded = true;
        if(picker.providers.length) hydrateSelection();
        else {
          clearCachedChatModelSelection();
          picker.selection = {provider:null, model:null, family:'', familyKey:'', familyProviderId:'', variant:'', reasoningEffort:'', speed:''};
        }
      }).catch(function(error){
        picker.providers = [];
        BENCH_MODELS = [];
        picker.loaded = true;
        picker.selection = {provider:null, model:null, family:'', familyKey:'', familyProviderId:'', variant:'', reasoningEffort:'', speed:''};
        picker.error = error && error.message ? error.message : 'Connected models unavailable.';
      }).then(function(){
        picker.loading = false;
        render();
        refreshStyledAgentModelSelect();
      });
    }

    picker.ensureLoaded = function(){ return load({refresh:true}); };
    picker.resetAndReload = function(){
      picker.loaded = false;
      picker.loading = false;
      picker.error = '';
      picker.providers = [];
      picker.selection = {provider:null, model:null, family:'', familyKey:'', familyProviderId:'', variant:'', reasoningEffort:'', speed:''};
      clearCachedChatModelSelection();
      render();
      return load({refresh:true});
    };

    function closeMenu(){
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      // Always reopen on the default family stage, never mid-switcher.
      picker.showProviderSwitcher = false;
    }

    btn.addEventListener('click', function(event){
      event.stopPropagation();
      if(menu.classList.contains('open')) closeMenu();
      else {
        menu.classList.add('open');
        render();
        load();
      }
    });
    back.addEventListener('click', function(event){
      event.preventDefault();
      event.stopPropagation();
      goBack();
    });
    // Keep every interaction inside the picker from reaching the page-level
    // click-away handlers. This is especially important in the IAB renderer,
    // where a click on a freshly-rendered option can be retargeted while the
    // menu is being rebuilt and look like an outside click.
    pickerRoot.addEventListener('click', function(event){
      event.stopPropagation();
    });
    document.addEventListener('click', function(event){
      if(!pickerRoot.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', function(event){
      if(event.key === 'Escape' && menu.classList.contains('open')){
        event.preventDefault();
        closeMenu();
        btn.focus();
      }
    });
    render();
  })();

  /* ============ FIRST-RUN GUIDED TOUR ============
     A four-step coach-mark tour runs after the first successful login and can
     be replayed later. It introduces navigation, new chats, and the active
     conversation area. */
  var TOUR_LS_KEY = 'miaosTourDone';
  var TOUR_STEPS = [
    {
      target: '#workspaceSwitcherToggle',
      route: 'chat',
      title: 'Your private space',
      body: 'Solo is your private workspace. Conversations, bots, and provider access stay scoped to you.'
    },
    {
      target: '#chatSidebarToolsBtn',
      route: 'chat',
      title: 'Create from Tools',
      body: 'Open Tools to start a chat, create a bot, create a channel, or open the browser beside Mia.'
    },
    {
      target: '#chatStarterBots',
      route: 'chat',
      title: 'Start with a bot template',
      body: 'Choose a starter bot in the left panel to open setup with an editable prompt. Nothing is created until you confirm it.'
    },
    {
      target: '#chatThread',
      route: 'chat',
      title: 'Work in the conversation',
      body: 'Select Mia or a bot from the left panel, then ask for the task. Replay this walkthrough anytime from Settings → Guided tour.'
    }
  ];

  var tour = {active: false, step: 0, startHash: null, pollTimer: null};

  function startNewsAutomationGuide(){
    return api('/api/bots').then(function(res){
      if(res.status !== 200) throw new Error('Could not load your automations.');
      syncChatBotRecords(res.data.bots || []);
      var botId = miaOnboardingChat.newsBotId, automationId = miaOnboardingChat.newsAutomationId;
      if(!automationRecordById(botId, automationId)) throw new Error('This briefing was removed. You can manage your other automations from Tools.');
      if(tour.active) tourTeardown();
      var row = '[data-bot-id="' + botId + '"][data-automation-id="' + automationId + '"]';
      tour.steps = [
        {target:'#chatSidebarToolsBtn', title:'Your tools live here', body:'Open Tools to find your automations.', advanceOnClick:true},
        {target:'[data-tools-action="automations"]', title:'Open Automations', body:'This opens your scheduled tasks in the right panel.', advanceOnClick:true, prepare:function(){el('#chatToolsMenu').classList.add('open'); syncSidebarToolButtons();}},
        {target:row, title:'Your news briefing', body:'Here is the briefing you just created. Open it to see its schedule and controls.', advanceOnClick:true, prepare:function(){el('#chatToolsMenu').classList.remove('open'); localStorage.setItem('styledInfoPaneOpen','1'); prepareChatUtilityPane('automations'); renderChatInfoPane();}},
        {target:'.cip-editor-row-top', title:'Change or pause it anytime', body:'Change the schedule here. Turn Active off and save to pause your briefing.', prepare:function(){openAutomationDetail(botId, automationId);}},
        {target:'#automationDetailDelete', title:'You’re in control', body:'Delete removes this automation after confirmation. You don’t need to delete it now—your briefing is ready.'}
      ];
      tour.onFinish = function(){sendMiaOnboardingAction({action:'finish-news'});};
      tourStart();
    }).catch(function(error){showToast(error.message);});
  }

  function currentTourSteps(){ return tour.steps || TOUR_STEPS; }

  function tourEl(tag, cls){
    var e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  function tourBuildDom(){
    if(el('#miaosTourBackdrop')) return;
    var backdrop = tourEl('div', 'miaos-tour-backdrop');
    backdrop.id = 'miaosTourBackdrop';
    var spotlight = tourEl('div', 'miaos-tour-spotlight');
    spotlight.id = 'miaosTourSpotlight';
    var popover = tourEl('div', 'miaos-tour-popover');
    popover.id = 'miaosTourPopover';
    popover.innerHTML =
      '<div class="miaos-tour-eyebrow">Getting started</div>' +
      '<div class="miaos-tour-title" id="miaosTourTitle"></div>' +
      '<div class="miaos-tour-body" id="miaosTourBody"></div>' +
      '<div class="miaos-tour-controls">' +
        '<span class="miaos-tour-count" id="miaosTourCount"></span>' +
        '<button type="button" class="miaos-tour-btn skip" id="miaosTourSkip">Skip</button>' +
        '<button type="button" class="miaos-tour-btn" id="miaosTourBack">Back</button>' +
        '<button type="button" class="miaos-tour-btn primary" id="miaosTourNext">Next</button>' +
      '</div>';
    document.body.appendChild(backdrop);
    document.body.appendChild(spotlight);
    document.body.appendChild(popover);
    el('#miaosTourSkip').addEventListener('click', tourFinish);
    el('#miaosTourNext').addEventListener('click', tourNext);
    el('#miaosTourBack').addEventListener('click', tourBack);
  }

  // Navigating a tour step to a different route reuses the app's own
  // router (route() reads location.hash itself) rather than waiting on the
  // async 'hashchange' event, so the panel is already rendered by the time
  // this function goes looking for the target element.
  function tourGoto(routeName){
    if(!routeName) return;
    var hash = '#/' + routeName;
    if(location.hash !== hash) location.hash = hash;
    route();
  }

  // Panels driven by data (department tabs, bench columns) can render a
  // frame or two after route() returns, so the target lookup polls briefly
  // instead of assuming it's there synchronously.
  function tourWaitFor(selector, cb){
    if(tour.pollTimer) clearTimeout(tour.pollTimer);
    var tries = 0;
    (function poll(){
      var target = selector ? el(selector) : null;
      if(target || !selector || tries > 20){ cb(target); return; }
      tries++;
      tour.pollTimer = setTimeout(poll, 50);
    })();
  }

  function tourPosition(target, step){
    var spotlight = el('#miaosTourSpotlight');
    var popover = el('#miaosTourPopover');
    if(!target){
      spotlight.classList.add('none');
      spotlight.classList.remove('on');
      spotlight.style.width = '0px';
      spotlight.style.height = '0px';
      popover.classList.add('centered');
      popover.style.top = '';
      popover.style.left = '';
      return;
    }
    popover.classList.remove('centered');
    spotlight.classList.remove('none');
    var pad = 8;
    var r = target.getBoundingClientRect();
    spotlight.style.top = (r.top - pad) + 'px';
    spotlight.style.left = (r.left - pad) + 'px';
    spotlight.style.width = (r.width + pad * 2) + 'px';
    spotlight.style.height = (r.height + pad * 2) + 'px';
    spotlight.classList.add('on');

    // Prefer below the target; flip above if there isn't room, and clamp
    // horizontally so the card never runs off either edge.
    var popW = popover.offsetWidth || 320, popH = popover.offsetHeight || 150, gap = 14;
    var top = r.bottom + gap;
    if(top + popH > window.innerHeight - 12) top = Math.max(12, r.top - popH - gap);
    var left = Math.min(Math.max(12, r.left), window.innerWidth - popW - 12);
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
  }

  function tourRender(){
    var steps = currentTourSteps();
    var step = steps[tour.step];
    el('#miaosTourTitle').textContent = step.title;
    el('#miaosTourBody').textContent = step.body;
    el('#miaosTourCount').textContent = (tour.step + 1) + ' / ' + steps.length;
    el('#miaosTourBack').style.visibility = tour.step === 0 ? 'hidden' : 'visible';
    el('#miaosTourNext').textContent = tour.step === steps.length - 1 ? 'Done' : 'Next';
    el('#miaosTourPopover').classList.remove('on');
    tourWaitFor(step.target, function(target){
      tourPosition(target, step);
      if(target && step.advanceOnClick){
        var advance = function(){setTimeout(function(){if(tour.active) tourNext();}, 0);};
        target.addEventListener('click', advance, {once:true});
        tour.clearStepClick = function(){target.removeEventListener('click', advance);};
      }
      requestAnimationFrame(function(){ el('#miaosTourPopover').classList.add('on'); });
    });
  }

  function tourShowStep(index){
    if(tour.clearStepClick){tour.clearStepClick(); tour.clearStepClick = null;}
    var steps = currentTourSteps();
    tour.step = Math.max(0, Math.min(index, steps.length - 1));
    var step = steps[tour.step];
    if(step.route) tourGoto(step.route);
    if(step.prepare) step.prepare();
    tourRender();
  }

  function tourNext(){
    if(tour.step >= currentTourSteps().length - 1){ tourFinish(); return; }
    tourShowStep(tour.step + 1);
  }
  function tourBack(){ if(tour.step > 0) tourShowStep(tour.step - 1); }

  function tourTeardown(){
    tour.active = false;
    if(tour.clearStepClick){tour.clearStepClick(); tour.clearStepClick = null;}
    tour.steps = null;
    if(tour.pollTimer) clearTimeout(tour.pollTimer);
    var backdrop = el('#miaosTourBackdrop'), spotlight = el('#miaosTourSpotlight'), popover = el('#miaosTourPopover');
    if(backdrop) backdrop.classList.remove('on');
    if(spotlight) spotlight.classList.remove('on');
    if(popover) popover.classList.remove('on');
    document.removeEventListener('keydown', tourKeydown);
    // Restore whatever route the user was actually on before the tour
    // walked them through Agents/Messages, so finishing/skipping never
    // strands them somewhere they didn't navigate to themselves.
    if(tour.startHash && location.hash !== tour.startHash){
      location.hash = tour.startHash;
      route();
    }
  }

  function tourFinish(){
    localStorage.setItem(TOUR_LS_KEY, '1');
    if(tour.releaseVersion && window.miaDesktop && window.miaDesktop.state){
      window.miaDesktop.state.set('miaIntroVersion', tour.releaseVersion);
      tour.releaseVersion = null;
    }
    tourTeardown();
    if(tour.onFinish){var finish = tour.onFinish; tour.onFinish = null; finish();}
  }

  function tourKeydown(e){
    if(e.key === 'Escape') tourFinish();
  }

  function tourStart(){
    if(tour.active) return;
    // Electron's native browser is above HTML overlays. Close its panel before
    // showing coach marks; the saved tabs and authenticated session remain.
    closeLocalBrowser();
    closeChatThread();
    closeChatTasksPanel();
    tour.active = true;
    tour.startHash = location.hash;
    tourBuildDom();
    el('#miaosTourBackdrop').style.pointerEvents = tour.steps ? 'none' : '';
    el('#miaosTourBackdrop').classList.add('on');
    document.addEventListener('keydown', tourKeydown);
    tourShowStep(0);
  }

  function startUpdatedDesktopIntro(){
    var desktop = window.miaDesktop;
    if(!desktop || !desktop.version || !desktop.state) return false;
    var version = desktop.version();
    if(!version) return false;
    var previous = desktop.state.get('miaIntroVersion');
    // An installation predating version tracking may already have a completed
    // tour or a restored browser. Treat it as an upgrade, not a new account.
    var existingInstall = !!previous || !!localStorage.getItem(TOUR_LS_KEY) || shouldRestoreLocalBrowser();
    if(previous !== version && existingInstall){
      if(!previous) desktop.state.set('miaIntroVersion', 'legacy');
      tour.releaseVersion = version;
      tourStart();
      return true;
    }
    if(!previous) desktop.state.set('miaIntroVersion', version);
    return false;
  }

  // Only ever auto-fires once the app shell is actually visible (called
  // from showApp(), never from the login wall) — see hideApp/showApp above.
  function tourMaybeAutoStart(){
    if(localStorage.getItem(TOUR_LS_KEY)) return;
    setTimeout(tourStart, 500);
  }

  var replayBtn = el('#settingsReplayTour');
  if(replayBtn){
    replayBtn.addEventListener('click', function(){
      closeSettingsDrawer();
      tourStart();
    });
  }

  // Exposed per spec as a documented escape hatch even though the Settings
  // row above covers the normal case — restart() explicitly clears the
  // done flag first so it also works as a "force it to look first-run again"
  // dev/debug tool.
  window.miaosTour = {
    restart: function(){
      localStorage.removeItem(TOUR_LS_KEY);
      tourStart();
    }
  };

  // Dev/test-only hook — never referenced by any real app code path, so it
  // can't drift out of sync with production behavior. Lets a headless
  // Playwright script drive the chat UI without a live harness stack:
  // read chatWs/chatRoomState directly, force-render the thread, inject
  // fixture task data (real tasks take minutes; this skips the wait), and
  // open/close the two docked panels.
  window.__testChat = {
    chatRoomState: chatRoomState,
    chatWs: chatWs,
    renderChatThread: renderChatThread,
    loadOlderChatMessages: loadOlderChatMessages,
    openChatThread: openChatThread,
    closeChatThread: closeChatThread,
    openChatTasksPanel: openChatTasksPanel,
    closeChatTasksPanel: closeChatTasksPanel,
    renderChatSidebar: renderChatSidebar,
    renderChatHeaderBar: renderChatHeaderBar,
    // Fixture injector: sets chatWs.tasks directly and repaints every task-
    // driven surface, bypassing live task loading.
    setTasks: function(tasks){
      chatWs.tasks = tasks || [];
      renderLiveViews();
    }
  };

})();
