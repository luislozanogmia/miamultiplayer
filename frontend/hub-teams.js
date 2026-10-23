(function () {
  'use strict';
  const pane = document.querySelector('#hubTeamsPane');
  if (!pane) return;
  const status = document.querySelector('#hubStatus');
  let loading = false, mutating = false, actionFeedback = '';
  const messages = { sign_in_required: 'Sign in to your Mia account to use teams.', invalid_session: 'Your account could not be verified. Sign in again.',
    hub_not_configured: 'The Hub connection is not configured yet.', hub_unavailable: 'Cannot reach the Hub. Try again.',
    company_email_required: 'Request a team with a verified company email.', company_pending_or_active: 'Your company already has a team or a pending request.',
    last_admin: 'A team must keep at least one admin.', not_found: 'This item is no longer available, or you do not have access.',
    team_capacity: 'The Hub is at its team limit.', seat_limit: 'This team has reached its member limit.', invite_limit: 'The daily invitation limit has been reached.',
    already_member: 'That person is already a member.' };
  async function call(method, path, body) {
    const native = window.miaDesktop && window.miaDesktop.auth;
    const token = native ? window.MiaClerkDesktop.unwrap(await native.getSessionToken())
      : window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
    if (!token) throw Object.assign(new Error(messages.sign_in_required), { code: 'sign_in_required' });
    const response = await fetch('/api/hub' + path, { method, credentials: 'include',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(messages[result.error] || 'The Hub could not complete that action.'), { code: result.error });
    return result;
  }
  function node(tag, text, parent) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (parent) parent.append(n); return n; }
  function button(parent, text, action) {
    const b = node('button', text, parent); b.type = 'button'; b.className = 'styled-settings-pill-btn';
    b.addEventListener('click', () => mutate(action, b)); return b;
  }
  async function mutate(action, control) {
    if (mutating) return; mutating = true; actionFeedback = ''; control.disabled = true;
    try { await action(); actionFeedback = 'Saved.'; status.textContent = actionFeedback; await refresh(true); }
    catch (error) { actionFeedback = error.message; status.textContent = actionFeedback; }
    finally { mutating = false; control.disabled = false; }
  }
  function card(parent, title) { const c = node('section', undefined, parent); c.className = 'styled-settings-card'; c.style.cssText = 'padding:16px;margin-top:12px'; node('h2', title, c).style.fontSize = '18px'; return c; }
  async function refresh(force) {
    if (loading || (mutating && !force)) return; loading = true;
    try {
      const me = await call('GET', '/v1/me');
      const teams = document.querySelector('#hubTeams'), requests = document.querySelector('#hubRequests'), approvals = document.querySelector('#hubApprovals');
      teams.replaceChildren(); requests.replaceChildren(); approvals.replaceChildren();
      for (const request of me.requests) node('p', request.name + ' — ' + request.status, requests);
      for (const team of me.teams) {
        const c = card(teams, team.name || 'Team temporarily unavailable');
        if (team.unavailable) { node('p', 'The team server is unavailable. Try refreshing shortly.', c); continue; }
        if (team.invite && !team.membership) {
          node('p', 'You have been invited to this team.', c);
          button(c, 'Accept invitation', () => call('POST', '/v1/invites/' + team.teamId + '/accept', {}));
          button(c, 'Decline', () => call('POST', '/v1/invites/' + team.teamId + '/decline', {})); continue;
        }
        node('p', 'Your role: ' + team.membership.role, c);
        const list = node('ul', undefined, c);
        try {
          const result = await call('GET', '/v1/teams/' + team.teamId + '/members');
          for (const member of result.members) {
            const row = node('li', member.email + ' · ' + member.role + ' ', list);
            if (team.membership.role === 'admin') button(row, 'Remove', () => call('DELETE', '/v1/teams/' + team.teamId + '/members/' + encodeURIComponent(member.clerk_user_id), {}));
          }
        } catch (error) { node('p', error.message, c); }
        button(c, 'Leave team', () => call('DELETE', '/v1/teams/' + team.teamId + '/members/' + encodeURIComponent(team.membership.clerk_user_id), {}));
        if (team.membership.role === 'admin') {
          const form = node('form', undefined, c), label = node('label', 'Invite by email ', form), input = node('input', undefined, label);
          input.type = 'email'; input.required = true; input.className = 'styled-settings-field'; input.autocomplete = 'off'; input.maxLength = 254;
          const send = node('button', 'Invite', form); send.className = 'styled-settings-pill-btn'; send.type = 'submit';
          form.addEventListener('submit', event => { event.preventDefault(); mutate(() => call('POST', '/v1/teams/' + team.teamId + '/invites', { email: input.value }), send); });
        }
      }
      if (!me.teams.length) node('p', 'No team memberships or invitations yet.', teams);
      try {
        const admin = await call('GET', '/v1/admin/team-requests');
        if (admin.requests.length) {
          const c = card(approvals, 'Requests awaiting approval');
          for (const request of admin.requests) {
            const row = node('p', request.name + ' · ' + request.email + ' ', c);
            button(row, 'Approve', () => call('POST', '/v1/admin/team-requests/' + request.id + '/approve', {}));
            button(row, 'Decline', () => call('POST', '/v1/admin/team-requests/' + request.id + '/decline', {}));
          }
        }
      } catch (error) { if (error.code !== 'not_found') node('p', error.message, approvals); }
      status.textContent = actionFeedback || 'Connected to Hub.';
    } catch (error) { status.textContent = error.message; }
    finally { loading = false; }
  }
  document.querySelector('#hubRefresh').addEventListener('click', () => { actionFeedback = ''; refresh(); });
  document.querySelector('#hubRequestForm').addEventListener('submit', event => {
    event.preventDefault(); const control = event.submitter || event.target.querySelector('button');
    mutate(() => call('POST', '/v1/team-requests', { name: document.querySelector('#hubTeamName').value.trim() }), control);
  });
  document.querySelector('[data-pane="teams"].styled-settings-nav-item').addEventListener('click', () => { actionFeedback = ''; refresh(); });
  setInterval(() => {
    if (pane.classList.contains('active') && document.querySelector('#settingsDrawer').classList.contains('open')
      && !pane.querySelector('input:focus, textarea:focus, select:focus') && !document.hidden) refresh();
  }, 60000);
}());
