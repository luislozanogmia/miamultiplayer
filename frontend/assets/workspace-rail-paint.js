/* Paint the workspace rail and title from the saved team list before the
   first frame, so a workspace switch (which reloads the page) never shows
   the default rail redrawing into the real one. app.js renders the same
   tiles again with identical markup (renderHubTeamOptions) once it runs.
   Self-hosted for the same strict script-src policy as workspace-handoff.js. */
(function () {
  try {
    var rail = document.getElementById('workspaceSwitcherMenu');
    var add = document.getElementById('workspaceRailAdd');
    if (!rail || !add) return;
    var labels = { solo: 'Solo', multiplayer_test: 'Multiplayer Test' };
    var teams = JSON.parse(localStorage.getItem('miaHubTeams') || '[]');
    if (!Array.isArray(teams)) teams = [];
    // Same initials as workspaceCode() in app.js.
    function code(label) {
      var words = String(label || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
      if (!words.length) return 'MI';
      return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : words[0].slice(0, 2)).toUpperCase();
    }
    teams.forEach(function (team) {
      if (!team || !/^[a-f0-9]{32}$/.test(team.teamId) || typeof team.name !== 'string') return;
      var key = 'hub_' + team.teamId;
      labels[key] = team.name;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-rail-tile';
      button.setAttribute('data-hub-team', team.teamId);
      button.setAttribute('data-workspace-key', key);
      button.setAttribute('aria-label', team.name);
      var mark = document.createElement('span');
      mark.className = 'workspace-rail-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = code(team.name);
      var name = document.createElement('strong');
      name.className = 'workspace-rail-name';
      name.textContent = team.name;
      button.appendChild(mark);
      button.appendChild(name);
      rail.insertBefore(button, add);
    });
    var active = localStorage.getItem('miaosActiveWorkspace') || '';
    if (/^hub_[a-f0-9]{32}$/.test(active) && !labels[active]) labels[active] = 'Shared team';
    if (!labels[active]) active = 'solo';
    Array.prototype.forEach.call(rail.querySelectorAll('[data-workspace-key]'), function (tile) {
      var on = tile.getAttribute('data-workspace-key') === active;
      tile.classList.toggle('active', on);
      tile.setAttribute('aria-current', on ? 'true' : 'false');
    });
    var title = document.getElementById('miaCompanyName');
    if (title) title.textContent = labels[active];
  } catch (_workspaceRailPaintError) {}
})();
