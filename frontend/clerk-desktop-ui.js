(function(root){
  'use strict';
  function unwrap(reply){
    if(!reply || !reply.ok) throw new Error(reply && reply.error || 'Sign-in is unavailable. Please try again.');
    return reply.result;
  }
  function mount(container, auth, onSignedIn){
    var doc = container.ownerDocument;
    var busy = false, disposed = false, expiryTimer = null, manualLink = false;
    var form = doc.createElement('form');
    form.className = 'native-clerk-form';
    form.innerHTML = '<button type="button" class="login-btn native-clerk-google"><img src="assets/connectors/google-g.svg" width="18" height="18" alt="">Continue with Google</button>' +
      '<div class="native-clerk-divider">or</div>' +
      '<div class="login-field native-clerk-email"><label for="nativeClerkEmail">Email</label><input id="nativeClerkEmail" type="email" autocomplete="email" placeholder="you@example.com" required></div>' +
      '<div class="login-field native-clerk-code" hidden><label for="nativeClerkCode">Email code</label><input id="nativeClerkCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000"></div>' +
      '<button type="submit" class="login-btn native-clerk-submit">Continue with email</button>' +
      '<p class="native-clerk-status" role="status" aria-live="polite"></p>' +
      '<div class="native-clerk-browser-link" hidden><label for="nativeClerkLink">Open this link in your browser to continue</label><input id="nativeClerkLink" type="url" readonly autocomplete="off" aria-label="Google sign-in link"><button type="button" class="native-clerk-copy">Copy sign-in link</button></div>' +
      '<button type="button" class="native-clerk-cancel" hidden>Cancel sign-in</button>';
    container.replaceChildren(form);
    var google = form.querySelector('.native-clerk-google');
    var emailBox = form.querySelector('.native-clerk-email');
    var email = form.querySelector('#nativeClerkEmail');
    var codeBox = form.querySelector('.native-clerk-code');
    var code = form.querySelector('#nativeClerkCode');
    var submit = form.querySelector('.native-clerk-submit');
    var status = form.querySelector('.native-clerk-status');
    var cancel = form.querySelector('.native-clerk-cancel');
    var linkBox = form.querySelector('.native-clerk-browser-link');
    var link = form.querySelector('#nativeClerkLink');
    var copy = form.querySelector('.native-clerk-copy');
    function controls(waiting){
      google.disabled = busy || (waiting && !manualLink);
      submit.disabled = busy || (waiting && !manualLink);
      email.disabled = busy || (waiting && !manualLink);
      code.disabled = busy || waiting;
      copy.disabled = busy;
    }
    function update(state){
      if(disposed) return;
      clearTimeout(expiryTimer);
      var kind = state && state.status || 'signed_out';
      var waiting = kind === 'waiting';
      // Native auth only supplies an allowlisted Google URL to the local
      // app frame. Never persist it, interpolate it into HTML, or log it.
      manualLink = (waiting || kind === 'error') && !!(state && state.authorizationUrl);
      linkBox.hidden = !manualLink;
      link.value = manualLink ? state.authorizationUrl : '';
      google.textContent = manualLink ? 'Try Google again' : '';
      if(!manualLink) google.innerHTML = '<img src="assets/connectors/google-g.svg" width="18" height="18" alt="">Continue with Google';
      var verifying = kind === 'needs_verification';
      codeBox.hidden = !verifying;
      emailBox.hidden = verifying;
      email.required = !verifying;
      code.required = verifying;
      submit.textContent = verifying ? 'Verify email' : 'Continue with email';
      cancel.hidden = !waiting && !verifying && !manualLink;
      controls(waiting);
      status.textContent = '';
      if(waiting || manualLink){
        if(waiting) status.textContent = manualLink ? 'Waiting for your browser. Retry Google or sign in with your email instead.' : 'Finish signing in in your browser.';
        expiryTimer = setTimeout(function(){
          busy = true; controls(true);
          auth.cancel().then(unwrap).then(function(){
            busy = false; update({status:'expired'});
          }).catch(function(error){ busy = false; update({status:'error',error:error.message}); });
        }, Math.max(0, state.expiresAt - Date.now()));
      }
      if(verifying){ status.textContent = 'Enter the code sent to your email.'; code.focus(); }
      if(kind === 'active'){ status.textContent = 'Opening Mia…'; onSignedIn(); }
      if(kind === 'expired') status.textContent = 'Sign-in expired. Please try again.';
      if(kind === 'error') status.textContent = state.error || 'Sign-in failed. Please try again.';
      if(kind === 'needs_sign_up') status.textContent = 'Complete your invitation first, then sign in again.';
      if(kind === 'needs_second_factor') status.textContent = 'This account requires an additional verification method that Mia does not yet support.';
    }
    async function run(action){
      if(busy) return;
      clearTimeout(expiryTimer); manualLink = false;
      link.value = ''; linkBox.hidden = true; cancel.hidden = true;
      busy = true; controls(false); status.textContent = 'Connecting…';
      try {
        var next = unwrap(await action());
        busy = false; update(next);
      } catch(error){
        busy = false; controls(false); status.textContent = error.message;
      }
    }
    google.addEventListener('click', function(){ run(function(){ return auth.startGoogle(); }); });
    copy.addEventListener('click', async function(){
      if(!manualLink || !link.value || busy) return;
      var value = link.value;
      try {
        await doc.defaultView.navigator.clipboard.writeText(value);
        if(link.value === value) status.textContent = 'Sign-in link copied. Open it in your browser to continue.';
      } catch(_){
        if(link.value === value){ link.focus(); link.select(); status.textContent = 'Select and copy the sign-in link above, then open it in your browser.'; }
      }
    });
    form.addEventListener('submit', function(event){
      event.preventDefault();
      run(function(){ return codeBox.hidden ? auth.startEmail(email.value.trim()) : auth.verifyEmail(code.value.trim()); });
    });
    cancel.addEventListener('click', function(){ code.value = ''; run(function(){ return auth.cancel(); }); });
    var unsubscribe = auth.onState(update);
    run(function(){ return auth.status(); });
    return function(){ disposed = true; clearTimeout(expiryTimer); unsubscribe(); email.value = ''; code.value = ''; link.value = ''; container.replaceChildren(); };
  }
  root.MiaClerkDesktop = { mount:mount, unwrap:unwrap };
  if(typeof module === 'object' && module.exports) module.exports = root.MiaClerkDesktop;
})(typeof window === 'undefined' ? globalThis : window);
