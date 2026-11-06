(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory(undefined, require('./team-files.js'), require('./team-workflows.js'));
  else factory(root, root.MiaTeamFiles, root.MiaTeamWorkflows);
})(typeof window !== 'undefined' ? window : this, function(root, tf, wf){
  'use strict';

  /* ============ pure helpers (exported for tests, no DOM/window needed) ============ */

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }

  function normalizeEmail(value){
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  var HUB_TEAM_KEY = /^hub_[a-f0-9]{32}$/;

  function adminWorkspaceKey(search, storedWorkspaceKey){
    var query = String(search == null ? '' : search);
    var match = query.match(/(?:^|[?&])workspace=([^&]*)/);
    var requested = match ? decodeURIComponent(match[1]) : '';
    if(requested === 'solo' || requested === 'multiplayer_test' || HUB_TEAM_KEY.test(requested)) return requested;
    if(HUB_TEAM_KEY.test(storedWorkspaceKey || '')) return storedWorkspaceKey;
    return storedWorkspaceKey === 'solo' ? 'solo' : 'multiplayer_test';
  }

  // A shared team's members, invites and log live on the Hub; the local
  // Mia user list only backs Multiplayer Test.
  function hubTeamId(workspaceKey){
    return HUB_TEAM_KEY.test(workspaceKey || '') ? workspaceKey.slice(4) : null;
  }

  // Hub times are Unix seconds; the formatters here take milliseconds.
  function hubTime(seconds){
    return seconds ? Number(seconds) * 1000 : null;
  }

  function initialsFor(user){
    if(user && user.initials) return user.initials;
    var name = (user && (user.displayName || user.email)) || '';
    var parts = String(name).replace(/@.*/, '').split(/[.\s_-]+/).filter(Boolean);
    if(!parts.length) return '?';
    if(parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function displayNameForAdminUser(user){
    return user && (user.displayName || user.email) || '';
  }

  function filterAdminUsers(users, search){
    var needle = String(search == null ? '' : search).trim().toLowerCase();
    return (users || []).filter(function(user){
      if(!needle) return true;
      var name = String(displayNameForAdminUser(user) || '').toLowerCase();
      var email = String(user && user.email || '').toLowerCase();
      return (name + ' ' + email).indexOf(needle) !== -1;
    });
  }

  function fmtDate(value){
    if(!value) return '—';
    var d = new Date(value);
    if(isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) +
      ' ' + d.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'});
  }

  function fmtUptime(seconds){
    seconds = Number(seconds) || 0;
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var mins = Math.floor((seconds % 3600) / 60);
    if(days > 0) return days + 'd ' + hours + 'h';
    if(hours > 0) return hours + 'h ' + mins + 'm';
    return mins + 'm';
  }

  function healthDotClass(state){
    var s = String(state || '').toLowerCase();
    if(s === 'ok' || s === 'up' || s === 'healthy' || s === 'connected') return 'ok';
    if(s === 'degraded' || s === 'warn' || s === 'slow') return 'warn';
    if(!s) return '';
    return 'bad';
  }

  function renderOverviewTiles(overview){
    overview = overview || {};
    var instance = overview.instance || {};
    var counts = overview.counts || {};
    var health = overview.health || {};
    var domains = Array.isArray(instance.domains) ? instance.domains.join(', ') : (instance.domains || '');

    var tiles = [];
    tiles.push(
      '<div class="card admin-tile">' +
        '<div class="admin-tile-label">Instance</div>' +
        '<div class="admin-tile-val">' + esc(instance.name || '—') + '</div>' +
        '<div class="admin-tile-sub">' + esc(domains || '—') + '</div>' +
      '</div>'
    );
    tiles.push(
      '<div class="card admin-tile">' +
        '<div class="admin-tile-label">Uptime</div>' +
        '<div class="admin-tile-val">' + esc(fmtUptime(overview.uptimeSeconds)) + '</div>' +
        '<div class="admin-tile-sub">v' + esc(overview.version || '—') + '</div>' +
      '</div>'
    );
    tiles.push(
      '<div class="card admin-tile">' +
        '<div class="admin-tile-label">Users</div>' +
        '<div class="admin-tile-val">' + esc(counts.users != null ? counts.users : '—') + '</div>' +
        '<div class="admin-tile-sub">' + esc(counts.admins || 0) + ' admin' + ((counts.admins === 1) ? '' : 's') +
          (counts.disabledUsers ? ', ' + esc(counts.disabledUsers) + ' disabled' : '') + '</div>' +
      '</div>'
    );
    tiles.push(
      '<div class="card admin-tile">' +
        '<div class="admin-tile-label">Bots / Rooms</div>' +
        '<div class="admin-tile-val">' + esc(counts.agents != null ? counts.agents : '—') + '</div>' +
        '<div class="admin-tile-sub">' + esc(counts.rooms != null ? counts.rooms : 0) + ' rooms</div>' +
      '</div>'
    );
    tiles.push(
      '<div class="card admin-tile admin-tile-health">' +
        '<div class="admin-tile-label">Health</div>' +
        [{key: 'chat', label: 'Chat'}, {key: 'harness', label: 'Harness'}, {key: 'database', label: 'Database'}].map(function(service){
          var state = health[service.key];
          return '<div class="admin-tile-health-row"><span class="dot ' + healthDotClass(state) + '"></span>' +
            '<span class="name">' + esc(service.label) + '</span>' +
            '<span class="state">' + esc(state || 'unknown') + '</span></div>';
        }).join('') +
      '</div>'
    );
    return tiles.join('');
  }

  function renderUsersTable(users, options){
    options = options || {};
    var search = String(options.search == null ? '' : options.search).trim();
    var currentAdminEmail = normalizeEmail(options.currentAdminEmail);
    var selectedEmails = options.selectedEmails || {};
    var disableSelection = !!options.disableSelection;
    users = filterAdminUsers(users, search);
    if(!users.length) return '<tr><td colspan="7" class="admin-empty">' + (search ? 'No users match your search.' : 'No users yet.') + '</td></tr>';
    return users.map(function(u){
      var email = normalizeEmail(u && u.email);
      var isCurrentAdmin = !!email && email === currentAdminEmail;
      var selectable = !!email && !isCurrentAdmin;
      var selected = !isCurrentAdmin && !!selectedEmails[email];
      var statusPill = u.disabled
        ? '<span class="pill bad">Disabled</span>'
        : '<span class="pill ok">Active</span>';
      var roleLabel = u.role === 'admin' ? 'Admin' : 'Member';
      var selectionLabel = isCurrentAdmin ? 'Current admin cannot be selected' : 'Select ' + displayNameForAdminUser(u);
      var deleteControl = (isCurrentAdmin || u.role === 'admin')
        ? '<span class="admin-row-protected">' + (isCurrentAdmin ? 'Current admin' : 'Protected') + '</span>'
        : '<button type="button" class="btn small danger" data-action="delete" data-email="' + esc(u.email) + '">Delete user</button>';
      return '<tr data-email="' + esc(u.email) + '">' +
        '<td class="admin-select-cell"><input type="checkbox" class="admin-user-select" data-email="' + esc(u.email) + '" data-selectable="' + (selectable ? 'true' : 'false') + '"' + (isCurrentAdmin ? ' data-protected="true"' : '') + (selected ? ' checked' : '') + (!selectable || disableSelection ? ' disabled' : '') + ' aria-label="' + esc(selectionLabel) + '"></td>' +
        '<td><div class="admin-cell-user">' +
          '<div class="admin-avatar">' + esc(initialsFor(u)) + '</div>' +
          '<div><div class="admin-cell-name">' + esc(displayNameForAdminUser(u)) + '</div>' +
          '<div class="admin-cell-sub">' + esc(u.email) + '</div></div>' +
        '</div></td>' +
        '<td>' + esc(roleLabel) + '</td>' +
        '<td>' + statusPill + '</td>' +
        '<td>' + esc(u.agentCount != null ? u.agentCount : 0) + '</td>' +
        '<td class="admin-cell-sub">' + esc(fmtDate(u.lastLoginAt)) + '</td>' +
        '<td class="admin-row-control">' + deleteControl + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderTeamOverviewTiles(data){
    data = data || {};
    var members = data.members || [];
    var admins = members.filter(function(m){ return m.role === 'admin'; }).length;
    var seats = data.seats || {};
    var channels = data.channels || [];
    var regular = channels.filter(function(c){ return c.kind !== 'dm' && c.kind !== 'group'; }).length;
    return [
      '<div class="card admin-tile"><div class="admin-tile-label">Company</div>' +
        '<div class="admin-tile-val">' + esc(data.name || '—') + '</div>' +
        '<div class="admin-tile-sub">Company</div></div>',
      '<div class="card admin-tile"><div class="admin-tile-label">Members</div>' +
        '<div class="admin-tile-val">' + esc(members.length) + '</div>' +
        '<div class="admin-tile-sub">' + esc(admins) + ' admin' + (admins === 1 ? '' : 's') + '</div></div>',
      '<div class="card admin-tile"><div class="admin-tile-label">Seats</div>' +
        '<div class="admin-tile-val">' + esc(seats.used != null ? seats.used + ' of ' + seats.limit : '—') + '</div>' +
        '<div class="admin-tile-sub">' + esc(seats.used != null ? (seats.used - members.length) + ' pending invite' + ((seats.used - members.length) === 1 ? '' : 's') : '') + '</div></div>',
      '<div class="card admin-tile"><div class="admin-tile-label">Channels</div>' +
        '<div class="admin-tile-val">' + esc(regular) + '</div>' +
        '<div class="admin-tile-sub">' + esc(channels.length - regular) + ' direct messages and groups</div></div>'
    ].join('');
  }

  function renderTeamUsersTable(members, options){
    options = options || {};
    var search = String(options.search == null ? '' : options.search).trim();
    var admins = (members || []).filter(function(m){ return m.role === 'admin'; }).length;
    var rows = filterAdminUsers((members || []).map(function(m){
      return {id: m.clerk_user_id, email: m.email, role: m.role, department: m.department || ''};
    }), search);
    if(!rows.length) return '<tr><td colspan="7" class="admin-empty">' + (search ? 'No users match your search.' : 'No members yet.') + '</td></tr>';
    return rows.map(function(u){
      var self = u.id === options.selfId;
      var owner = !!options.ownerId && u.id === options.ownerId;
      var lastAdmin = u.role === 'admin' && admins <= 1;
      // The owner keeps their role and seat until they hand ownership to another admin.
      var locked = owner ? ' disabled title="The owner must make another admin the owner first."'
        : lastAdmin ? ' disabled title="A company must keep at least one admin."' : '';
      var roleControl = u.role === 'admin'
        ? '<button type="button" class="btn small" data-action="team-role" data-role="member" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '"' +
          locked + '>Set to member</button>'
        : '<button type="button" class="btn small" data-action="team-role" data-role="admin" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Make admin</button>';
      var ownerControl = options.selfId && options.selfId === options.ownerId && !owner && u.role === 'admin'
        ? '<button type="button" class="btn small" data-action="team-owner" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Make owner</button>'
        : '';
      var removeControl = self
        ? '<span class="admin-row-protected">You</span>'
        : owner ? '<span class="admin-row-protected">Owner</span>'
        : '<button type="button" class="btn small danger" data-action="team-remove" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '"' +
          locked + '>Remove</button>';
      return '<tr data-email="' + esc(u.email) + '">' +
        '<td class="admin-select-cell"></td>' +
        '<td><div class="admin-cell-user">' +
          '<div class="admin-avatar">' + esc(initialsFor(u)) + '</div>' +
          '<div><div class="admin-cell-name">' + esc(u.email) + '</div>' +
          '<div class="admin-cell-sub">' + (self ? 'You' : 'Colleague') + (owner ? ' · Owner' : '') + '</div>' +
          '<input type="text" class="admin-department-input" maxlength="40" placeholder="Add department" data-team-department data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '" value="' + esc(u.department) + '" aria-label="Department for ' + esc(u.email) + '"></div>' +
        '</div></td>' +
        '<td>' + esc(owner ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Member') + '</td>' +
        '<td><span class="pill ok">Active</span></td>' +
        '<td>—</td>' +
        '<td class="admin-cell-sub">—</td>' +
        '<td class="admin-row-control"><div class="admin-row-actions">' + roleControl + ownerControl + removeControl + '</div></td>' +
      '</tr>';
    }).join('');
  }

  var TEAM_BOT_STATUS = {accepted: 'Active', pending: 'Pending', rejected: 'Rejected'};

  // Bots are added per channel, so the team roster is every bot in the
  // channels the admin can see, labelled with where it lives.
  function teamRosterAgents(channelBots){
    var agents = [];
    (channelBots || []).forEach(function(entry){
      var channel = entry.channel || {};
      var where = channel.kind === 'dm' ? 'Direct message' : channel.kind === 'group' ? 'Group' : '#' + (channel.name || 'channel');
      (entry.bots || []).forEach(function(bot){
        var admission = bot.admission || {};
        var owner = admission.requester_email || '';
        agents.push({id: bot.id, name: bot.name, owner: owner, ownerName: owner || 'Unknown member',
          ownerDescription: 'Colleague', status: TEAM_BOT_STATUS[admission.status] || 'Unknown',
          model: '—', departments: [where], createdAt: hubTime(bot.created_at)});
      });
    });
    return agents;
  }

  var TEAM_AUDIT_LABELS = {
    role_changed: 'Changed a role', owner_transferred: 'Transferred ownership', team_renamed: 'Renamed the company', team_logo_changed: 'Changed the company logo', invite_created: 'Invited',
    invite_revoked: 'Revoked an invite', invite_accepted: 'Joined the company', invite_declined: 'Declined an invite',
    member_removed: 'Removed a member', message_deleted: 'Deleted a message', file_uploaded: 'Uploaded an image',
    bot_shared: 'Added a bot', bot_unshared: 'Removed a bot', bot_execution_handoff: 'Handed off a bot run',
    bot_version_proposed: 'Proposed a bot change', bot_version_published: 'Approved a bot change',
    bot_version_rejected: 'Rejected a bot change', bot_editor_added: 'Added a bot editor',
    bot_editor_removed: 'Removed a bot editor', team_approved: 'Company approved'
  };

  function teamActivityEvents(events, members){
    var emails = Object.create(null);
    (members || []).forEach(function(m){ emails[m.clerk_user_id] = m.email; });
    return (events || []).map(function(e){
      var target = e.target ? (String(e.target).indexOf('@') !== -1 ? e.target : emails[e.target] || 'Former member') : '';
      return {at: hubTime(e.at), actor: e.actor_email || emails[e.actor] || 'Former member',
        action: TEAM_AUDIT_LABELS[e.event] || String(e.event || '').replace(/_/g, ' '), target: target, detail: ''};
    });
  }

  // A team's Users count against its seat limit; pending invites hold seats too.
  function teamUsersSummary(count, seats){
    if(!seats || seats.limit == null) return count + ' user' + (count === 1 ? '' : 's');
    var pending = Math.max(0, Number(seats.used || 0) - count);
    return count + ' of ' + seats.limit + ' users' + (pending ? ' · ' + pending + ' invite' + (pending === 1 ? '' : 's') + ' pending' : '');
  }

  // Channels a new team bot can join: shared channels and groups, not DMs.
  function newBotChannelOptions(channels){
    return (channels || []).filter(function(channel){
      return channel && /^[a-f0-9]{32}$/.test(channel.id || '') && channel.kind !== 'dm';
    }).map(function(channel){
      return {id: channel.id, label: channel.kind === 'group' ? 'Group: ' + String(channel.name || 'group') : '#' + String(channel.name || 'channel')};
    }).sort(function(a, b){ return a.label.localeCompare(b.label); });
  }

  // Mia reads this once on return and opens the New Bot setup for that channel.
  var NEW_TEAM_BOT_KEY = 'miaNewTeamBot';
  function newTeamBotRequest(teamId, channelId, now){
    return JSON.stringify({teamId: teamId, channelId: channelId, at: now});
  }

  function isMiaAdminAgent(agent){
    return !!agent && (String(agent.type || '').toLowerCase() === 'mia' || normalizeEmail(agent.id) === 'gateway');
  }

  function adminAgentType(agent){
    return isMiaAdminAgent(agent) ? 'Agent' : 'Bot';
  }

  function adminAgentName(agent){
    return isMiaAdminAgent(agent) ? 'Mia' : String((agent && (agent.name || agent.id)) || 'Unnamed bot');
  }

  function adminAgentOwnerKey(agent){
    var owner = normalizeEmail(agent && agent.owner);
    if(owner) return owner;
    var name = String((agent && agent.ownerName) || '').trim().toLowerCase();
    return name ? 'name:' + name : 'unknown';
  }

  function adminAgentOwnerName(agent){
    if(agent && agent.ownerName) return String(agent.ownerName);
    if(agent && agent.ownerKind === 'mia') return 'Mia';
    return String((agent && agent.owner) || 'Unknown human');
  }

  function adminAgentOwnerDescription(agent){
    if(agent && agent.ownerDescription) return String(agent.ownerDescription);
    if(agent && agent.ownerKind === 'mia') return 'Hermes-backed gateway';
    return String((agent && agent.owner) || 'Owner unavailable');
  }

  function adminAgentDepartments(agent){
    return agent && Array.isArray(agent.departments)
      ? agent.departments.map(function(department){ return typeof department === 'string' ? department.trim() : ''; }).filter(Boolean)
      : [];
  }

  function filterAdminAgents(agents, search, filters){
    var needle = String(search == null ? '' : search).trim().toLowerCase();
    filters = filters || {};
    var ownerFilter = normalizeEmail(filters.owner);
    var typeFilter = String(filters.type || '').trim().toLowerCase();
    var statusFilter = String(filters.status || '').trim().toLowerCase();
    return (Array.isArray(agents) ? agents : []).filter(function(agent){
      if(ownerFilter && adminAgentOwnerKey(agent) !== ownerFilter) return false;
      if(typeFilter && adminAgentType(agent).toLowerCase() !== typeFilter) return false;
      if(statusFilter && String((agent && agent.status) || 'unknown').trim().toLowerCase() !== statusFilter) return false;
      if(!needle) return true;
      var departments = adminAgentDepartments(agent).join(' ');
      var haystack = [
        adminAgentName(agent),
        adminAgentType(agent),
        agent && agent.owner,
        agent && agent.ownerName,
        agent && agent.ownerDescription,
        agent && agent.status,
        agent && agent.model,
        agent && agent.id,
        departments
      ].join(' ').toLowerCase();
      return haystack.indexOf(needle) !== -1;
    });
  }

  function agentStatusClass(status){
    var state = String(status || '').toLowerCase();
    if(state === 'active' || state === 'running' || state === 'ready' || state === 'connected') return 'ok';
    if(state === 'draft' || state === 'watch' || state === 'pending' || state === 'provisioning' || state === 'idle') return 'warn';
    if(state === 'unknown') return '';
    if(!state) return '';
    return 'bad';
  }

  function renderAgentsTable(agents, options){
    options = options || {};
    var search = String(options.search == null ? '' : options.search).trim();
    agents = filterAdminAgents(agents, search, options.filters);
    if(!agents.length) return '<tr><td colspan="8" class="admin-empty">' + (search || (options.filters && (options.filters.owner || options.filters.type || options.filters.status)) ? 'No bots match your filters.' : 'No bots yet.') + '</td></tr>';
    return agents.map(function(agent){
      var mia = isMiaAdminAgent(agent);
      var name = adminAgentName(agent);
      var type = adminAgentType(agent);
      var ownerName = adminAgentOwnerName(agent);
      var departments = adminAgentDepartments(agent);
      var id = String((agent && agent.id) || '');
      var status = String((agent && agent.status) || 'Unknown');
      var model = String((agent && agent.model) || '—');
      return '<tr data-agent-id="' + esc(id) + '">' +
        '<td><div class="admin-cell-user">' +
          '<div class="admin-avatar">' + esc(mia ? 'M' : initialsFor({displayName: ownerName})) + '</div>' +
          '<div><div class="admin-cell-name">' + esc(ownerName) + '</div>' +
          '<div class="admin-cell-sub">' + esc(adminAgentOwnerDescription(agent)) + '</div></div>' +
        '</div></td>' +
        '<td><div class="admin-cell-name">' + esc(name) + '</div>' +
          '<div class="admin-agent-id">' + esc(id || '—') + '</div>' +
        '</td>' +
        '<td><span class="pill admin-agent-type ' + (mia ? 'mia' : 'bot') + '">' + esc(type) + '</span></td>' +
        '<td><span class="pill ' + agentStatusClass(status) + '">' + esc(status) + '</span></td>' +
        '<td class="admin-cell-sub">' + esc(model) + '</td>' +
        '<td class="admin-agent-departments">' + esc(departments.length ? departments.join(', ') : 'No departments') + '</td>' +
        '<td class="admin-cell-sub">' + esc(fmtDate(agent && agent.createdAt)) + '</td>' +
        '<td class="admin-cell-sub">' + esc(fmtDate(agent && agent.updatedAt)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderInvitesTable(invites, options){
    invites = invites || [];
    options = options || {};
    if(!invites.length) return '<tr><td colspan="5" class="admin-empty">No pending invites.</td></tr>';
    return invites.map(function(inv){
      // Team invites have no link: the person sees them in Mia after signing in with that email.
      var linkAction = options.team ? '' : inv.link
        ? '<button type="button" class="btn small" data-action="copy-invite" data-id="' + esc(inv.id) + '">Copy link</button>'
        : '<span class="admin-cell-sub">Link shown when created</span>';
      return '<tr data-id="' + esc(inv.id) + '">' +
        '<td>' + esc(inv.email) + '</td>' +
        '<td>' + esc(inv.role === 'admin' ? 'Admin' : 'Member') + '</td>' +
        '<td class="admin-cell-sub">' + esc(inv.invitedBy || '—') + '</td>' +
        '<td class="admin-cell-sub">' + esc(fmtDate(inv.expiresAt)) + '</td>' +
        '<td><div class="admin-row-actions">' +
          linkAction +
          '<button type="button" class="btn small danger" data-action="revoke-invite" data-id="' + esc(inv.id) + '">Revoke</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  function renderActivityRows(events){
    events = events || [];
    if(!events.length) return '<tr><td colspan="5" class="admin-empty">No recent activity.</td></tr>';
    return events.map(function(e){
      return '<tr>' +
        '<td class="admin-cell-sub">' + esc(fmtDate(e.at)) + '</td>' +
        '<td>' + esc(e.actor) + '</td>' +
        '<td>' + esc(e.action) + '</td>' +
        '<td class="admin-cell-sub">' + esc(e.target || '') + '</td>' +
        '<td class="admin-cell-sub">' + esc(e.detail || '') + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ============ team controls: shared pieces ============ */

  var HUB_VIEWS = ['automations', 'files', 'apps', 'sessions'];
  var HUB_ID = /^[a-f0-9]{32}$/;
  var SESSION_REFRESH_MS = 15000;

  // Team controls need a team; Backup is local only. Anything else lands on Overview.
  function adminViewFromHash(hash, isTeam){
    var view = String(hash || '').replace(/^#\/?/, '');
    if(view === 'agent-roster') view = 'agents';
    if(['overview', 'users', 'agents', 'invites', 'activity'].indexOf(view) !== -1) return view;
    if(view === 'backup' && !isTeam) return view;
    if(HUB_VIEWS.indexOf(view) !== -1 && isTeam) return view;
    return 'overview';
  }

  // What a failed read means, in the admin's words. `retry` says whether trying
  // again can help, so nobody is offered a button that can't.
  function hubLoadError(error){
    var status = error && error.status, code = error && error.code;
    if(status === 401 || code === 'sign_in_required') return {kind: 'signin', message: 'Sign in to your Mia account, then try again.', retry: true};
    if(status === 403) return {kind: 'forbidden', message: 'Only admins of this company can see this.', retry: false};
    if(status === 404) return {kind: 'missing', message: 'This is not available right now. Your company server may need an update, or your admin access may have changed.', retry: true};
    if(!status || status >= 500) return {kind: 'offline', message: 'Mia can’t reach the company service right now. Check your connection and try again.', retry: true};
    return {kind: 'error', message: 'Mia could not load this. Try again.', retry: true};
  }

  function hubStateHtml(message, view, retry){
    return '<div class="card hub-state" role="status"><p>' + esc(message) + '</p>' +
      (retry ? '<button type="button" class="btn small" data-hub-action="retry" data-hub-id="' + esc(view) + '">Try again</button>' : '') + '</div>';
  }
  function hubButton(label, action, id, options){
    options = options || {};
    return '<button type="button" class="btn small' + (options.tone ? ' ' + options.tone : '') + '" data-hub-action="' + esc(action) + '" data-hub-id="' + esc(id) + '"' +
      (options.version ? ' data-hub-version="' + Number(options.version) + '"' : '') + (options.disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  function hubPill(label, tone){ return '<span class="pill' + (tone ? ' ' + tone : '') + '">' + esc(label) + '</span>'; }
  function hubSectionHead(title, note){
    return '<div class="hub-section-head"><h2 class="hub-section-title">' + esc(title) + '</h2>' + (note ? '<span class="hub-section-note">' + esc(note) + '</span>' : '') + '</div>';
  }

  var HUB_LOADING = {automations: 'Loading automations…', files: 'Loading files…', apps: 'Loading apps…', sessions: 'Loading browser sessions…'};

  // Every view has the same first-load, failed-load and stale-data handling.
  function renderHubView(view, state, now){
    if(!state.loaded){
      if(state.error) return hubStateHtml(state.error.message, view, state.error.retry);
      return '<div class="card hub-state" role="status"><p>' + esc(HUB_LOADING[view]) + '</p></div>';
    }
    var banner = state.error
      ? '<div class="hub-banner" role="status"><span>Showing what Mia last loaded. ' + esc(state.error.message) + '</span>' +
        hubButton('Try again', 'retry', view) + '</div>' : '';
    var body = {automations: renderHubAutomations, files: renderHubFiles, apps: renderHubApps, sessions: renderHubSessions}[view](state, now);
    return banner + body;
  }

  function hubMapPool(list, size, fn){
    var results = new Array(list.length), next = 0;
    function worker(){
      if(next >= list.length) return Promise.resolve();
      var at = next++;
      return Promise.resolve().then(function(){ return fn(list[at]); }).then(function(value){ results[at] = value; return worker(); });
    }
    var workers = [];
    for(var i = 0; i < Math.min(size, list.length); i++) workers.push(worker());
    return Promise.all(workers).then(function(){ return results; });
  }

  // The words on every dialog. Filled in with textContent, so Hub text stays text.
  function hubConfirmCopy(action, item, extra){
    item = item || {};
    extra = extra || {};
    switch(action){
      case 'wf-archive': return {title: 'Archive ' + item.name + '?', body: 'Archive this workflow? Runs in progress will finish, and no new ones will start.', confirmLabel: 'Archive', danger: true};
      case 'wf-approve': return {title: 'Approve version ' + extra.version + ' of ' + item.name + '?', body: 'It goes live for the company. Runs already in progress keep their version.', confirmLabel: 'Approve'};
      case 'wf-reject': return {title: 'Reject version ' + extra.version + ' of ' + item.name + '?', body: 'It will not go live. Anything live now stays live.', confirmLabel: 'Reject', danger: true};
      case 'file-delete': return {title: 'Delete ' + item.filename + '?',
        body: 'This removes the file for everyone in the company and frees its space. It can’t be undone. Copies people already downloaded stay on their computers.' + (item.appId ? ' This is an app’s file, so deleting it removes this file’s apps from the company' + (item.appName ? ', including "' + item.appName + '".' : '.') : item.spaceKind === 'app' ? ' A company app may depend on this file.' : ''),
        confirmLabel: 'Delete', danger: true};
      case 'app-approve': {
        var version = item.pending || {};
        return version.kind === 'link'
          ? {title: 'Approve ' + item.name + ' for everyone?', body: 'This opens on every colleague’s computer, in their Mia browser with their own sign-ins. Only approve an address you trust.', detail: version.url, confirmLabel: 'Approve for everyone'}
          : {title: 'Approve ' + item.name + ' for everyone?', body: 'This runs on every colleague’s computer. Only approve an app you trust. Published by ' + (item.publisher && item.publisher.name || 'a former colleague') + '. The virus scan can’t fully see inside an app bundle, so review it first.', confirmLabel: 'Approve for everyone'};
      }
      case 'app-reject': return {title: 'Reject version ' + Number(item.pending && item.pending.version) + ' of ' + item.name + '?',
        body: 'It won’t reach the company. ' + (item.live ? 'The live version stays live. ' : '') + 'The publisher can send a new version.', confirmLabel: 'Reject', danger: true};
      case 'app-archive': return {title: 'Archive ' + item.name + '?', body: 'It leaves the catalog for everyone, and colleagues can no longer open it from there. Its file is not deleted.', confirmLabel: 'Archive', danger: true};
      case 'session-end': return {title: 'End ' + (item.name || 'this session') + '?',
        body: 'This closes the session for everyone in it. Their tabs stay open on their own computers. Older versions of Mia ignore this, so someone on an older version may reopen it.',
        confirmLabel: 'End session', danger: true};
    }
    return null;
  }

  /* ============ team controls: automations ============ */

  var HUB_TONE = {good: 'ok', waiting: 'warn', attention: 'warn', working: 'warn', bad: 'bad', quiet: ''};

  function hubLiveVersion(workflow){
    if(Number.isSafeInteger(workflow.published) && workflow.published > 0) return 'Version ' + workflow.published;
    return workflow.published ? 'Live' : 'Nothing live yet';
  }
  function hubChannelLabel(channels, id){
    var channel = channels && channels[id];
    return channel && channel.name ? '#' + channel.name : 'A channel you have not joined';
  }

  function renderHubWorkflow(entry, st){
    var workflow = entry.workflow, proposal = entry.proposal, people = st.people, status = wf.workflowStatus(workflow), busy = st.busy || {};
    var id = workflow.id, trigger = workflow.definition && workflow.definition.trigger;
    var versionBusy = !!busy['wf-version:' + id], html = '<div class="card hub-item"><div class="hub-item-head"><div class="hub-item-title">' + esc(workflow.name) + '</div>' +
      '<div class="hub-item-pills">' + hubPill(status.label, HUB_TONE[status.tone]) + (proposal && workflow.published ? hubPill('Version waiting', 'warn') : '') + '</div></div>' +
      '<div class="hub-item-text">' + esc(trigger ? wf.triggerLine(trigger) : 'No approved version yet') + '</div>' +
      '<div class="hub-item-meta">' + esc(hubChannelLabel(st.channels, workflow.channel_id)) + ' · Live: ' + esc(hubLiveVersion(workflow)) + '</div>';
    if(!entry.detail) html += '<div class="hub-item-meta">Mia could not check this workflow for a version waiting for approval.</div>';
    if(proposal){
      var steps = (proposal.definition && proposal.definition.steps) || [];
      html += '<div class="hub-review"><div class="hub-review-title">Version ' + Number(proposal.version) + ' is waiting for approval</div>' +
        '<div class="hub-item-meta">Proposed by ' + esc(wf.displayName(people, proposal.proposed_by)) + '. It goes live once an admin approves it. Runs already in progress keep their version.</div>' +
        '<div class="hub-item-meta">' + esc(wf.triggerLine(proposal.definition && proposal.definition.trigger)) + '</div>' +
        (steps.length ? '<ol>' + steps.map(function(step){
          return '<li>' + esc(step.text) + ' <span class="hub-item-meta">(' + esc(wf.shortName(people, step.ownerMemberId)) + ')</span></li>';
        }).join('') + '</ol>' : '') +
        '<div class="hub-item-actions">' + hubButton('Approve', 'wf-approve', id, {tone: 'primary', version: proposal.version, disabled: versionBusy}) +
        hubButton('Reject', 'wf-reject', id, {version: proposal.version, disabled: versionBusy}) + '</div></div>';
    }
    html += '<div class="hub-item-actions">' +
      (workflow.published ? hubButton(workflow.enabled ? 'Pause' : 'Resume', 'wf-toggle', id, {disabled: !!busy['wf-toggle:' + id]}) : '') +
      hubButton('Archive', 'wf-archive', id, {tone: 'danger', disabled: !!busy['wf-archive:' + id]}) + '</div></div>';
    return html;
  }

  function renderHubAutomations(st, now){
    var list = st.workflows || [], people = st.people || {}, approvals = st.approvals || [], runs = (st.runs || []).slice(0, 25);
    var html = '';
    if(approvals.length || st.approvalsError){
      html += hubSectionHead('Waiting for approval', 'The named approver decides each of these in Mia.');
      html += st.approvalsError ? hubStateHtml(st.approvalsError.message, 'automations', st.approvalsError.retry) : '<div class="hub-list">' + approvals.map(function(approval){
        return '<div class="card hub-item"><div class="hub-item-head"><div class="hub-item-title">' + esc(approval.workflow_name) + '</div>' + hubPill('Waiting', 'warn') + '</div>' +
          '<div class="hub-item-text">Step ' + esc(approval.step_n) + ': ' + esc(approval.step_text) + '</div>' +
          '<div class="hub-item-meta">Waiting for ' + esc(wf.shortName(people, approval.approver_id)) + (approval.created_at ? ' · ' + esc(wf.sinceText(approval.created_at, now)) : '') + '</div></div>';
      }).join('') + '</div>';
    }
    html += hubSectionHead('Workflows', list.length ? list.length + (list.length === 1 ? ' workflow' : ' workflows') : '');
    html += list.length ? '<div class="hub-list">' + list.map(function(entry){ return renderHubWorkflow(entry, Object.assign({}, st, {people: people})); }).join('') + '</div>'
      : '<div class="card hub-state"><p>No automations yet. A workflow someone creates in Mia shows up here.</p></div>';
    html += hubSectionHead('Recent runs');
    if(st.runsError) html += hubStateHtml(st.runsError.message, 'automations', st.runsError.retry);
    else if(!runs.length) html += '<div class="card hub-state"><p>No runs yet.</p></div>';
    else html += '<div class="card admin-table-wrap"><table class="admin-table hub-files-table"><thead><tr><th>Workflow</th><th>State</th><th>Now</th><th>Started by</th><th>Started</th></tr></thead><tbody>' +
      runs.map(function(run){
        var state = wf.runState(run.state);
        return '<tr><td><div class="admin-cell-name">' + esc(run.workflow_name) + '</div><div class="admin-cell-sub">' + esc(run.summary || '') + '</div></td>' +
          '<td>' + hubPill(state.label, HUB_TONE[state.tone]) + '</td>' +
          '<td class="admin-cell-sub">' + esc(wf.isOpenRun(run) ? wf.runLine(run, people, now) : (run.final_note || '')) + '</td>' +
          '<td class="admin-cell-sub">' + esc(wf.shortName(people, run.started_by)) + '</td>' +
          '<td class="admin-cell-sub">' + esc(fmtDate(hubTime(run.created_at))) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    return html;
  }

  /* ============ team controls: files ============ */

  var HUB_FILE_CURSOR = /^[1-9][0-9]{0,14}\/[a-f0-9]{32}$/;

  function hubFileWhere(file){
    var name = file.spaceName;
    switch(file.spaceKind){
      case 'channel': return name ? '#' + name : 'A channel';
      case 'group': return name ? 'Group: ' + name : 'A group';
      case 'dm': return 'A direct message';
      case 'automation': return name ? 'Workflow: ' + name : 'A workflow';
      case 'app': return file.appName ? 'App: ' + file.appName : 'A company app';
      default: return 'Company files';
    }
  }
  function hubFileScan(file){
    if(file.state === 'deleting') return {label: 'Deleting', tone: ''};
    if(file.state === 'reserved' || file.state === 'uploading') return {label: 'Uploading', tone: ''};
    var verdict = tf.scanVerdict(file);
    if(verdict === 'clean') return {label: 'Clean', tone: 'ok'};
    if(verdict === 'pending') return {label: 'Scanning', tone: 'warn'};
    return {label: file.scanStatus === 'THREATS_FOUND' ? 'Threat found' : 'Could not scan', tone: 'bad'};
  }
  function hubUsageHtml(st){
    if(st.usageError) return '<div class="card hub-usage"><div class="hub-usage-text">Storage used is not available right now.</div></div>';
    var usage = st.usage;
    if(!usage) return '';
    var percent = Math.min(100, Math.round(usage.usedBytes / usage.quotaBytes * 100));
    return '<div class="card hub-usage' + (percent >= 100 ? ' full' : percent >= 90 ? ' high' : '') + '">' +
      '<div class="hub-usage-text">' + esc(tf.formatBytes(usage.usedBytes)) + ' of ' + esc(tf.formatBytes(usage.quotaBytes)) + ' used</div>' +
      '<div class="hub-usage-bar" role="progressbar" aria-label="Company file storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + Math.max(percent, usage.usedBytes > 0 ? 1 : 0) + '%"></span></div></div>';
  }
  function renderHubFiles(st){
    var list = st.files || [], busy = st.busy || {};
    var html = hubUsageHtml(st);
    if(!list.length) return html + '<div class="card hub-state"><p>No company files yet.</p></div>';
    html += '<div class="card admin-table-wrap"><table class="admin-table hub-files-table"><thead><tr><th>File</th><th>Size</th><th>Where it lives</th><th>Uploaded by</th><th>Date</th><th>Scan</th><th></th></tr></thead><tbody>' +
      list.map(function(file){
        var scan = hubFileScan(file), uploader = file.uploader && file.uploader.name;
        return '<tr><td class="hub-filename">' + esc(file.filename) + '</td>' +
          '<td class="admin-cell-sub">' + esc(tf.formatBytes(file.sizeBytes)) + '</td>' +
          '<td class="admin-cell-sub">' + esc(hubFileWhere(file)) + '</td>' +
          '<td class="admin-cell-sub">' + esc(uploader || 'A former colleague') + '</td>' +
          '<td class="admin-cell-sub">' + esc(fmtDate(hubTime(file.createdAt))) + '</td>' +
          '<td>' + hubPill(scan.label, scan.tone) + '</td>' +
          '<td class="admin-row-control">' + (file.state === 'deleting' ? '' : hubButton('Delete', 'file-delete', file.fileId, {tone: 'danger', disabled: !!busy['file-delete:' + file.fileId]})) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if(st.nextCursor || st.moreError){
      html += '<div class="hub-more">' + (st.moreError ? '<span>Mia could not load more files.</span>' : '') +
        hubButton(st.loadingMore ? 'Loading…' : st.moreError ? 'Try again' : 'Load more', 'files-more', 'files', {disabled: !!st.loadingMore}) + '</div>';
    }
    return html;
  }

  /* ============ team controls: apps ============ */

  function hubAppVersionSize(version){
    return version.kind === 'link' ? {label: 'Address', value: version.url || ''} : {label: 'Size', value: tf.formatBytes(version.sizeBytes)};
  }
  var HUB_APP_SCAN = {
    clean: {text: 'Clean. Ready to approve.', tone: 'ok', approve: true},
    pending: {text: 'Still being scanned for viruses. You can approve it once it is clean.', tone: 'warn', approve: false},
    blocked: {text: 'Failed the virus scan. It can’t be approved.', tone: 'bad', approve: false},
    unknown: {text: 'Mia could not check the scan. The company server checks again when you approve.', tone: 'warn', approve: true}
  };
  function hubAppReadiness(version, scans){
    if(version.kind === 'link') return {text: 'No file to scan. This is a web address.', tone: '', approve: true};
    return HUB_APP_SCAN[(scans && scans[version.fileId]) || 'unknown'];
  }
  function hubFact(label, value, className){
    return value ? '<dt>' + esc(label) + '</dt><dd' + (className ? ' class="' + className + '"' : '') + '>' + esc(value) + '</dd>' : '';
  }
  function hubAppFacts(app, version, readiness){
    var size = hubAppVersionSize(version);
    return '<dl class="hub-facts">' + hubFact('Published by', app.publisher && app.publisher.name || 'A former colleague') +
      hubFact('Kind', version.kind === 'link' ? 'Web address' : 'App file') +
      hubFact(size.label, size.value, version.kind === 'link' ? 'hub-address' : '') +
      hubFact('Note', version.note) +
      (readiness ? hubFact('Scan', readiness.text, readiness.tone ? 'hub-ready-' + readiness.tone : '') : '') + '</dl>';
  }
  // A rejected version stays on the app until a new one replaces it, but nothing waits on it.
  function hubAppWaiting(app){ return !!(app.pending && app.pending.state !== 'rejected'); }
  function renderHubApp(app, st){
    var busy = st.busy || {}, rejected = app.pending && !hubAppWaiting(app) ? app.pending : null, pending = rejected ? null : app.pending, live = app.live;
    var html = '<div class="card hub-item"><div class="hub-item-head"><div class="hub-item-title">' + esc(app.name) + '</div><div class="hub-item-pills">' +
      (pending ? hubPill('Waiting for review', 'warn') : '') + (live ? hubPill('Live', 'ok') : '') + (rejected ? hubPill('Not approved', '') : '') + (!pending && !live && !rejected ? hubPill('Not live', '') : '') + '</div></div>' +
      (app.description ? '<div class="hub-item-text">' + esc(app.description) + '</div>' : '');
    if(pending){
      var readiness = hubAppReadiness(pending, st.scans), versionBusy = !!busy['app-version:' + app.id];
      html += '<div class="hub-review"><div class="hub-review-title">Version ' + Number(pending.version) + (live ? ' would replace the live version' : ' is waiting for review') + '</div>' +
        hubAppFacts(app, pending, readiness) +
        '<div class="hub-item-meta">Approving makes this run on every colleague’s computer.' + (live ? ' Version ' + Number(live.version) + ' stays live until then.' : '') + '</div>' +
        '<div class="hub-item-actions">' + hubButton('Review', 'app-review', app.id) + hubButton('Approve for everyone', 'app-approve', app.id, {tone: 'primary', version: pending.version, disabled: versionBusy || !readiness.approve}) +
        hubButton('Reject', 'app-reject', app.id, {version: pending.version, disabled: versionBusy}) + '</div></div>';
    }
    if(rejected) html += '<div class="hub-item-meta" style="margin-top:8px">Version ' + Number(rejected.version) + ' was rejected. The publisher can send a new version.</div>';
    if(live) html += '<div class="hub-item-meta" style="margin-top:8px">Live: version ' + Number(live.version) + '</div>' + hubAppFacts(app, live);
    html += '<div class="hub-item-actions">' + hubButton('Archive', 'app-archive', app.id, {tone: 'danger', disabled: !!busy['app-archive:' + app.id]}) + '</div></div>';
    return html;
  }
  function renderHubApps(st){
    var list = st.apps || [];
    if(!list.length) return '<div class="card hub-state"><p>No apps yet. An app a colleague publishes shows up here for review.</p></div>';
    var waiting = list.filter(hubAppWaiting).length;
    return hubSectionHead('Catalog', list.length + (list.length === 1 ? ' app' : ' apps') + (waiting ? ' · ' + waiting + ' waiting for review' : '')) +
      '<div class="hub-list">' + list.map(function(app){ return renderHubApp(app, st); }).join('') + '</div>';
  }

  /* ============ team controls: browser sessions ============ */

  var HUB_SESSION_SPACE = /^[a-z0-9]{6,32}$/;
  var HUB_ENDED_HIDE_MS = 20000;
  var HUB_SESSION_LIMIT = 50;

  function hubSessionKey(session){ return session.channelId + '/' + session.spaceId; }
  function hubSessionEndable(session){ return HUB_ID.test(session.channelId || '') && HUB_SESSION_SPACE.test(session.spaceId || ''); }
  function renderHubSessions(st, now){
    var list = st.sessions || [], busy = st.busy || {};
    var note = '<div class="hub-note">Ending a session closes it for everyone in it, and their tabs stay open on their own computers. Older versions of Mia ignore this, so someone on an older version may reopen it, and it would show up here again. Page addresses are never shown here. In a very busy channel a live session might not be listed.</div>';
    if(!list.length) return note + '<div class="card hub-state"><p>No live browser sessions found.</p></div>';
    if(list.length >= HUB_SESSION_LIMIT) note += '<div class="hub-note">Showing the ' + HUB_SESSION_LIMIT + ' most recent sessions.</div>';
    return note + '<div class="card admin-table-wrap"><table class="admin-table hub-sessions-table"><thead><tr><th>Session</th><th>Channel</th><th>Started by</th><th>In it now</th><th>Tabs</th><th>Last seen</th><th></th></tr></thead><tbody>' +
      list.map(function(session){
        var key = hubSessionKey(session), people = (session.people || []).map(function(person){ return person && person.name || 'A colleague'; });
        return '<tr><td class="admin-cell-name">' + esc(session.name || 'Shared tabs') + '</td>' +
          '<td class="admin-cell-sub">' + esc(session.channelName ? '#' + session.channelName : 'A direct message') + '</td>' +
          '<td class="admin-cell-sub">' + esc(session.startedBy && session.startedBy.name || 'Not known') + '</td>' +
          '<td class="admin-cell-sub">' + esc(people.length ? people.join(', ') : 'Nobody') + '</td>' +
          '<td class="admin-cell-sub">' + esc(session.tabCount != null ? session.tabCount : '—') + '</td>' +
          '<td class="admin-cell-sub">' + esc(wf.sinceText(session.lastSeenAt, now) || '—') + '</td>' +
          '<td class="admin-row-control">' + (hubSessionEndable(session)
            ? hubButton('End', 'session-end', key, {tone: 'danger', disabled: !!busy['session-end:' + key]})
            : '<span class="admin-row-protected">Can’t be ended here</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ============ team controls: loading and actions, no DOM ============ */

  // Holds each view's data and runs every Hub call, so screens only draw it.
  // options: {teamId, call(method, path, body), confirm(copy) -> Promise<bool>, toast(text, isError), onChange(view), now()}
  function createHubAdmin(options){
    var call = options.call, base = '/v1/teams/' + options.teamId;
    var now = options.now || function(){ return Date.now(); };
    var workflows = wf.createClient({teamId: options.teamId, call: call});
    var files = tf.createClient({teamId: options.teamId, call: call});
    var state = {};
    HUB_VIEWS.forEach(function(view){ state[view] = {loaded: false, error: null, busy: {}, token: 0, inflight: null, updatedAt: 0}; });

    function changed(view){ if(options.onChange) options.onChange(view); }
    var loaders = {};

    function load(view, opts){
      var st = state[view];
      if(st.inflight && !(opts && opts.force)) return st.inflight;
      var token = ++st.token;
      var run = Promise.resolve().then(loaders[view]).then(function(apply){
        if(token !== st.token) return;
        apply();
        st.loaded = true; st.error = null; st.updatedAt = now();
      }, function(error){
        if(token !== st.token) return;
        st.error = hubLoadError(error);
        // Lost access, or the route is gone: leave no controls that can't work.
        if(st.error.kind === 'forbidden' || st.error.kind === 'missing') st.loaded = false;
      }).then(function(){
        if(token !== st.token) return;
        st.inflight = null;
        changed(view);
      });
      st.inflight = run;
      changed(view);
      return run;
    }

    // Confirm first, then one call at a time per control; a failure also re-reads,
    // since it usually means someone else changed the thing first.
    function perform(view, key, copy, work, done, failText){
      var st = state[view];
      if(st.busy[key]) return Promise.resolve();
      return (copy ? options.confirm(copy) : Promise.resolve(true)).then(function(ok){
        if(!ok) return;
        st.busy[key] = true;
        changed(view);
        return Promise.resolve().then(work).then(function(result){
          delete st.busy[key];
          return done(result);
        }, function(error){
          delete st.busy[key];
          options.toast(failText(error), true);
          return load(view, {force: true});
        });
      });
    }

    var actions = {
      retry: function(view){ return load(view, {force: true}); }
    };

    /* ---- automations ---- */
    loaders.automations = function(){
      function optional(promise){ return promise.then(function(value){ return {value: value}; }, function(error){ return {error: hubLoadError(error)}; }); }
      return Promise.all([workflows.workflows(), optional(workflows.members()), optional(workflows.channels()), optional(workflows.runs('all')), optional(workflows.approvals('pending'))]).then(function(results){
        var list = (results[0] && results[0].workflows || []).filter(function(item){ return item && HUB_ID.test(item.id || ''); });
        // Only the detail route lists versions, and it is where a waiting one shows.
        return hubMapPool(list, 6, function(item){
          return workflows.workflow(item.id).then(function(reply){ return reply && reply.workflow || null; }, function(){ return null; });
        }).then(function(details){
          return function(){
            var st = state.automations, names = {};
            ((results[2].value && results[2].value.channels) || []).forEach(function(channel){ if(channel && channel.id) names[channel.id] = channel; });
            st.workflows = list.map(function(item, index){ return {workflow: item, detail: details[index], proposal: details[index] ? wf.latestProposal(details[index]) : null}; })
              .sort(function(a, b){ return (b.proposal ? 1 : 0) - (a.proposal ? 1 : 0) || String(a.workflow.name).localeCompare(String(b.workflow.name)); });
            st.people = wf.directory(results[1].value && results[1].value.members);
            st.channels = names;
            st.runs = (results[3].value && results[3].value.runs) || [];
            st.runsError = results[3].error || null;
            st.approvals = (results[4].value && results[4].value.approvals) || [];
            st.approvalsError = results[4].error || null;
          };
        });
      });
    };
    function workflowEntry(id){ return (state.automations.workflows || []).filter(function(entry){ return entry.workflow.id === id; })[0]; }
    function workflowFail(fallback){ return function(error){ return wf.errorMessage(error, fallback); }; }
    function afterWorkflow(text){ return function(){ options.toast(text); return load('automations', {force: true}); }; }
    actions['wf-toggle'] = function(id){
      var entry = workflowEntry(id); if(!entry) return Promise.resolve();
      var on = !entry.workflow.enabled;
      return perform('automations', 'wf-toggle:' + id, null, function(){ return workflows.setEnabled(id, on); },
        afterWorkflow((on ? 'Resumed ' : 'Paused ') + entry.workflow.name), workflowFail('Mia could not change this workflow.'));
    };
    actions['wf-archive'] = function(id){
      var entry = workflowEntry(id); if(!entry) return Promise.resolve();
      return perform('automations', 'wf-archive:' + id, hubConfirmCopy('wf-archive', entry.workflow), function(){ return workflows.archive(id); },
        afterWorkflow('Archived ' + entry.workflow.name), workflowFail('Mia could not archive this workflow.'));
    };
    ['approve', 'reject'].forEach(function(decision){
      actions['wf-' + decision] = function(id, version){
        var entry = workflowEntry(id); if(!entry) return Promise.resolve();
        if(!entry.proposal || entry.proposal.version !== version) return load('automations', {force: true});
        return perform('automations', 'wf-version:' + id, hubConfirmCopy('wf-' + decision, entry.workflow, {version: version}), function(){
          return decision === 'approve' ? workflows.approveVersion(id, version) : workflows.rejectVersion(id, version);
        }, afterWorkflow((decision === 'approve' ? 'Approved' : 'Rejected') + ' version ' + version + ' of ' + entry.workflow.name), workflowFail('Mia could not save your decision.'));
      };
    });

    /* ---- files ---- */
    function cleanFile(file){
      return file && HUB_ID.test(file.fileId || '') && typeof file.filename === 'string' ? file : null;
    }
    function fileList(reply){
      return {files: (reply && Array.isArray(reply.files) ? reply.files : []).filter(cleanFile),
        nextCursor: reply && typeof reply.nextCursor === 'string' && HUB_FILE_CURSOR.test(reply.nextCursor) ? reply.nextCursor : null};
    }
    function refreshUsage(){
      var st = state.files;
      return files.usage().then(function(usage){ st.usage = usage; st.usageError = false; }, function(){ st.usageError = true; }).then(function(){ changed('files'); });
    }
    loaders.files = function(){
      var usage = files.usage().then(function(value){ return {value: value}; }, function(){ return {failed: true}; });
      return Promise.all([call('GET', base + '/files/admin'), usage]).then(function(results){
        return function(){
          var st = state.files, page = fileList(results[0]);
          st.files = page.files; st.nextCursor = page.nextCursor; st.moreError = false; st.loadingMore = false;
          st.usage = results[1].value || st.usage || null; st.usageError = !!results[1].failed;
        };
      });
    };
    actions['files-more'] = function(){
      var st = state.files, token = st.token, cursor = st.nextCursor;
      if(st.loadingMore || !cursor) return Promise.resolve();
      st.loadingMore = true; st.moreError = false;
      changed('files');
      return call('GET', base + '/files/admin/before/' + cursor).then(function(reply){
        if(token !== st.token) return;
        var page = fileList(reply), seen = {};
        st.files.forEach(function(file){ seen[file.fileId] = true; });
        st.files = st.files.concat(page.files.filter(function(file){ return !seen[file.fileId]; }));
        st.nextCursor = page.nextCursor; st.loadingMore = false;
        changed('files');
      }, function(){
        if(token !== st.token) return;
        st.loadingMore = false; st.moreError = true;
        changed('files');
      });
    };
    actions['file-delete'] = function(id){
      var st = state.files, file = (st.files || []).filter(function(item){ return item.fileId === id; })[0];
      if(!file || file.state === 'deleting') return Promise.resolve();
      function gone(){ st.files = st.files.filter(function(item){ return item.fileId !== id; }); changed('files'); return refreshUsage(); }
      return perform('files', 'file-delete:' + id, hubConfirmCopy('file-delete', file), function(){
        return files.remove(id).catch(function(error){
          // Someone else already removed it; that is the outcome the admin wanted.
          if(error && error.status === 404) return {alreadyGone: true};
          throw error;
        });
      }, function(result){
        options.toast(result && result.alreadyGone ? file.filename + ' was already deleted' : 'Deleted ' + file.filename);
        return gone();
      }, function(error){ return tf.friendly(error); });
    };

    /* ---- apps ---- */
    function cleanVersion(version){
      return version && Number.isSafeInteger(version.version) && version.version > 0 ? version : null;
    }
    loaders.apps = function(){
      return call('GET', base + '/apps').then(function(reply){
        var list = (reply && Array.isArray(reply.apps) ? reply.apps : []).filter(function(app){ return app && HUB_ID.test(app.id || '') && typeof app.name === 'string'; })
          .map(function(app){ return Object.assign({}, app, {live: cleanVersion(app.live), pending: cleanVersion(app.pending)}); })
          .sort(function(a, b){ return (hubAppWaiting(b) ? 1 : 0) - (hubAppWaiting(a) ? 1 : 0) || a.name.localeCompare(b.name); });
        var bundles = list.filter(function(app){ return hubAppWaiting(app) && app.pending.kind !== 'link' && HUB_ID.test(app.pending.fileId || ''); });
        // Scan state lives on the file, so look before offering Approve.
        return hubMapPool(bundles, 4, function(app){
          return files.status(app.pending.fileId).then(function(reply){ return tf.scanVerdict(reply); }, function(){ return 'unknown'; });
        }).then(function(verdicts){
          return function(){
            var scans = {};
            bundles.forEach(function(app, index){ scans[app.pending.fileId] = verdicts[index]; });
            state.apps.apps = list; state.apps.scans = scans;
          };
        });
      });
    };
    function appById(id){ return (state.apps.apps || []).filter(function(app){ return app.id === id; })[0]; }
    function appFail(error){
      if(error && error.status === 404) return 'This app changed or was removed. Check the list and try again.';
      return tf.friendly(error);
    }
    function afterApp(text){ return function(){ options.toast(text); return load('apps', {force: true}); }; }
    ['approve', 'reject'].forEach(function(decision){
      actions['app-' + decision] = function(id, version){
        var app = appById(id);
        if(!app) return Promise.resolve();
        if(!hubAppWaiting(app) || app.pending.version !== version) return load('apps', {force: true});
        if(decision === 'approve' && !hubAppReadiness(app.pending, state.apps.scans).approve) return Promise.resolve();
        return perform('apps', 'app-version:' + id, hubConfirmCopy('app-' + decision, app), function(){
          return call('POST', base + '/apps/' + id + '/versions/' + version + '/' + decision, {});
        }, afterApp((decision === 'approve' ? 'Approved ' : 'Rejected version ' + version + ' of ') + app.name), appFail);
      };
    });
    actions['app-review'] = function(id){
      if(options.openReview && appById(id)) options.openReview(id);
      return Promise.resolve();
    };
    actions['app-archive'] = function(id){
      var app = appById(id);
      if(!app) return Promise.resolve();
      return perform('apps', 'app-archive:' + id, hubConfirmCopy('app-archive', app), function(){
        return call('DELETE', base + '/apps/' + id, {});
      }, afterApp('Archived ' + app.name), appFail);
    };

    /* ---- browser sessions ---- */
    state.sessions.hidden = {};
    loaders.sessions = function(){
      return call('GET', base + '/browser-sessions').then(function(reply){
        return function(){
          var st = state.sessions, at = now();
          // Hub rows can lag a moment behind an End. After that the Hub is right,
          // including when someone on an older version has reopened the session.
          Object.keys(st.hidden).forEach(function(key){ if(st.hidden[key] <= at) delete st.hidden[key]; });
          st.sessions = (reply && Array.isArray(reply.sessions) ? reply.sessions : []).filter(function(session){
            return session && typeof session.channelId === 'string' && typeof session.spaceId === 'string' && !st.hidden[hubSessionKey(session)];
          });
        };
      });
    };
    actions['session-end'] = function(key){
      var st = state.sessions, session = (st.sessions || []).filter(function(item){ return hubSessionKey(item) === key; })[0];
      if(!session || !hubSessionEndable(session)) return Promise.resolve();
      function finish(text){
        st.hidden[key] = now() + HUB_ENDED_HIDE_MS;
        st.sessions = st.sessions.filter(function(item){ return hubSessionKey(item) !== key; });
        options.toast(text);
        return load('sessions', {force: true});
      }
      return perform('sessions', 'session-end:' + key, hubConfirmCopy('session-end', session), function(){
        return call('POST', base + '/browser-sessions/' + session.channelId + '/' + session.spaceId + '/end', {}).catch(function(error){
          if(error && error.status === 404) return {alreadyGone: true};
          throw error;
        });
      }, function(result){
        return finish(result && result.alreadyGone ? 'That session had already ended' : 'Ended ' + (session.name || 'the session'));
      }, function(error){ return wf.errorMessage(error, 'Mia could not end this session.'); });
    };

    return {
      state: state,
      load: load,
      act: function(action, id, version){
        var run = actions[action];
        return run ? run(id, version == null ? null : Number(version)) : Promise.resolve();
      }
    };
  }

  /* ============ DOM-dependent runtime (browser only) ============ */

  function initBrowser(win){
    var doc = win.document;
    var toastTimer = null;
    var usersState = {
      items: [],
      search: '',
      selected: Object.create(null),
      currentAdminEmail: '',
      busy: false
    };
    var agentsState = {
      items: [],
      search: '',
      loading: false
    };
    // Set when the Admin Center manages a shared team instead of the local list.
    var team = null;
    function $(sel, root2){ return (root2 || doc).querySelector(sel); }
    function $all(sel, root2){ return Array.prototype.slice.call((root2 || doc).querySelectorAll(sel)); }

    function toast(message, isErr){
      var el = $('#adminToast');
      if(!el) return;
      el.textContent = message;
      el.classList.toggle('err', !!isErr);
      el.classList.add('show');
      if(toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 3200);
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
          if(r.status < 200 || r.status >= 300){
            var msg = (data && (data.error || data.message)) || ('Request failed (' + r.status + ')');
            toast(msg, true);
            var err = new Error(msg);
            err.status = r.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      });
    }

    var call = api;

    function hub(method, path, body){
      return win.MiaHubChat.call(method, '/v1/teams/' + team.id + path, body).catch(function(error){
        toast(error.message, true);
        throw error;
      });
    }

    /* ---- navigation ---- */
    function showView(name){
      $all('.admin-nav-item').forEach(function(btn){
        btn.classList.toggle('active', btn.getAttribute('data-view') === name);
      });
      $all('.admin-view').forEach(function(sec){
        sec.classList.toggle('active', sec.getAttribute('data-view') === name);
      });
      win.location.hash = '#/' + name;
      if(name === 'users') loadUsers();
      if(name === 'agents') loadAgents();
      if(name === 'invites') loadInvites();
      if(name === 'activity') loadActivity();
      if(hubAdmin && HUB_VIEWS.indexOf(name) !== -1) hubAdmin.load(name);
    }

    function currentViewFromHash(){
      return adminViewFromHash(win.location.hash, !!team);
    }

    /* ---- overview ---- */
    var overviewTimer = null;
    function loadOverview(){
      if(team){
        Promise.all([hub('GET', '/members'), hub('GET', '/invites'), hub('GET', '/channels')]).then(function(results){
          var tiles = $('#overviewTiles');
          if(tiles) tiles.innerHTML = renderTeamOverviewTiles({name: team.name, members: results[0].members,
            seats: results[1].seats, channels: results[2].channels});
          var updated = $('#overviewUpdated');
          if(updated) updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
        }).catch(function(){});
        return;
      }
      call('/api/admin/overview').then(function(overview){
        var tiles = $('#overviewTiles');
        if(tiles) tiles.innerHTML = renderOverviewTiles(overview);
        var updated = $('#overviewUpdated');
        if(updated) updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      }).catch(function(){});
    }

    function startAutoRefresh(){
      if(overviewTimer) clearInterval(overviewTimer);
      overviewTimer = setInterval(function(){
        if(currentViewFromHash() === 'overview' && !doc.hidden) loadOverview();
      }, team ? 30000 : 10000);
      if(team) setInterval(refreshOpenSessions, SESSION_REFRESH_MS);
    }

    /* ---- team controls ---- */
    var hubAdmin = null;
    var hubPainted = {};
    var hubConfirmResolve = null;
    var hubConfirmOpener = null;

    function refreshOpenSessions(){
      if(hubAdmin && currentViewFromHash() === 'sessions' && !doc.hidden) hubAdmin.load('sessions');
    }

    // A refresh must not take the keyboard away from whoever is on a button.
    function hubButtonKey(el){
      return el && el.getAttribute && el.getAttribute('data-hub-action')
        ? [el.getAttribute('data-hub-action'), el.getAttribute('data-hub-id'), el.getAttribute('data-hub-version')].join('|') : '';
    }
    function hubFindButton(key){
      return key ? $all('button[data-hub-action]').filter(function(btn){ return hubButtonKey(btn) === key; })[0] : null;
    }
    function hubPaint(view){
      var body = $('[data-hub-body="' + view + '"]'), st = hubAdmin.state[view];
      if(!body) return;
      var html = renderHubView(view, st, Date.now());
      if(html !== hubPainted[view]){
        var focused = hubButtonKey(doc.activeElement);
        hubPainted[view] = html;
        body.innerHTML = html;
        var again = hubFindButton(focused);
        if(again && !again.disabled) again.focus();
      }
      var updated = $('#hub' + view.charAt(0).toUpperCase() + view.slice(1) + 'Updated');
      if(updated) updated.textContent = st.updatedAt ? 'Updated ' + new Date(st.updatedAt).toLocaleTimeString() : '';
    }

    function hubConfirm(copy){
      if(hubConfirmResolve) hubConfirmClose(false);
      hubConfirmOpener = doc.activeElement;
      $('#hubConfirmTitle').textContent = copy.title;
      $('#hubConfirmBody').textContent = copy.body;
      var detail = $('#hubConfirmDetail');
      detail.textContent = copy.detail || '';
      detail.hidden = !copy.detail;
      var ok = $('#hubConfirmOk');
      ok.textContent = copy.confirmLabel;
      ok.className = 'btn ' + (copy.danger ? 'danger-solid' : 'primary');
      openOverlay('hubConfirmOverlay');
      $('#hubConfirmCancel').focus();
      return new Promise(function(resolve){ hubConfirmResolve = resolve; });
    }
    function hubConfirmClose(answer){
      var resolve = hubConfirmResolve, opener = hubConfirmOpener;
      hubConfirmResolve = null; hubConfirmOpener = null;
      closeOverlay('hubConfirmOverlay');
      if(opener && opener.focus && !opener.disabled) opener.focus();
      if(resolve) resolve(answer);
    }
    function wireHubAdmin(){
      $all('[data-hub-body]').forEach(function(body){
        body.addEventListener('click', function(ev){
          var btn = ev.target.closest && ev.target.closest('button[data-hub-action]');
          if(!btn || btn.disabled) return;
          hubAdmin.act(btn.getAttribute('data-hub-action'), btn.getAttribute('data-hub-id'), btn.getAttribute('data-hub-version'));
        });
      });
      $all('[data-hub-refresh]').forEach(function(btn){
        btn.addEventListener('click', function(){ hubAdmin.load(btn.getAttribute('data-hub-refresh'), {force: true}); });
      });
      $('#hubConfirmCancel').addEventListener('click', function(){ hubConfirmClose(false); });
      $('#hubConfirmOk').addEventListener('click', function(){ hubConfirmClose(true); });
      var overlay = $('#hubConfirmOverlay');
      overlay.addEventListener('click', function(ev){ if(ev.target === overlay) hubConfirmClose(false); });
      overlay.addEventListener('keydown', function(ev){
        if(ev.key === 'Escape') hubConfirmClose(false);
        if(ev.key === 'Tab'){
          // Two buttons, so Tab just moves between them and stays in the dialog.
          ev.preventDefault();
          (doc.activeElement === $('#hubConfirmOk') ? $('#hubConfirmCancel') : $('#hubConfirmOk')).focus();
        }
      });
      doc.addEventListener('visibilitychange', refreshOpenSessions);
    }

    /* ---- users ---- */
    function isCurrentAdminEmail(email){
      return normalizeEmail(email) === usersState.currentAdminEmail;
    }

    function visibleAdminUsers(){
      return filterAdminUsers(usersState.items, usersState.search);
    }

    function selectedAdminUsers(){
      return usersState.items.filter(function(user){
        var email = normalizeEmail(user && user.email);
        return !!email && !!usersState.selected[email] && !isCurrentAdminEmail(email);
      });
    }

    function syncUsersControls(){
      var selected = selectedAdminUsers();
      var visible = visibleAdminUsers();
      var selectableVisible = visible.filter(function(user){
        var email = normalizeEmail(user && user.email);
        return !!email && !isCurrentAdminEmail(email);
      });
      var selectedVisible = selectableVisible.filter(function(user){
        return !!usersState.selected[normalizeEmail(user.email)];
      });
      var hiddenSelected = selected.length - selectedVisible.length;
      var countEl = $('#usersSelectionCount');
      var hintEl = $('#usersSelectionHint');
      var resultEl = $('#usersResultSummary');
      if(countEl) countEl.textContent = selected.length
        ? selected.length + ' user' + (selected.length === 1 ? '' : 's') + ' selected'
        : 'No users selected';
      if(hintEl){
        hintEl.textContent = selected.length
          ? (hiddenSelected ? hiddenSelected + ' selected outside the current filter.' : 'Actions apply to every selected user.')
          : 'Select users to enable bulk actions.';
      }
      if(resultEl){
        if(!usersState.items.length) resultEl.textContent = 'No users';
        else if(String(usersState.search || '').trim()) resultEl.textContent = visible.length
          ? 'Showing ' + visible.length + ' of ' + usersState.items.length + ' users'
          : 'No matching users';
        else if(team) resultEl.textContent = teamUsersSummary(usersState.items.length, usersState.seats);
        else resultEl.textContent = usersState.items.length + ' user' + (usersState.items.length === 1 ? '' : 's');
      }
      $all('[data-bulk-action]').forEach(function(btn){
        btn.disabled = usersState.busy || !selected.length;
      });
      var selectAll = $('#usersSelectAll');
      if(selectAll){
        selectAll.checked = selectableVisible.length > 0 && selectedVisible.length === selectableVisible.length;
        selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectableVisible.length;
        selectAll.disabled = usersState.busy || !selectableVisible.length;
      }
      $all('.admin-user-select').forEach(function(checkbox){
        checkbox.disabled = checkbox.getAttribute('data-selectable') !== 'true' || usersState.busy;
      });
    }

    function renderUsers(){
      var body = $('#usersBody');
      if(team){
        if(body) body.innerHTML = renderTeamUsersTable(usersState.items, {search: usersState.search, selfId: team.selfId, ownerId: usersState.ownerId});
        syncUsersControls();
        return;
      }
      if(body) body.innerHTML = renderUsersTable(usersState.items, {
        search: usersState.search,
        currentAdminEmail: usersState.currentAdminEmail,
        selectedEmails: usersState.selected,
        disableSelection: usersState.busy
      });
      syncUsersControls();
    }

    function loadUsers(){
      if(team){
        var seats = hub('GET', '/invites').then(function(result){ return result.seats; }, function(){ return null; });
        return Promise.all([hub('GET', '/members'), seats]).then(function(results){
          var result = results[0];
          usersState.seats = results[1];
          usersState.ownerId = result.owner_id || null;
          usersState.items = (result.members || []).map(function(m){
            return {clerk_user_id: m.clerk_user_id, email: m.email, role: m.role, department: m.department || ''};
          });
          renderUsers();
          return usersState.items;
        }, function(){ return []; });
      }
      return call('/api/admin/users').then(function(users){
        usersState.items = filterAdminUsers(Array.isArray(users) ? users : []);
        var available = Object.create(null);
        usersState.items.forEach(function(user){
          var email = normalizeEmail(user && user.email);
          if(email) available[email] = true;
        });
        Object.keys(usersState.selected).forEach(function(email){
          if(!available[email] || isCurrentAdminEmail(email)) delete usersState.selected[email];
        });
        renderUsers();
        return usersState.items;
      });
    }

    /* ---- agent roster ---- */
    function visibleAdminAgents(){
      return filterAdminAgents(agentsState.items, agentsState.search);
    }

    function syncAgentsControls(){
      var visible = visibleAdminAgents();
      var resultEl = $('#agentsResultSummary');
      if(!resultEl) return;
      if(agentsState.loading) resultEl.textContent = 'Loading bots…';
      else if(!agentsState.items.length) resultEl.textContent = 'No bots';
      else if(String(agentsState.search || '').trim()) resultEl.textContent = visible.length
        ? 'Showing ' + visible.length + ' of ' + agentsState.items.length + ' bots'
        : 'No matching bots';
      else resultEl.textContent = agentsState.items.length + ' bot' + (agentsState.items.length === 1 ? '' : 's');
    }

    function renderAgents(){
      var body = $('#agentsBody');
      if(body){
        body.innerHTML = agentsState.loading
          ? '<tr><td colspan="8" class="admin-empty">Loading bots…</td></tr>'
          : renderAgentsTable(agentsState.items, {search: agentsState.search});
      }
      syncAgentsControls();
    }

    function loadTeamAgents(){
      return win.MiaHubChat.teamBots(team.id).catch(function(error){
        toast(error.message, true);
        throw error;
      }).then(teamRosterAgents);
    }

    function loadAgents(){
      agentsState.loading = true;
      renderAgents();
      return (team ? loadTeamAgents() : call('/api/admin/agents')).then(function(payload){
        agentsState.items = Array.isArray(payload)
          ? payload
          : (payload && Array.isArray(payload.agents) ? payload.agents : []);
        agentsState.loading = false;
        renderAgents();
        return agentsState.items;
      }, function(error){
        agentsState.items = [];
        agentsState.loading = false;
        renderAgents();
        return [];
      });
    }

    function showResetPasswordLinks(results){
      var items = (results || []).filter(function(result){ return result && result.email; });
      if(!items.length) return;
      var title = $('#resetPwTitle');
      var hint = $('#resetPwHint');
      var single = $('#resetPwSingleLink');
      var bulk = $('#resetPwBulkLinks');
      var copy = $('#resetPwCopy');
      if(title) title.textContent = items.length === 1 ? 'Reset password link' : 'Reset password links';
      if(hint) hint.textContent = items.length === 1
        ? 'Share this link with the user:'
        : 'Share each link with the corresponding user:';
      if(items.length === 1){
        var singleItem = items[0];
        if(single) single.hidden = false;
        if(bulk){
          bulk.hidden = true;
          bulk.innerHTML = '';
        }
        $('#resetPwLink').textContent = singleItem.link || 'Link unavailable';
        if(copy){
          copy.disabled = !singleItem.link;
          copy.setAttribute('data-reset-link', singleItem.link || '');
        }
      } else {
        if(single) single.hidden = true;
        if(copy) copy.disabled = true;
        if(bulk){
          bulk.hidden = false;
          bulk.innerHTML = items.map(function(item){
            var link = item.link || '';
            return '<div class="admin-reset-result"><div class="admin-reset-result-user">' + esc(item.email) + '</div>' +
              '<div class="admin-link-box"><code>' + esc(link || 'Link unavailable') + '</code>' +
              (link ? '<button type="button" class="btn small" data-reset-link="' + esc(link) + '">Copy</button>' : '') +
              '</div></div>';
          }).join('');
        }
      }
      openOverlay('resetPwOverlay');
    }

    function requestBulkUserAction(action, user){
      var email = user.email;
      if(action === 'promote') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {role: 'admin'}});
      if(action === 'toggle-disabled') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {disabled: !user.disabled}});
      if(action === 'reset-password') return call('/api/admin/users/' + encodeURIComponent(email) + '/reset-password', {method: 'POST'});
      if(action === 'sign-out') return call('/api/admin/users/' + encodeURIComponent(email) + '/sessions', {method: 'DELETE'});
      return Promise.reject(new Error('Unknown bulk user action'));
    }

    function bulkUserAction(action){
      var selected = selectedAdminUsers();
      if(!selected.length){
        toast('Select at least one user first.', true);
        syncUsersControls();
        return Promise.resolve();
      }
      usersState.busy = true;
      syncUsersControls();
      return Promise.all(selected.map(function(user){
        return requestBulkUserAction(action, user).then(function(response){
          return {ok: true, user: user, response: response};
        }, function(error){
          return {ok: false, user: user, error: error};
        });
      })).then(function(results){
        var succeeded = results.filter(function(result){ return result.ok; });
        var failed = results.filter(function(result){ return !result.ok; });
        succeeded.forEach(function(result){
          delete usersState.selected[normalizeEmail(result.user.email)];
        });
        if(action === 'reset-password' && succeeded.length){
          showResetPasswordLinks(succeeded.map(function(result){
            return {email: result.user.email, link: result.response && result.response.link};
          }));
        }
        var message;
        if(failed.length){
          message = succeeded.length + ' completed; ' + failed.length + ' failed.';
        } else if(action === 'promote'){
          message = succeeded.length + ' user' + (succeeded.length === 1 ? '' : 's') + ' made admin.';
        } else if(action === 'toggle-disabled'){
          message = 'Access updated for ' + succeeded.length + ' user' + (succeeded.length === 1 ? '' : 's') + '.';
        } else if(action === 'reset-password'){
          message = 'Password reset requested for ' + succeeded.length + ' user' + (succeeded.length === 1 ? '' : 's') + '.';
        } else {
          message = succeeded.length + ' user' + (succeeded.length === 1 ? '' : 's') + ' signed out everywhere.';
        }
        toast(message, !!failed.length);
        return loadUsers();
      }).then(function(){
        usersState.busy = false;
        renderUsers();
      }, function(error){
        usersState.busy = false;
        renderUsers();
        toast(error && error.message || 'Bulk action failed.', true);
      });
    }

    function teamUserAction(action, id, email, role){
      if(action === 'team-role'){
        var self = id === team.selfId;
        if(self && role === 'member' && !win.confirm('Step down to member? You will lose access to the Admin Center.')) return Promise.resolve();
        return hub('PATCH', '/members/' + encodeURIComponent(id), {role: role}).then(function(){
          toast(role === 'admin' ? email + ' is now an admin' : email + ' is now a member');
          if(self) { win.location.href = '/'; return; }
          loadUsers();
        }, function(){});
      }
      if(action === 'team-owner'){
        if(!win.confirm('Make ' + email + ' the owner of ' + team.name + '? You stay an admin, but they can then change your role or remove you.')) return Promise.resolve();
        return hub('POST', '/owner', {member: id}).then(function(){
          toast(email + ' is now the owner');
          loadUsers();
        }, function(){});
      }
      if(action === 'team-remove'){
        if(!win.confirm('Remove ' + email + ' from ' + team.name + '? They lose access to its channels right away.')) return Promise.resolve();
        return hub('DELETE', '/members/' + encodeURIComponent(id), {}).then(function(){
          toast(email + ' removed');
          loadUsers();
        }, function(){});
      }
      return Promise.resolve();
    }

    function userAction(action, email){
      if(action === 'promote') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {role: 'admin'}}).then(function(){ toast('Promoted to admin'); loadUsers(); });
      if(action === 'demote') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {role: 'member'}}).then(function(){ toast('Set to member'); loadUsers(); });
      if(action === 'disable') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {disabled: true}}).then(function(){ toast('User disabled'); loadUsers(); });
      if(action === 'enable') return call('/api/admin/users/' + encodeURIComponent(email), {method: 'PATCH', body: {disabled: false}}).then(function(){ toast('User enabled'); loadUsers(); });
      if(action === 'reset-password') return call('/api/admin/users/' + encodeURIComponent(email) + '/reset-password', {method: 'POST'}).then(function(res){
        showResetPasswordLinks([{email: email, link: res.link}]);
      });
      if(action === 'sign-out') return call('/api/admin/users/' + encodeURIComponent(email) + '/sessions', {method: 'DELETE'}).then(function(){ toast('Signed out everywhere'); });
      if(action === 'delete'){
        if(isCurrentAdminEmail(email)){
          toast('The current admin account cannot be deleted.', true);
          return Promise.resolve();
        }
        if(!win.confirm('Delete ' + email + '? This removes the login, account credentials, and bots they own.')) return Promise.resolve();
        return call('/api/admin/users/' + encodeURIComponent(email), {method: 'DELETE'}).then(function(){
          delete usersState.selected[normalizeEmail(email)];
          toast('User deleted');
          loadUsers();
        });
      }
    }

    /* ---- invites ---- */
    function loadInvites(){
      if(team){
        hub('GET', '/invites').then(function(result){
          var body = $('#invitesBody');
          if(body) body.innerHTML = renderInvitesTable((result.invites || []).map(function(inv){
            return {id: inv.email, email: inv.email, role: 'member', invitedBy: '', expiresAt: hubTime(inv.expires_at)};
          }), {team: true});
        }, function(){});
        return;
      }
      call('/api/admin/invites').then(function(invites){
        var body = $('#invitesBody');
        if(body) body.innerHTML = renderInvitesTable(invites);
      });
    }

    function inviteAction(action, id){
      if(team){
        if(action !== 'revoke-invite') return;
        return hub('DELETE', '/invites/' + encodeURIComponent(id), {}).then(function(){ toast('Invite revoked'); loadInvites(); }, function(){});
      }
      if(action === 'revoke-invite') return call('/api/admin/invites/' + encodeURIComponent(id), {method: 'DELETE'}).then(function(){ toast('Invite revoked'); loadInvites(); });
      if(action === 'copy-invite'){
        call('/api/admin/invites').then(function(invites){
          var inv = invites.filter(function(i){ return i.id === id; })[0];
          if(!inv || !inv.link){
            toast('This invite link is no longer available; create a new invite to copy it.', true);
            return;
          }
          copyText(inv.link);
        });
      }
    }

    /* ---- activity ---- */
    function loadActivity(){
      if(team){
        Promise.all([hub('GET', '/audit?limit=100'), hub('GET', '/members')]).then(function(results){
          var body = $('#activityBody');
          if(body) body.innerHTML = renderActivityRows(teamActivityEvents(results[0].events, results[1].members));
        }, function(){});
        return;
      }
      call('/api/admin/events?limit=100').then(function(events){
        var body = $('#activityBody');
        if(body) body.innerHTML = renderActivityRows(events);
      });
    }

    /* ---- overlays ---- */
    function openOverlay(id){ var el = $('#' + id); if(el) el.hidden = false; }
    function closeOverlay(id){ var el = $('#' + id); if(el) el.hidden = true; }

    function copyText(text){
      if(win.navigator.clipboard && win.navigator.clipboard.writeText){
        win.navigator.clipboard.writeText(text).then(function(){ toast('Copied'); }, function(){ toast('Copy failed', true); });
      } else {
        toast('Copy not supported', true);
      }
    }

    /* ---- wiring ---- */
    function wire(){
      $all('.admin-nav-item').forEach(function(btn){
        btn.addEventListener('click', function(){ showView(btn.getAttribute('data-view')); });
      });
      $all('[data-close-overlay]').forEach(function(btn){
        btn.addEventListener('click', function(){ closeOverlay(btn.getAttribute('data-close-overlay')); });
      });

      var usersSearch = $('#usersSearch');
      if(usersSearch) usersSearch.addEventListener('input', function(){
        usersState.search = usersSearch.value || '';
        renderUsers();
      });

      var agentsSearch = $('#agentsSearch');
      if(agentsSearch) agentsSearch.addEventListener('input', function(){
        agentsState.search = agentsSearch.value || '';
        renderAgents();
      });

      var usersSelectAll = $('#usersSelectAll');
      if(usersSelectAll) usersSelectAll.addEventListener('change', function(){
        if(usersState.busy) return;
        visibleAdminUsers().forEach(function(user){
          var email = normalizeEmail(user && user.email);
          if(!email || isCurrentAdminEmail(email)) return;
          if(usersSelectAll.checked) usersState.selected[email] = true;
          else delete usersState.selected[email];
        });
        renderUsers();
      });

      $all('[data-bulk-action]').forEach(function(btn){
        btn.addEventListener('click', function(){
          bulkUserAction(btn.getAttribute('data-bulk-action'));
        });
      });

      var usersBody = $('#usersBody');
      if(usersBody) usersBody.addEventListener('click', function(ev){
        var btn = ev.target.closest && ev.target.closest('button[data-action]');
        if(!btn || btn.disabled) return;
        if(team){
          // The Hub can take a few seconds; keep the button from being pressed twice.
          btn.disabled = true;
          teamUserAction(btn.getAttribute('data-action'), btn.getAttribute('data-id'), btn.getAttribute('data-email'), btn.getAttribute('data-role'))
            .then(function(){ btn.disabled = false; });
        }
        else userAction(btn.getAttribute('data-action'), btn.getAttribute('data-email'));
      });
      if(usersBody && team) usersBody.addEventListener('change', function(ev){
        var input = ev.target.closest && ev.target.closest('input[data-team-department]');
        if(!input) return;
        var department = String(input.value).replace(/\s+/g, ' ').trim();
        var email = input.getAttribute('data-email');
        input.disabled = true;
        hub('PATCH', '/members/' + encodeURIComponent(input.getAttribute('data-id')), {department: department}).then(function(){
          toast(department ? email + ' is now in ' + department : email + ' has no department');
          return loadUsers();
        }, function(){ input.disabled = false; loadUsers(); });
      });
      if(usersBody) usersBody.addEventListener('change', function(ev){
        var checkbox = ev.target.closest && ev.target.closest('input.admin-user-select');
        if(!checkbox || checkbox.disabled) return;
        var email = normalizeEmail(checkbox.getAttribute('data-email'));
        if(!email || isCurrentAdminEmail(email)) return;
        if(checkbox.checked) usersState.selected[email] = true;
        else delete usersState.selected[email];
        syncUsersControls();
      });

      var invitesBody = $('#invitesBody');
      if(invitesBody) invitesBody.addEventListener('click', function(ev){
        var btn = ev.target.closest && ev.target.closest('button[data-action]');
        if(!btn) return;
        inviteAction(btn.getAttribute('data-action'), btn.getAttribute('data-id'));
      });

      var addUserBtn = $('#usersAddBtn');
      if(addUserBtn) addUserBtn.addEventListener('click', function(){ $('#addUserError').hidden = true; openOverlay('addUserOverlay'); });

      var addUserForm = $('#addUserForm');
      if(addUserForm) addUserForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var fd = new FormData(addUserForm);
        var body = {email: fd.get('email'), displayName: fd.get('displayName') || undefined, password: fd.get('password') || undefined, role: fd.get('role')};
        call('/api/admin/users', {method: 'POST', body: body}).then(function(res){
          addUserForm.reset();
          closeOverlay('addUserOverlay');
          if(res && res.invite && res.invite.link){
            $('#inviteResultLink').textContent = res.invite.link;
            $('#inviteFormWrap').hidden = true;
            $('#inviteResultWrap').hidden = false;
            openOverlay('inviteOverlay');
            loadInvites();
            return;
          }
          toast('User added');
          loadUsers();
        }).catch(function(err){
          var errEl = $('#addUserError');
          if(errEl){ errEl.textContent = err.message; errEl.hidden = false; }
        });
      });

      var usersInviteBtn = $('#usersInviteBtn');
      var invitesCreateBtn = $('#invitesCreateBtn');
      [usersInviteBtn, invitesCreateBtn].forEach(function(btn){
        if(!btn) return;
        btn.addEventListener('click', function(){
          $('#inviteError').hidden = true;
          if(inviteForm) inviteForm.reset();
          $('#inviteFormWrap').hidden = false;
          $('#inviteResultWrap').hidden = true;
          openOverlay('inviteOverlay');
        });
      });

      var inviteForm = $('#inviteForm');
      if(inviteForm) inviteForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var fd = new FormData(inviteForm);
        if(team){
          var email = String(fd.get('email') || '').trim();
          hub('POST', '/invites', {email: email}).then(function(){
            $('#inviteResultHint').textContent = 'Invitation sent to ' + email + '. They will see it in Mia after signing in with that email. It expires in 7 days.';
            $('#inviteResultBox').hidden = true;
            $('#inviteFormWrap').hidden = true;
            $('#inviteResultWrap').hidden = false;
            loadInvites();
          }, function(err){
            var errEl = $('#inviteError');
            if(errEl){ errEl.textContent = err.message; errEl.hidden = false; }
          });
          return;
        }
        var body = {email: fd.get('email'), role: fd.get('role'), expiresInHours: Number(fd.get('expiresInHours')) || 72};
        call('/api/admin/invites', {method: 'POST', body: body}).then(function(res){
          $('#inviteResultLink').textContent = res.link || '';
          $('#inviteFormWrap').hidden = true;
          $('#inviteResultWrap').hidden = false;
          loadInvites();
        }).catch(function(err){
          var errEl = $('#inviteError');
          if(errEl){ errEl.textContent = err.message; errEl.hidden = false; }
        });
      });

      var inviteCopyBtn = $('#inviteResultCopy');
      if(inviteCopyBtn) inviteCopyBtn.addEventListener('click', function(){ copyText($('#inviteResultLink').textContent); });
      var resetCopyBtn = $('#resetPwCopy');
      if(resetCopyBtn) resetCopyBtn.addEventListener('click', function(){ copyText($('#resetPwLink').textContent); });
      var resetPwBulkLinks = $('#resetPwBulkLinks');
      if(resetPwBulkLinks) resetPwBulkLinks.addEventListener('click', function(ev){
        var btn = ev.target.closest && ev.target.closest('button[data-reset-link]');
        if(btn) copyText(btn.getAttribute('data-reset-link') || '');
      });

      var logoFile=$('#teamLogoFile'),logoRemove=$('#teamLogoRemove');
      if($('#teamLogoUpload'))$('#teamLogoUpload').addEventListener('click',function(){if(!logoFile.disabled)logoFile.click();});
      function logoStatus(text){$('#teamLogoStatus').textContent=text;}
      function showLogo(result){var preview=$('#teamLogoPreview');preview.textContent='';win.MiaTeamLogo.paint(preview,result.logo_data_url);logoRemove.disabled=!result.logo_data_url;}
      if(logoFile)logoFile.addEventListener('change',async function(){
        var file=logoFile.files[0];if(!file||!team)return;
        logoFile.disabled=true;logoRemove.disabled=true;logoStatus('Uploading…');
        try{var data=await win.MiaTeamLogo.prepare(file);showLogo(await hub('PUT','/team/logo',{logo_data_url:data}));logoStatus('Team logo saved.');}
        catch(error){logoStatus(error.message||'Could not upload logo.');logoRemove.disabled=false;}
        finally{logoFile.disabled=false;logoFile.value='';}
      });
      if(logoRemove)logoRemove.addEventListener('click',async function(){
        if(!team)return;logoRemove.disabled=true;logoFile.disabled=true;
        try{showLogo(await hub('DELETE','/team/logo'));logoStatus('Team logo removed.');}
        catch(error){logoStatus(error.message||'Could not remove logo.');logoRemove.disabled=false;}
        finally{logoFile.disabled=false;}
      });
      var renameBtn = $('#teamRenameBtn');
      var renameForm = $('#renameTeamForm');
      if(renameBtn) renameBtn.addEventListener('click', function(){
        $('#renameTeamError').hidden = true;
        renameForm.elements.name.value = team ? team.name : '';
        openOverlay('renameTeamOverlay');
        renameForm.elements.name.focus();
      });
      if(renameForm) renameForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        hub('PATCH', '/team', {name: renameForm.elements.name.value}).then(function(result){
          setTeamName(result.name);
          closeOverlay('renameTeamOverlay');
          toast('Company renamed');
          loadOverview();
        }, function(err){
          var errEl = $('#renameTeamError');
          if(errEl){ errEl.textContent = err.message; errEl.hidden = false; }
        });
      });

      var newBotBtn = $('#teamNewBotBtn');
      var newBotForm = $('#newTeamBotForm');
      if(newBotBtn) newBotBtn.addEventListener('click', function(){
        $('#newTeamBotError').hidden = true;
        if(newBotBtn.disabled) return;
        newBotBtn.disabled = true;
        toast('Loading channels…');
        hub('GET', '/channels').finally(function(){ newBotBtn.disabled = false; }).then(function(result){
          var options = newBotChannelOptions(result.channels);
          var select = $('#newTeamBotChannel');
          select.innerHTML = options.map(function(o){ return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>'; }).join('');
          if(!options.length){
            toast('Create a channel first; a company bot lives in a channel.', true);
            return;
          }
          openOverlay('newTeamBotOverlay');
          select.focus();
        }, function(){});
      });
      if(newBotForm) newBotForm.addEventListener('submit', function(ev){
        ev.preventDefault();
        var channelId = newBotForm.elements.channel.value;
        if(!team || !/^[a-f0-9]{32}$/.test(channelId)) return;
        try { win.sessionStorage.setItem(NEW_TEAM_BOT_KEY, newTeamBotRequest(team.id, channelId, Date.now())); }
        catch(_newBotStorageError){
          var errEl = $('#newTeamBotError');
          if(errEl){ errEl.textContent = 'Mia could not start the setup. Reload and try again.'; errEl.hidden = false; }
          return;
        }
        win.location.href = '/';
      });

      if(team) wireHubAdmin();

      win.addEventListener('hashchange', function(){ showView(currentViewFromHash()); });
    }

    function setTeamName(name){
      team.name = name;
      doc.title = 'Mia · ' + name + ' admin';
      var brandName = $('#adminBrandName');
      if(brandName) brandName.textContent = name;
    }

    function blocked(title, message){
      var blockedTitle = $('#adminBlockedTitle');
      var blockedMessage = $('#adminBlockedMessage');
      if(blockedTitle && title) blockedTitle.textContent = title;
      if(blockedMessage && message) blockedMessage.textContent = message;
      $('#adminBlocked').hidden = false;
    }

    function bootTeam(teamId){
      if(!win.MiaHubChat || !tf || !wf){
        blocked('Admin Center is unavailable', 'The company connection did not load. Restart Mia and try again.');
        return;
      }
      win.MiaHubChat.call('GET', '/v1/me').then(function(me){
        var entry = (me.teams || []).filter(function(t){ return t.teamId === teamId; })[0];
        if(!entry || !entry.membership || entry.membership.role !== 'admin'){
          blocked('Not authorized', 'Only admins of this company can open the Admin Center.');
          return;
        }
        team = {id: teamId, name: String(entry.name || 'Company'), selfId: entry.membership.clerk_user_id};
        hub('GET','/team/logo').then(function(result){var preview=$('#teamLogoPreview');win.MiaTeamLogo.paint(preview,result.logo_data_url);$('#teamLogoRemove').disabled=!result.logo_data_url;}).catch(function(){$('#teamLogoStatus').textContent='Logo settings need a Hub update.';});
        usersState.currentAdminEmail = normalizeEmail(entry.membership.email);
        doc.body.classList.add('admin-team');
        setTeamName(team.name);
        var sub = doc.querySelector('.admin-brand-sub');
        if(sub) sub.textContent = 'Company admin';
        var renameBtn = $('#teamRenameBtn');
        if(renameBtn) renameBtn.hidden = false;
        var newBotBtn = $('#teamNewBotBtn');
        if(newBotBtn) newBotBtn.hidden = false;
        var groupHead = $('#agentsGroupHead');
        if(groupHead) groupHead.textContent = 'Channel';
        var agentsSub = $('#agentsSub');
        if(agentsSub) agentsSub.textContent = 'Bots in the channels you are in, with the member who added each one.';
        hubAdmin = createHubAdmin({teamId: team.id, call: win.MiaHubChat.call, confirm: hubConfirm, toast: toast, onChange: hubPaint, openReview: function(appId){
          // Reviewing happens on the Apps page, where the app can run in its sandbox.
          try {
            win.localStorage.setItem('miaAppsReviewHandoff', JSON.stringify({teamId: team.id, appId: appId, at: Date.now()}));
            win.localStorage.setItem('miaosActiveWorkspace', 'hub_' + team.id);
          } catch(_reviewHandoffError) {}
          win.location.href = '/';
        }});
        $all('[data-team-only]').forEach(function(el){ el.hidden = false; });
        $('#adminWrap').hidden = false;
        wire();
        showView(currentViewFromHash());
        loadOverview();
        startAutoRefresh();
      }).catch(function(){
        blocked('Cannot reach the company', 'The company service is unreachable. Check your connection and try again.');
      });
    }

    function boot(){
      var storedWorkspaceKey = '';
      try { storedWorkspaceKey = win.localStorage.getItem('miaosActiveWorkspace') || ''; } catch(_workspaceStorageError) {}
      var workspaceKey = adminWorkspaceKey(win.location.search, storedWorkspaceKey);
      var teamId = hubTeamId(workspaceKey);
      if(teamId) return bootTeam(teamId);
      if(workspaceKey !== 'multiplayer_test'){
        var blockedTitle = $('#adminBlockedTitle');
        var blockedMessage = $('#adminBlockedMessage');
        if(blockedTitle) blockedTitle.textContent = 'Admin Center is unavailable in Solo';
        if(blockedMessage) blockedMessage.textContent = 'Switch to Multiplayer Test to manage shared users, bots, and workspace settings.';
        $('#adminBlocked').hidden = false;
        return;
      }
      call('/api/me').then(function(me){
        if(!me || !me.isAdmin){
          $('#adminBlocked').hidden = false;
          return;
        }
        usersState.currentAdminEmail = normalizeEmail(me.email);
        doc.title = 'Mia Multiplayer · Admin';
        var brandName = $('#adminBrandName');
        if(brandName) brandName.textContent = 'Mia Multiplayer';
        $('#adminWrap').hidden = false;
        wire();
        showView(currentViewFromHash());
        loadOverview();
        startAutoRefresh();
      }).catch(function(){
        $('#adminBlocked').hidden = false;
      });
    }

    if(doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  var exportsObj = {
    esc: esc,
    adminWorkspaceKey: adminWorkspaceKey,
    adminViewFromHash: adminViewFromHash,
    hubLoadError: hubLoadError,
    hubConfirmCopy: hubConfirmCopy,
    createHubAdmin: createHubAdmin,
    renderHubView: renderHubView,
    hubFileWhere: hubFileWhere,
    hubFileScan: hubFileScan,
    hubTeamId: hubTeamId,
    renderTeamOverviewTiles: renderTeamOverviewTiles,
    renderTeamUsersTable: renderTeamUsersTable,
    teamRosterAgents: teamRosterAgents,
    teamUsersSummary: teamUsersSummary,
    newBotChannelOptions: newBotChannelOptions,
    newTeamBotRequest: newTeamBotRequest,
    teamActivityEvents: teamActivityEvents,
    initialsFor: initialsFor,
    fmtDate: fmtDate,
    fmtUptime: fmtUptime,
    healthDotClass: healthDotClass,
    renderOverviewTiles: renderOverviewTiles,
    renderUsersTable: renderUsersTable,
    renderAgentsTable: renderAgentsTable,
    renderInvitesTable: renderInvitesTable,
    renderActivityRows: renderActivityRows
  };

  if(root && root.document) initBrowser(root);

  return exportsObj;
});
