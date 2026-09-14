(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else factory(root);
})(typeof window !== 'undefined' ? window : this, function(root){
  'use strict';

  /* ============ pure helpers (exported for tests) ============ */

  function tokenFromPath(pathname){
    var m = /^\/invite\/([^/]+)\/?$/.exec(String(pathname || ''));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Decides which of the four invite-page states to show, given the
  // GET /api/invite/:token response (or an error).
  function stateFor(result){
    if(!result || result.error) return 'invalid';
    if(!result.valid) return 'invalid';
    return 'form';
  }

  function invalidReason(result){
    if(result && result.reason) return result.reason;
    if(result && result.expiresAt && new Date(result.expiresAt) < new Date()) return 'This invite has expired.';
    return 'This invite link is invalid or has expired.';
  }

  function validateAccept(password, confirm){
    if(!password || password.length < 10) return 'Password must be at least 10 characters.';
    if(password !== confirm) return 'Passwords do not match.';
    return null;
  }

  /* ============ DOM-dependent runtime (browser only) ============ */

  function initBrowser(win){
    var doc = win.document;

    function $(sel){ return doc.querySelector(sel); }

    function toast(message, isErr){
      var el = $('#adminToast');
      if(!el) return;
      el.textContent = message;
      el.classList.toggle('err', !!isErr);
      el.classList.add('show');
      setTimeout(function(){ el.classList.remove('show'); }, 3200);
    }

    function show(id){
      ['inviteLoading', 'inviteInvalid', 'inviteFormBlock', 'inviteDone'].forEach(function(sec){
        var el = $('#' + sec);
        if(el) el.hidden = (sec !== id);
      });
    }

    function api(path, opts){
      opts = opts || {};
      opts.credentials = 'include';
      if(opts.body && typeof opts.body !== 'string'){
        opts.headers = Object.assign({'Content-Type': 'application/json'}, opts.headers || {});
        opts.body = JSON.stringify(opts.body);
      }
      return win.fetch(path, opts).then(function(r){
        return r.json().catch(function(){ return {}; }).then(function(data){
          return {status: r.status, data: data};
        });
      });
    }

    var token = tokenFromPath(win.location.pathname);

    function boot(){
      if(!token){
        $('#inviteInvalidReason').textContent = 'This invite link is invalid or has expired.';
        show('inviteInvalid');
        return;
      }
      api('/api/invite/' + encodeURIComponent(token)).then(function(res){
        var body = res.status >= 200 && res.status < 300 ? res.data : Object.assign({error: true}, res.data);
        var state = stateFor(body);
        if(state === 'invalid'){
          $('#inviteInvalidReason').textContent = invalidReason(body);
          show('inviteInvalid');
          return;
        }
        $('#inviteEmailLine').textContent = body.email + (body.role === 'admin' ? ' — admin' : '');
        show('inviteFormBlock');
      }).catch(function(){
        $('#inviteInvalidReason').textContent = 'This invite link is invalid or has expired.';
        show('inviteInvalid');
      });

      var form = $('#acceptForm');
      if(form) form.addEventListener('submit', function(ev){
        ev.preventDefault();
        var fd = new win.FormData(form);
        var password = fd.get('password');
        var confirm = fd.get('confirm');
        var errEl = $('#inviteAcceptError');
        var problem = validateAccept(password, confirm);
        if(problem){
          if(errEl){ errEl.textContent = problem; errEl.hidden = false; }
          return;
        }
        if(errEl) errEl.hidden = true;
        api('/api/invite/' + encodeURIComponent(token) + '/accept', {
          method: 'POST',
          body: {password: password, displayName: fd.get('displayName') || undefined}
        }).then(function(res){
          if(res.status < 200 || res.status >= 300){
            var msg = (res.data && (res.data.error || res.data.message)) || 'Could not accept invite.';
            if(errEl){ errEl.textContent = msg; errEl.hidden = false; }
            return;
          }
          show('inviteDone');
          setTimeout(function(){ win.location.href = '/'; }, 1200);
        }).catch(function(){
          toast('Network error', true);
        });
      });
    }

    if(doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  var exportsObj = {
    tokenFromPath: tokenFromPath,
    stateFor: stateFor,
    invalidReason: invalidReason,
    validateAccept: validateAccept
  };

  if(root && root.document) initBrowser(root);

  return exportsObj;
});
