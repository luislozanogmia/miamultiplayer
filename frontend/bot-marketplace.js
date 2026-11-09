(function(root){
  'use strict';
  // The Bot marketplace opens over the app like Settings. Shelves: Mia's own
  // bots (the catalog), each company you're in (bots people shared there),
  // Everyone (later), then the bots you own, the copies you got, and your
  // skills (each a folder: SKILL.md plus the files it points to).
  // A copy you get is your bot everywhere; it follows the shared bot's updates.

  var state = null;
  var opts = null;

  function esc(value){ return opts.esc(value == null ? '' : String(value)); }
  function text(value){ return String(value == null ? '' : value); }

  // A shared bot from the Hub, whichever way its fields come back.
  function marketBot(raw){
    var latest = raw.latest || {};
    return {
      id: text(raw.id),
      name: text(raw.name || latest.name || 'Bot'),
      color: raw.avatar_color || latest.avatar_color || null,
      about: text(raw.description || latest.description || ''),
      tags: Array.isArray(raw.tags) ? raw.tags : Array.isArray(latest.tags) ? latest.tags : [],
      version: Number(raw.latest_version || latest.version || 0),
      by: text(latest.published_by_name || latest.published_by || raw.shared_by_name || raw.shared_by || ''),
      at: Number(latest.published_at || raw.shared_at || 0),
      canUse: raw.can_use !== false,
      owner: raw.is_owner === true
    };
  }

  function localCopy(teamId, botId){
    return (opts.localBots() || []).filter(function(bot){
      var source = bot && bot.marketSource;
      return source && source.teamId === teamId && source.botId === botId;
    })[0] || null;
  }

  function shelves(){
    var list = [{id:'mia', label:'From Mia'}];
    (state.companies || []).forEach(function(company){ list.push({id:'company:' + company.teamId, label:company.name, teamId:company.teamId}); });
    list.push({id:'everyone', label:'Everyone', soon:true});
    list.push({id:'uploads', label:'My uploads', mine:true});
    list.push({id:'downloaded', label:'Downloaded', mine:true});
    list.push({id:'skills', label:'Skills', mine:true});
    return list;
  }

  function matches(name, about){
    var query = state.query.trim().toLowerCase();
    return !query || (name + ' ' + about).toLowerCase().indexOf(query) >= 0;
  }

  function when(at){
    if(!at) return '';
    var days = Math.floor((Date.now() - at) / 86400000);
    return days <= 0 ? 'updated today' : days === 1 ? 'updated yesterday' : 'updated ' + days + ' days ago';
  }

  function card(options){
    return '<div class="bot-market-card"' + (options.detail ? ' data-market-detail="' + esc(options.detail) + '" role="button" tabindex="0" aria-label="' + esc('About ' + options.name) + '"' : '') + '>'
      + '<span class="bot-market-avatar">' + (options.icon || opts.avatarHtml(options.name, options.color)) + '</span>'
      + '<span class="bot-market-copy"><span class="bot-market-name">' + esc(options.name) + '</span>'
      + (options.about ? '<span class="bot-market-about">' + esc(options.about) + '</span>' : '')
      + (options.meta ? '<span class="bot-market-meta">' + esc(options.meta) + '</span>' : '')
      + '</span>' + options.action + '</div>';
  }

  function catalogShelf(){
    var catalog = state.catalog;
    if(catalog.loading && !catalog.entries) return '<p class="bot-market-status">Loading bots…</p>';
    if(catalog.error) return '<p class="bot-market-status">' + esc(catalog.error) + '</p>';
    var cards = (catalog.entries || []).filter(function(manifest){
      var bot = manifest.bot || {}, store = manifest.store || {};
      return matches(text(bot.name), text(store.tagline));
    }).map(function(manifest){
      var bot = manifest.bot || {}, store = manifest.store || {};
      var installed = opts.installedByName(bot.name);
      var busy = state.busy === 'mia:' + manifest.id;
      return card({detail: 'mia:' + manifest.id, name: bot.name || manifest.id, color: store.avatarColor || bot.avatarColor || null, about: store.tagline,
        meta: [store.category, manifest.author || 'Mia'].filter(Boolean).join(' · '),
        action: installed ? '<button type="button" class="bot-market-btn" data-market-open-local="' + esc(installed.id) + '">Open</button>'
          : '<button type="button" class="bot-market-btn primary" data-market-install="' + esc(manifest.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Getting…' : 'Get') + '</button>'});
    });
    return cards.length ? cards.join('') : '<p class="bot-market-status">' + (state.query ? 'No bots match.' : 'No bots here yet.') + '</p>';
  }

  function companyCardAction(teamId, bot){
    var copy = localCopy(teamId, bot.id);
    if(copy) return '<button type="button" class="bot-market-btn" data-market-open-local="' + esc(copy.id) + '">Open</button>';
    if(!bot.canUse) return '<span class="bot-market-note" title="Ask an admin of this company for access">No access</span>';
    var busy = state.busy === teamId + ':' + bot.id;
    return '<button type="button" class="bot-market-btn primary" data-market-get="' + esc(bot.id) + '" data-market-team="' + esc(teamId) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Getting…' : 'Get') + '</button>';
  }

  function companyCards(teamId, filter){
    var shelf = state.market[teamId];
    if(!shelf || (shelf.loading && !shelf.bots)) return null;
    return (shelf.bots || []).map(marketBot).filter(function(bot){ return (!filter || filter(bot)) && matches(bot.name, bot.about); }).map(function(bot){
      return card({detail: 'company:' + teamId + ':' + bot.id, name: bot.name, color: bot.color, about: bot.about,
        meta: [bot.by ? 'by ' + bot.by : '', bot.version ? 'v' + bot.version : '', when(bot.at), bot.owner ? 'you own it' : ''].filter(Boolean).join(' · '),
        action: companyCardAction(teamId, bot)});
    });
  }

  function companyShelf(teamId){
    var shelf = state.market[teamId];
    if(!shelf || (shelf.loading && !shelf.bots)) return '<p class="bot-market-status">Loading bots…</p>';
    if(shelf.unavailable) return '<p class="bot-market-status">This company\'s marketplace isn\'t open yet. Once it is, every bot someone brings into a channel shows up here for everyone who can use it.</p>';
    if(shelf.error) return '<p class="bot-market-status">' + esc(shelf.error) + '</p>';
    var cards = companyCards(teamId);
    return cards.length ? cards.join('') : '<p class="bot-market-status">' + (state.query ? 'No bots match.' : 'No bots shared here yet. Bring one into a channel with @ and it shows up here.') + '</p>';
  }

  function uploadsShelf(){
    var html = [], loading = false;
    (state.companies || []).forEach(function(company){
      var cards = companyCards(company.teamId, function(bot){ return bot.owner; });
      if(cards === null){ loading = true; return; }
      if(cards.length) html.push('<div class="bot-market-group">' + esc(company.name) + '</div>' + cards.join(''));
    });
    if(html.length) return html.join('');
    return '<p class="bot-market-status">' + (loading ? 'Loading bots…' : 'Bots you bring into a company, or own there, show up here.') + '</p>';
  }

  function downloadedShelf(){
    var copies = (opts.localBots() || []).filter(function(bot){ return bot && bot.marketSource && matches(text(bot.name), ''); });
    if(!copies.length) return '<p class="bot-market-status">Bots you get from a company show up here. They\'re your bots everywhere and follow the shared bot\'s updates.</p>';
    return copies.map(function(bot){
      var company = (state.companies || []).filter(function(item){ return item.teamId === bot.marketSource.teamId; })[0];
      return card({name: bot.name, color: bot.avatarColor || null, about: '',
        meta: [company ? 'from ' + company.name : '', bot.marketSource.version ? 'v' + bot.marketSource.version : ''].filter(Boolean).join(' · '),
        action: '<button type="button" class="bot-market-btn" data-market-open-local="' + esc(bot.id) + '">Open</button>'});
    }).join('');
  }

  // The large card: what the bot does, its instructions (its AGENTS.md),
  // skills and automations, with the same Get or Open as its small card.
  function section(title, html){ return '<section class="bot-market-section"><h2>' + esc(title) + '</h2>' + html + '</section>'; }
  // A skill is a folder: SKILL.md says what it is and when to use it, and
  // points to the other files in it (notes like ICP.md, scripts like search.py).
  // An older skill is just a name, a description and a body (its SKILL.md).
  var FOLDER_ICON = '<svg class="bot-market-skill-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var FILE_ICON = '<svg class="bot-market-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  function skillFiles(skill){
    var files = Array.isArray(skill.files) ? skill.files.filter(function(file){ return file && file.path; }) : [];
    if(!files.some(function(file){ return /^skill\.md$/i.test(file.path); }) && skill.body) files.unshift({path: 'SKILL.md', body: skill.body});
    return files.sort(function(a, b){
      var main = /^skill\.md$/i;
      return (main.test(b.path) ? 1 : 0) - (main.test(a.path) ? 1 : 0) || a.path.localeCompare(b.path);
    });
  }
  function fileKind(path){
    return /\.md$/i.test(path) ? 'Notes' : /\.(py|js|mjs|sh|ts)$/i.test(path) ? 'Script' : /\.(json|ya?ml|csv)$/i.test(path) ? 'Data' : 'File';
  }
  function skillsHtml(skills){
    if(!skills.length) return '<p class="bot-market-empty">No skills.</p>';
    return skills.map(function(skill){
      var files = skillFiles(skill);
      return '<details class="bot-market-skill"><summary>' + FOLDER_ICON + '<span class="bot-market-skill-head"><strong>' + esc(skill.name || 'Skill') + '</strong>'
        + (skill.description ? '<span>' + esc(skill.description) + '</span>' : '') + '</span>'
        + '<span class="bot-market-skill-count">' + esc(files.length === 1 ? '1 file' : files.length + ' files') + '</span></summary>'
        + '<div class="bot-market-files">' + files.map(function(file){
          return '<details class="bot-market-file"><summary>' + FILE_ICON + '<span class="bot-market-file-name">' + esc(file.path) + '</span>'
            + '<span class="bot-market-file-kind">' + esc(/^skill\.md$/i.test(file.path) ? 'Read first' : fileKind(file.path)) + '</span></summary>'
            + '<pre class="bot-market-text">' + esc(file.body || '') + '</pre></details>';
        }).join('') + '</div></details>';
    }).join('');
  }
  function detailView(){
    var d = state.detail, view;
    if(d.kind === 'mia'){
      var manifest = ((state.catalog.entries || []).filter(function(entry){ return entry.id === d.id; })[0]) || {};
      var bot = manifest.bot || {}, store = manifest.store || {}, requires = (store.requires && store.requires.connectors) || [];
      var installed = opts.installedByName(bot.name), busy = state.busy === 'mia:' + d.id;
      view = {name: bot.name || d.id, color: store.avatarColor || bot.avatarColor || null, about: store.tagline || '',
        meta: [store.category, 'by ' + (manifest.author || 'Mia'), manifest.version ? 'v' + manifest.version : ''].filter(Boolean).join(' · '),
        action: installed ? '<button type="button" class="bot-market-btn" data-market-open-local="' + esc(installed.id) + '">Open</button>'
          : '<button type="button" class="bot-market-btn primary" data-market-install="' + esc(d.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Getting…' : 'Get') + '</button>',
        instructions: text(bot.instructions), skills: Array.isArray(bot.skills) ? bot.skills : [],
        automations: Array.isArray(bot.automations) ? bot.automations : [],
        requires: requires};
    } else {
      var shelf = state.market[d.teamId] || {}, raw = (shelf.bots || []).filter(function(item){ return text(item.id) === d.id; })[0] || {};
      var summary = marketBot(raw), full = d.data || {}, latest = full.latest || full;
      view = {name: summary.name, color: summary.color, about: text(latest.description || summary.about),
        meta: [summary.by ? 'by ' + summary.by : '', summary.version ? 'v' + summary.version : '', when(summary.at)].filter(Boolean).join(' · '),
        action: companyCardAction(d.teamId, summary),
        instructions: d.loading ? null : text(latest.instructions), skills: Array.isArray(latest.skills) ? latest.skills : [],
        automations: [], requires: [], error: d.error, owners: Array.isArray(full.owners) ? full.owners : []};
    }
    var instructions = view.error ? '<p class="bot-market-empty">' + esc(view.error) + '</p>'
      : view.instructions === null ? '<p class="bot-market-empty">Loading…</p>'
      : view.instructions ? '<pre class="bot-market-text">' + esc(view.instructions) + '</pre>' : '<p class="bot-market-empty">No instructions.</p>';
    return '<button type="button" class="bot-market-back" data-market-back>&larr; Back</button>'
      + '<div class="bot-market-detail">'
      + '<div class="bot-market-detail-head"><span class="bot-market-avatar large">' + opts.avatarHtml(view.name, view.color) + '</span>'
      + '<div class="bot-market-copy"><h1 class="bot-market-detail-name">' + esc(view.name) + '</h1>'
      + (view.meta ? '<span class="bot-market-meta">' + esc(view.meta) + '</span>' : '') + '</div>' + view.action + '</div>'
      + (view.about ? section('What it does', '<p class="bot-market-about-full">' + esc(view.about) + '</p>') : '')
      + (view.requires.length ? section('Needs', '<p class="bot-market-about-full">' + esc(view.requires.join(', ')) + '</p>') : '')
      + section('Instructions', instructions)
      + section('Skills', skillsHtml(view.skills))
      + (view.automations.length ? section('Automations', '<ul class="bot-market-list-plain">' + view.automations.map(function(item){
          return '<li><strong>' + esc(item.name || 'Automation') + '</strong>' + (item.schedule || item.cron ? ' · ' + esc(item.schedule || item.cron) : '') + '</li>';
        }).join('') + '</ul>') : '')
      + (view.owners && view.owners.length ? section('Owners', '<p class="bot-market-about-full">' + esc(view.owners.map(function(o){ return o.name || o.email || o; }).join(', ')) + '</p>') : '')
      + '</div>';
  }

  function openDetail(key){
    var parts = key.split(':');
    if(parts[0] === 'mia') state.detail = {kind: 'mia', id: parts.slice(1).join(':')};
    else {
      var teamId = parts[1], id = parts.slice(2).join(':'), detail = {kind: 'company', teamId: teamId, id: id, loading: true};
      state.detail = detail;
      opts.hubCall('GET', '/v1/teams/' + teamId + '/market/bots/' + encodeURIComponent(id)).then(function(result){
        detail.data = result && (result.bot || result) || {};
      }, function(){ detail.error = 'Couldn\'t load this bot. Try again.'; }).then(function(){ detail.loading = false; if(state && state.detail === detail) render(); });
    }
    render();
    var scroller = state.sheet.querySelector('.styled-settings-content');
    if(scroller) scroller.scrollTop = 0;
  }

  // Your skills: each a folder card; it opens to its files, and Edit changes them.
  var BIG_FOLDER = '<svg class="bot-market-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  function filesCount(skill){ var n = (skill.files ? skill.files.length : 0) + 1; return n === 1 ? '1 file' : n + ' files'; }
  function skillsShelf(){
    var skills = state.skills;
    if(!skills || (skills.loading && !skills.list)) return '<p class="bot-market-status">Loading skills…</p>';
    if(skills.error) return '<p class="bot-market-status">' + esc(skills.error) + '</p>';
    var cards = skills.list.filter(function(skill){ return matches(text(skill.name), text(skill.description)); }).map(function(skill){
      var bots = (skill.bots || []).map(function(bot){ return bot.name; });
      return card({detail: 'skill:' + skill.id, icon: BIG_FOLDER, name: skill.name, about: skill.description,
        meta: [filesCount(skill), bots.length ? 'used by ' + bots.join(', ') : 'not on a bot yet'].join(' · '),
        action: ''});
    });
    return (cards.length ? cards.join('') : '<p class="bot-market-status">' + (state.query ? 'No skills match.' : 'Skills teach a bot how to do a job. Each is a folder: SKILL.md says what it is and when to use it, and can point to notes and scripts beside it.') + '</p>');
  }
  function fileRows(files){
    return '<div class="bot-market-files open">' + files.map(function(file){
      return '<details class="bot-market-file"' + (/^skill\.md$/i.test(file.path) ? ' open' : '') + '><summary>' + FILE_ICON + '<span class="bot-market-file-name">' + esc(file.path) + '</span>'
        + '<span class="bot-market-file-kind">' + esc(/^skill\.md$/i.test(file.path) ? 'Read first' : fileKind(file.path)) + '</span></summary>'
        + '<pre class="bot-market-text">' + esc(file.body || '') + '</pre></details>';
    }).join('') + '</div>';
  }
  function skillView(){
    var d = state.detail, skill = d.data;
    var head = '<button type="button" class="bot-market-back" data-market-back>&larr; Back</button><div class="bot-market-detail">';
    if(d.error) return head + '<p class="bot-market-empty">' + esc(d.error) + '</p></div>';
    if(!skill) return head + '<p class="bot-market-empty">Loading…</p></div>';
    var bots = (skill.bots || []).map(function(bot){ return bot.name; });
    return head + '<div class="bot-market-detail-head"><span class="bot-market-avatar large">' + BIG_FOLDER + '</span>'
      + '<div class="bot-market-copy"><h1 class="bot-market-detail-name">' + esc(skill.name) + '</h1>'
      + '<span class="bot-market-meta">' + esc(filesCount(skill)) + '</span></div>'
      + '<button type="button" class="bot-market-btn" data-skill-edit>Edit</button></div>'
      + (skill.description ? section('When to use it', '<p class="bot-market-about-full">' + esc(skill.description) + '</p>') : '')
      + section('Used by', '<p class="bot-market-about-full">' + esc(bots.length ? bots.join(', ') : 'No bot yet. Add it from a bot\'s settings.') + '</p>')
      + section('Files', fileRows(skillFiles(skill)))
      + '</div>';
  }
  function editRow(file, index){
    return '<div class="bot-market-edit-file" data-edit-file="' + index + '"><div class="bot-market-edit-file-head">' + FILE_ICON
      + '<input class="bot-market-input mono" data-edit-path placeholder="ICP.md" maxlength="200" aria-label="File name" value="' + esc(file.path || '') + '">'
      + '<button type="button" class="bot-market-link" data-edit-remove-file>Remove</button></div>'
      + '<textarea class="bot-market-input mono" data-edit-body rows="6" aria-label="' + esc((file.path || 'File') + ' contents') + '" placeholder="What this file holds">' + esc(file.body || '') + '</textarea></div>';
  }
  function editView(){
    var e = state.editing;
    return '<button type="button" class="bot-market-back" data-edit-cancel>&larr; ' + (e.id ? 'Back to the skill' : 'Back') + '</button>'
      + '<div class="bot-market-detail bot-market-edit">'
      + '<div class="bot-market-detail-head"><span class="bot-market-avatar large">' + BIG_FOLDER + '</span><h1 class="bot-market-detail-name">' + esc(e.id ? 'Edit ' + (e.name || 'skill') : 'New skill') + '</h1></div>'
      + '<label class="bot-market-field"><span>Name</span><input class="bot-market-input" data-edit-name maxlength="64" value="' + esc(e.name) + '" placeholder="GTM prospecting"></label>'
      + '<label class="bot-market-field"><span>When to use it</span><input class="bot-market-input" data-edit-description maxlength="500" value="' + esc(e.description) + '" placeholder="When someone asks for new leads"></label>'
      + '<div class="bot-market-field"><span>Files</span><div class="bot-market-edit-files">'
      + '<div class="bot-market-edit-file"><div class="bot-market-edit-file-head">' + FILE_ICON + '<span class="bot-market-file-name">SKILL.md</span><span class="bot-market-file-kind">Read first</span></div>'
      + '<textarea class="bot-market-input mono" data-edit-skill rows="10" aria-label="SKILL.md" placeholder="How to do the job, step by step. Point to the other files when a step needs them.">' + esc(e.body) + '</textarea></div>'
      + e.files.map(editRow).join('')
      + '<button type="button" class="bot-market-link add" data-edit-add-file>+ Add file</button></div></div>'
      + (e.error ? '<div class="bot-market-error" role="alert">' + esc(e.error) + '</div>' : '')
      + '<div class="bot-market-edit-actions">' + (e.id ? '<button type="button" class="bot-market-link danger" data-edit-delete>Remove skill</button>' : '') + '<span class="bot-market-spacer"></span>'
      + '<button type="button" class="bot-market-btn" data-edit-cancel>Cancel</button>'
      + '<button type="button" class="bot-market-btn primary" data-edit-save' + (e.busy ? ' disabled' : '') + '>' + (e.busy ? 'Saving…' : 'Save skill') + '</button></div>'
      + '</div>';
  }
  // What's typed so far, kept when the editor redraws.
  function readEdit(){
    var e = state.editing, sheet = state.sheet;
    if(!e || !sheet.querySelector('[data-edit-name]')) return e;
    e.name = sheet.querySelector('[data-edit-name]').value;
    e.description = sheet.querySelector('[data-edit-description]').value;
    e.body = sheet.querySelector('[data-edit-skill]').value;
    e.files = Array.prototype.map.call(sheet.querySelectorAll('[data-edit-file]'), function(row){
      return {path: row.querySelector('[data-edit-path]').value.trim(), body: row.querySelector('[data-edit-body]').value};
    });
    return e;
  }
  function loadSkills(){
    state.skills = {loading: true, list: state.skills && state.skills.list || null};
    render();
    var mine = state;
    Promise.resolve(opts.loadSkills()).then(function(list){ if(state === mine){ state.skills = {list: list || []}; render(); } },
      function(){ if(state === mine){ state.skills = {error: 'Couldn\'t load your skills. Try again.', list: []}; render(); } });
  }
  function openSkill(id){
    var detail = {kind: 'skill', id: id};
    state.detail = detail;
    state.editing = null;
    render();
    Promise.resolve(opts.loadSkill(id)).then(function(skill){ detail.data = skill; },
      function(){ detail.error = 'Couldn\'t load this skill. Try again.'; }).then(function(){ if(state && state.detail === detail) render(); });
  }
  function editSkill(skill){
    state.editing = {id: skill ? skill.id : null, name: skill ? skill.name : '', description: skill ? skill.description || '' : '',
      body: skill ? skill.body || '' : '', files: skill ? (skill.files || []).map(function(file){ return {path: file.path, body: file.body || ''}; }) : [], error: '', busy: false};
    render();
  }
  function saveSkill(){
    var e = readEdit();
    var files = e.files.filter(function(file){ return file.path || file.body.trim(); });
    e.busy = true; e.error = ''; render();
    Promise.resolve(opts.saveSkill(e.id, {name: e.name, description: e.description, body: e.body, files: files})).then(function(skill){
      state.editing = null;
      loadSkills();
      openSkill(skill.id);
    }, function(error){ e.busy = false; e.error = error && error.message || 'Couldn\'t save this skill.'; render(); });
  }

  function body(){
    if(state.editing) return editView();
    if(state.detail && state.detail.kind === 'skill') return skillView();
    if(state.detail) return detailView();
    if(state.shelf === 'skills') return skillsShelf();
    if(state.shelf === 'mia') return catalogShelf();
    if(state.shelf === 'everyone') return '<p class="bot-market-status">The open marketplace, with bots shared by everyone using Mia, is coming later.</p>';
    if(state.shelf === 'uploads') return uploadsShelf();
    if(state.shelf === 'downloaded') return downloadedShelf();
    return companyShelf(state.shelf.slice(8));
  }

  function render(){
    if(!state || !state.sheet) return;
    var list = shelves(), current = list.filter(function(item){ return item.id === state.shelf; })[0] || list[0];
    var focused = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-market-search]');
    var nav = list.map(function(item, index){
      return (item.mine && !list[index - 1].mine ? '<div class="bot-market-nav-sep" role="separator"></div>' : '')
        + '<button type="button" class="styled-settings-nav-item' + (item.id === current.id ? ' active' : '') + '" data-market-shelf="' + esc(item.id) + '">'
        + esc(item.label) + (item.soon ? ' <span class="bot-market-soon">Later</span>' : '') + '</button>';
    }).join('');
    state.sheet.innerHTML = '<button type="button" class="styled-sheet-close" data-market-close aria-label="Close Bot marketplace">&times;</button>'
      + '<nav class="styled-settings-nav" aria-label="Shelves"><div class="bot-market-title">Bot marketplace</div>' + nav + '</nav>'
      + '<div class="styled-settings-content">' + (state.detail || state.editing ? body() : '<div class="bot-market-head"><h1 class="styled-settings-h1">' + esc(current.label) + '</h1>'
      + (current.id === 'skills' ? '<button type="button" class="bot-market-btn primary" data-skill-new>New skill</button>' : '') + '</div>'
      + (current.soon ? '' : '<input type="search" class="styled-settings-input bot-market-search" data-market-search placeholder="' + (current.id === 'skills' ? 'Search skills' : 'Search bots') + '" aria-label="' + (current.id === 'skills' ? 'Search skills' : 'Search bots') + '" value="' + esc(state.query) + '">')
      + '<div class="bot-market-list">' + body() + '</div>') + '</div>';
    if(focused){ var search = state.sheet.querySelector('[data-market-search]'); if(search){ search.focus(); search.setSelectionRange(search.value.length, search.value.length); } }
  }

  function loadCompany(teamId, force){
    var shelf = state.market[teamId];
    if(shelf && (shelf.loading || (shelf.bots && !force))) return;
    state.market[teamId] = {loading: true, bots: shelf && shelf.bots || null};
    render();
    opts.hubCall('GET', '/v1/teams/' + teamId + '/market/bots').then(function(result){
      state.market[teamId] = {bots: Array.isArray(result && result.bots) ? result.bots : []};
    }).catch(function(error){
      // A Hub without the marketplace yet answers 404.
      state.market[teamId] = error && error.status === 404 ? {unavailable: true, bots: []} : {error: 'Couldn\'t load this company\'s bots. Try again.', bots: []};
    }).then(render);
  }

  function pick(shelf){
    state.shelf = shelf;
    state.detail = null;
    state.editing = null;
    if(shelf === 'skills') loadSkills();
    if(shelf.indexOf('company:') === 0) loadCompany(shelf.slice(8));
    if(shelf === 'uploads') (state.companies || []).forEach(function(company){ loadCompany(company.teamId); });
    render();
  }

  function get(teamId, botId){
    var shelf = state.market[teamId], raw = shelf && (shelf.bots || []).filter(function(item){ return text(item.id) === botId; })[0];
    if(!raw || state.busy) return;
    state.busy = teamId + ':' + botId;
    render();
    Promise.resolve(opts.getMarketBot(teamId, marketBot(raw))).then(function(copy){
      state.busy = null;
      if(copy){ close(); opts.openLocal(copy.id); }
      else render();
    }, function(error){
      state.busy = null;
      render();
      opts.toast('Couldn\'t get this bot: ' + (error && error.message || 'try again.'));
    });
  }

  function onClick(event){
    var target = event.target.closest('[data-market-close],[data-market-shelf],[data-market-install],[data-market-get],[data-market-open-local],[data-market-back],[data-market-detail],[data-skill-new],[data-skill-edit],[data-edit-cancel],[data-edit-save],[data-edit-add-file],[data-edit-remove-file],[data-edit-delete]');
    if(!target) return;
    if(target.hasAttribute('data-skill-new')) return editSkill(null);
    if(target.hasAttribute('data-skill-edit')) return editSkill(state.detail && state.detail.data);
    if(target.hasAttribute('data-edit-cancel')){ var back = state.editing && state.editing.id; state.editing = null; return back ? openSkill(back) : render(); }
    if(target.hasAttribute('data-edit-save')) return saveSkill();
    if(target.hasAttribute('data-edit-add-file')){
      readEdit().files.push({path: '', body: ''});
      render();
      var paths = state.sheet.querySelectorAll('[data-edit-path]');
      if(paths.length) paths[paths.length - 1].focus();
      return;
    }
    if(target.hasAttribute('data-edit-remove-file')){
      var index = Number(target.closest('[data-edit-file]').getAttribute('data-edit-file'));
      readEdit().files.splice(index, 1);
      return render();
    }
    if(target.hasAttribute('data-edit-delete')){
      var id = state.editing.id;
      return Promise.resolve(opts.removeSkill(id)).then(function(){ state.editing = null; state.detail = null; loadSkills(); },
        function(error){ state.editing.error = error && error.message || 'Couldn\'t remove this skill.'; render(); });
    }
    if(target.hasAttribute('data-market-back')){ state.detail = null; return render(); }
    if(target.hasAttribute('data-market-detail')){
      var key = target.getAttribute('data-market-detail');
      return key.indexOf('skill:') === 0 ? openSkill(key.slice(6)) : openDetail(key);
    }
    if(target.hasAttribute('data-market-close')) return close();
    if(target.hasAttribute('data-market-shelf')) return pick(target.getAttribute('data-market-shelf'));
    if(target.hasAttribute('data-market-open-local')){ close(); return opts.openLocal(target.getAttribute('data-market-open-local')); }
    if(target.hasAttribute('data-market-install')){
      var id = target.getAttribute('data-market-install');
      state.busy = 'mia:' + id;
      render();
      // Installing opens the new bot's chat.
      Promise.resolve(opts.installCatalog(id)).then(function(installed){ state.busy = null; if(installed) close(); else render(); });
      return;
    }
    get(target.getAttribute('data-market-team'), target.getAttribute('data-market-get'));
  }

  function onKey(event){
    if(!state) return;
    if(event.key === 'Escape'){
      event.preventDefault();
      if(state.editing){ var back = state.editing.id; state.editing = null; if(back) openSkill(back); else render(); }
      else if(state.detail){ state.detail = null; render(); }
      else close();
      return;
    }
    var card = event.target.closest && event.target.closest('[data-market-detail]');
    if(card && (event.key === 'Enter' || event.key === ' ') && event.target === card){
      event.preventDefault();
      var key = card.getAttribute('data-market-detail');
      if(key.indexOf('skill:') === 0) openSkill(key.slice(6)); else openDetail(key);
    }
  }

  function close(){
    if(!state) return;
    document.removeEventListener('keydown', onKey, true);
    state.scrim.remove();
    state.sheet.remove();
    state = null;
  }

  function open(options, shelf){
    opts = options;
    if(state) close();
    state = {shelf: 'mia', detail: null, editing: null, skills: null, query: '', catalog: {loading: true, entries: null, error: ''}, companies: [], market: {}, busy: null};
    state.scrim = document.createElement('div');
    state.scrim.className = 'styled-scrim open bot-market-scrim';
    state.scrim.addEventListener('click', close);
    state.sheet = document.createElement('div');
    state.sheet.className = 'styled-sheet styled-settings-sheet bot-market-sheet open';
    state.sheet.setAttribute('role', 'dialog');
    state.sheet.setAttribute('aria-modal', 'true');
    state.sheet.setAttribute('aria-label', 'Bot marketplace');
    state.sheet.addEventListener('click', onClick);
    state.sheet.addEventListener('input', function(event){
      if(!event.target.matches('[data-market-search]')) return;
      state.query = event.target.value;
      render();
    });
    document.body.appendChild(state.scrim);
    document.body.appendChild(state.sheet);
    document.addEventListener('keydown', onKey, true);
    render();
    var mine = state;
    Promise.resolve(opts.loadCatalog()).then(function(entries){
      if(state !== mine) return;
      state.catalog = {entries: entries || [], loading: false, error: ''};
      render();
    }, function(){
      if(state !== mine) return;
      state.catalog = {entries: null, loading: false, error: 'Mia\'s bots are unavailable right now.'};
      render();
    });
    Promise.resolve(opts.companies()).then(function(companies){
      if(state !== mine) return;
      state.companies = companies || [];
      // Open on the company you're in, else Mia's shelf.
      var start = shelf || (opts.currentTeamId() && state.companies.some(function(c){ return c.teamId === opts.currentTeamId(); }) ? 'company:' + opts.currentTeamId() : 'mia');
      pick(start);
    }, function(){ if(state === mine) render(); });
  }

  root.MiaBotMarketplace = {open: open, close: close, isOpen: function(){ return !!state; }, marketBot: function(raw){ opts = opts || {esc: String}; return marketBot(raw); }};
})(typeof window !== 'undefined' ? window : globalThis);
