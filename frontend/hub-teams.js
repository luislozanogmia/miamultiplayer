(function () {
  'use strict';
  const pane = document.querySelector('#hubTeamsPane');
  if (!pane) return;
  const status = document.querySelector('#hubStatus');
  let loading = false, mutating = false, actionFeedback = '';
  // Shares the Hub call and its error wording with chat and the Admin Center.
  const call = (method, path, body) => window.MiaHubChat.call(method, path, body);
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
        // People are added, removed and given roles only in the Admin Center;
        // this page lists them and lets you leave.
        const list = node('ul', undefined, c);
        let ownerId = null;
        try {
          const result = await call('GET', '/v1/teams/' + team.teamId + '/members');
          ownerId = result.owner_id || null;
          for (const member of result.members) {
            node('li', member.email + ' · ' + member.role + (member.clerk_user_id === ownerId ? ' · owner' : ''), list);
          }
        } catch (error) { node('p', error.message, c); }
        if (team.membership.role === 'admin') {
          const manage = node('button', 'Manage members in the Admin Center', c);
          manage.type = 'button'; manage.className = 'styled-settings-pill-btn';
          manage.addEventListener('click', () => { location.href = '/admin?workspace=' + encodeURIComponent('hub_' + team.teamId) + '#/users'; });
        }
        if (ownerId && ownerId === team.membership.clerk_user_id) node('p', 'You own this team. To leave, first make another admin the owner in the Admin Center.', c);
        else button(c, 'Leave team', () => call('DELETE', '/v1/teams/' + team.teamId + '/members/' + encodeURIComponent(team.membership.clerk_user_id), {})
          .then(() => window.dispatchEvent(new CustomEvent('mia-hub-team-left', { detail: { teamId: team.teamId } }))));
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
