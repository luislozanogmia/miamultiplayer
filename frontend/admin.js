(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else factory(root);
})(typeof window !== 'undefined' ? window : this, function(root){
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
      '<div class="card admin-tile"><div class="admin-tile-label">Team</div>' +
        '<div class="admin-tile-val">' + esc(data.name || '—') + '</div>' +
        '<div class="admin-tile-sub">Shared team</div></div>',
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
      return {id: m.clerk_user_id, email: m.email, role: m.role};
    }), search);
    if(!rows.length) return '<tr><td colspan="7" class="admin-empty">' + (search ? 'No users match your search.' : 'No members yet.') + '</td></tr>';
    return rows.map(function(u){
      var self = u.id === options.selfId;
      var owner = !!options.ownerId && u.id === options.ownerId;
      var lastAdmin = u.role === 'admin' && admins <= 1;
      // The owner keeps their role and seat until they hand ownership to another admin.
      var locked = owner ? ' disabled title="The owner must make another admin the owner first."'
        : lastAdmin ? ' disabled title="A team must keep at least one admin."' : '';
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
          '<div class="admin-cell-sub">' + (self ? 'You' : 'Teammate') + (owner ? ' · Owner' : '') + '</div></div>' +
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
          ownerDescription: 'Teammate', status: TEAM_BOT_STATUS[admission.status] || 'Unknown',
          model: '—', departments: [where], createdAt: hubTime(bot.created_at)});
      });
    });
    return agents;
  }

  var TEAM_AUDIT_LABELS = {
    role_changed: 'Changed a role', owner_transferred: 'Transferred ownership', team_renamed: 'Renamed the team', invite_created: 'Invited',
    invite_revoked: 'Revoked an invite', invite_accepted: 'Joined the team', invite_declined: 'Declined an invite',
    member_removed: 'Removed a member', message_deleted: 'Deleted a message', file_uploaded: 'Uploaded an image',
    bot_shared: 'Added a bot', bot_unshared: 'Removed a bot', bot_execution_handoff: 'Handed off a bot run',
    bot_version_proposed: 'Proposed a bot change', bot_version_published: 'Approved a bot change',
    bot_version_rejected: 'Rejected a bot change', bot_editor_added: 'Added a bot editor',
    bot_editor_removed: 'Removed a bot editor', team_approved: 'Team approved'
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
    }

    function currentViewFromHash(){
      var h = (win.location.hash || '').replace(/^#\/?/, '');
      if(h === 'agent-roster') h = 'agents';
      var known = ['overview', 'users', 'agents', 'invites', 'activity', 'backup'];
      return known.indexOf(h) !== -1 ? h : 'overview';
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
            return {clerk_user_id: m.clerk_user_id, email: m.email, role: m.role};
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
      return hub('GET', '/channels').then(function(result){
        var channels = result.channels || [];
        return Promise.all(channels.map(function(channel){
          return hub('GET', '/channels/' + channel.id + '/bots').then(function(bots){
            return {channel: channel, bots: bots.bots || []};
          }, function(){ return {channel: channel, bots: []}; });
        }));
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
          toast('Team renamed');
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
            toast('Create a channel first; a team bot lives in a channel.', true);
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
      if(!win.MiaHubChat){
        blocked('Admin Center is unavailable', 'The shared team connection did not load. Restart Mia and try again.');
        return;
      }
      win.MiaHubChat.call('GET', '/v1/me').then(function(me){
        var entry = (me.teams || []).filter(function(t){ return t.teamId === teamId; })[0];
        if(!entry || !entry.membership || entry.membership.role !== 'admin'){
          blocked('Not authorized', 'Only admins of this team can open the Admin Center.');
          return;
        }
        team = {id: teamId, name: String(entry.name || 'Shared team'), selfId: entry.membership.clerk_user_id};
        usersState.currentAdminEmail = normalizeEmail(entry.membership.email);
        doc.body.classList.add('admin-team');
        setTeamName(team.name);
        var sub = doc.querySelector('.admin-brand-sub');
        if(sub) sub.textContent = 'Team admin';
        var renameBtn = $('#teamRenameBtn');
        if(renameBtn) renameBtn.hidden = false;
        var newBotBtn = $('#teamNewBotBtn');
        if(newBotBtn) newBotBtn.hidden = false;
        var groupHead = $('#agentsGroupHead');
        if(groupHead) groupHead.textContent = 'Channel';
        var agentsSub = $('#agentsSub');
        if(agentsSub) agentsSub.textContent = 'Bots in the channels you are in, with the member who added each one.';
        $('#adminWrap').hidden = false;
        wire();
        var view = currentViewFromHash();
        showView(view === 'backup' ? 'overview' : view);
        loadOverview();
        startAutoRefresh();
      }).catch(function(){
        blocked('Cannot reach the team', 'The shared team service is unreachable. Check your connection and try again.');
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
