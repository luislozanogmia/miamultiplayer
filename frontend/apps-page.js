(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaAppsPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  // The Apps page: small web apps people build and share. Solo shows what is on
  // this computer; a team view adds the team's catalog. Data shaping, markup and
  // the publish and install steps live here, with everything they reach passed
  // in; the app fetches, wires clicks and runs the panes.
  var ID = /^[a-f0-9]{32}$/;
  var SHA256 = /^[a-f0-9]{64}$/;
  var SCAN_WAIT_MS = 5000;
  var SCAN_WAITS = 60;
  var MAX_NAME_LENGTH = 80;
  var MAX_URL_LENGTH = 2048;
  var MAX_NOTE_LENGTH = 300;
  var HISTORY_LIMIT = 50;

  var ERRORS = {
    app_name_taken: 'Your company already has an app with that name. Rename the folder, then try again.',
    invalid_app: 'The company would not accept this app. Check its name and address, then try again.',
    file_not_ready: 'The virus check has not finished yet. Try again in a minute.',
    not_found: 'That app is no longer available.',
    hub_unavailable: 'Your company could not be reached. Check your connection, then try again.',
    sign_in_required: 'Sign in again, then try again.',
    forbidden: 'Only a company admin can do that.',
    app_limit: 'Your company has reached its limit of 200 apps. Remove one, then try again.',
    idempotency_conflict: 'That publish clashed with an earlier try. Try again.',
    version_rejected: 'This version was already turned down. Change the app, then publish again.',
    version_superseded: 'This version is no longer available. Check the list and try again.',
    version_already_approved: 'This version is already live.',
    version_pending: 'Someone else’s change to this app is waiting for approval. Try again once it is decided.',
    edit_pending_limit: 'You have 20 suggested edits waiting for approval. Try again once some are decided.',
    app_pending_limit: 'You have 20 apps that aren’t live yet, including any that were turned down. Remove any you no longer need, then try again.',
  };
  function errorMessage(error, fallback){
    if(error && ERRORS[error.code]) return ERRORS[error.code];
    if(error && ERRORS[error.message]) return ERRORS[error.message];
    return fallback || (error && error.message) || 'That did not work. Try again.';
  }

  // The app is still listed, but its file was deleted from the team.
  function openErrorMessage(error, publisherName){
    if(error && (error.code === 'not_found' || error.status === 404)){
      return "This app's file is no longer on your company. Ask " + (publisherName || 'whoever published it') + ' to publish it again.';
    }
    return errorMessage(error, 'That app could not be opened.');
  }

  function fail(message, code){
    var error = new Error(message);
    if(code) error.code = code;
    return error;
  }

  // Random, in the form the Hub expects for a new app's id.
  function newAppId(randomValues){
    var bytes = randomValues(new Uint8Array(16));
    return Array.prototype.map.call(bytes, function(byte){ return (byte < 16 ? '0' : '') + byte.toString(16); }).join('');
  }

  // A catalog row reduced to what can be trusted and shown. Anything that does
  // not fit the contract is dropped, not guessed at.
  function validVersion(version){
    if(!version || typeof version !== 'object' || !Number.isSafeInteger(version.version) || version.version < 1) return null;
    if(version.kind === 'bundle') return ID.test(version.fileId || '') && SHA256.test(version.sha256 || '') && Number.isSafeInteger(version.sizeBytes) ? version : null;
    if(version.kind === 'link') return isPublishableAddress(version.url) ? version : null;
    return null;
  }
  function normalizeCatalog(reply){
    var apps = reply && Array.isArray(reply.apps) ? reply.apps : [];
    return apps.filter(function(app){ return app && ID.test(app.id || '') && typeof app.name === 'string' && !app.archivedAt; }).map(function(app){
      return {id: app.id, name: app.name, description: String(app.description || ''), publisher: app.publisher && typeof app.publisher === 'object' ? app.publisher : {},
        live: validVersion(app.live), pending: validVersion(app.pending)};
    });
  }

  // Only https can be shared: a localhost address exists on one computer.
  function isPublishableAddress(value){
    try {
      var url = new URL(String(value));
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch(_){ return false; }
  }
  function linkPublishProblem(link){
    if(link && link.local) return 'A localhost address only works on your computer. To share this app, publish its folder instead.';
    if(!link || !isPublishableAddress(link.url)) return 'Only an https address can be shared with your company.';
    if(String(link.url).length > MAX_URL_LENGTH) return 'That address is too long to share with your company.';
    return '';
  }

  // What a row says about itself, in the order it matters to the person looking.
  function appState(app, scans){
    var pending = app.pending;
    if(pending && pending.state === 'rejected') return app.live ? 'live-rejected' : 'rejected';
    if(pending){
      var verdict = pending.kind === 'bundle' ? (scans && scans[pending.fileId]) || 'pending' : 'clean';
      if(verdict === 'blocked') return 'blocked';
      if(verdict === 'pending') return 'scanning';
      return app.live ? 'live-pending' : 'pending';
    }
    return app.live ? 'live' : 'none';
  }
  var STATE_TEXT = {
    live: 'Live',
    'live-pending': 'Live · new version waiting for approval',
    'live-rejected': 'Live · new version not approved',
    pending: 'Waiting for approval',
    scanning: 'Checking for viruses',
    rejected: 'Not approved',
    blocked: 'Blocked by the virus check',
    none: 'Not available',
  };
  function stateText(state){ return STATE_TEXT[state] || ''; }

  // ---- Reviewing ---------------------------------------------------------------
  var APP_SCAN_NOTE = 'The virus scan can’t fully see inside an app bundle, so review it first.';
  var REVIEW_TAG = 'apps-review:';
  function isWaitingForReview(app){ return !!(app && app.pending && app.pending.state !== 'rejected'); }
  // Admins of the team on screen only: a member never gets a count for this.
  function reviewCount(state){
    if(!state.isAdmin || !state.teamId) return 0;
    return state.catalog.filter(isWaitingForReview).length;
  }
  function reviewFromEvent(event, isAdmin){
    var review = event && event.kind === 'app_review' && event.app_review;
    if(!isAdmin || !review || !ID.test(review.app_id || '') || !Number.isSafeInteger(review.version) || review.version < 1) return null;
    return {appId: review.app_id, version: review.version};
  }
  function reviewNotice(app){ return (app ? '"' + app.name + '" is' : 'A company app is') + ' waiting for your review.'; }
  function reviewTag(appId){ return REVIEW_TAG + appId; }
  function reviewTagApp(tag){
    var text = String(tag || '');
    var appId = text.indexOf(REVIEW_TAG) === 0 ? text.slice(REVIEW_TAG.length) : '';
    return ID.test(appId) ? appId : '';
  }
  function approveMessage(app){
    var pending = app.pending || {}, sender = senderLine(app, pending);
    if(pending.kind === 'link') return 'Approve "' + app.name + '" for everyone? It opens ' + pending.url + ' on every colleague’s computer, in their Mia browser with their own sign-ins. ' + sender + ' Only approve an address you trust.';
    return 'Approve "' + app.name + '" for everyone? It runs on every colleague’s computer. ' + sender + ' ' + APP_SCAN_NOTE;
  }
  function blockedLinkNote(blocked){
    if(blocked && blocked.reason === 'no-input') return 'This app tried to open ' + blocked.host + ' without a click, so Mia stopped it. Click inside the app to open a link.';
    return 'This app tried to open an address Mia does not allow, so Mia stopped it.';
  }
  function formatSize(bytes){
    var value = Number(bytes) || 0;
    if(value < 1024) return value + ' B';
    if(value < 1024 * 1024) return Math.round(value / 1024) + ' KB';
    return (Math.round(value / 104857.6) / 10) + ' MB';
  }

  // Pending bundles whose virus check is worth asking about.
  function filesToCheck(catalog, scans){
    return catalog.filter(function(app){
      return app.pending && app.pending.kind === 'bundle' && app.pending.state !== 'rejected' && (!scans[app.pending.fileId] || scans[app.pending.fileId] === 'pending');
    }).map(function(app){ return app.pending.fileId; });
  }

  // A saved link's name can be longer than the Hub allows.
  function hubName(name){ return Array.from(String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trim(); }

  // The team app a local folder or link was published as: same name, same person.
  function publishedAs(catalog, name, me){
    var wanted = hubName(name).toLowerCase();
    return catalog.filter(function(app){
      return app.name.trim().toLowerCase() === wanted && !!me && app.publisher.id === me;
    })[0] || null;
  }

  // Where publishing a local item goes: a new version of a company app, or a new
  // app when there is none. A folder copied from a company app goes back to that
  // app, as a suggested edit when someone else published it; anything else
  // updates the app this person published under the same name.
  function publishTarget(catalog, item, teamId, me){
    var source = item && item.source;
    if(source && teamId && source.teamId === teamId){
      var copied = catalog.filter(function(app){ return app.id === source.appId && !!app.live; })[0];
      if(copied) return {app: copied, suggest: !me || copied.publisher.id !== me};
    }
    var mine = publishedAs(catalog, item && item.name, me);
    return mine ? {app: mine, suggest: false} : null;
  }
  function personName(value){ return typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : ''; }
  // Who sent a version. Every place that asks someone to decide on a version, or
  // lists one, names this person: on a suggested edit it is not the publisher.
  function sentBy(app, version){
    var publisher = app && app.publisher || {};
    var id = version && typeof version.proposedBy === 'string' ? version.proposedBy : '';
    var own = !!id && id === publisher.id;
    return {known: !!id, publisher: own, name: personName(version && version.proposedByName) || (own && personName(publisher.name)) || (id ? 'a colleague' : 'someone Mia could not name')};
  }
  // One sentence for a confirm step, so nobody approves an edit thinking the publisher sent it.
  function senderLine(app, version){
    var sender = sentBy(app, version), publisher = personName(app && app.publisher && app.publisher.name) || 'a former colleague';
    if(sender.publisher) return 'Sent by ' + sender.name + ', who published this app.';
    if(sender.known) return 'This version is a suggested edit sent by ' + sender.name + ', not by ' + publisher + ', who published the app.';
    return 'Mia could not tell who sent this version. The app was published by ' + publisher + '.';
  }
  // A suggested edit is a version sent by someone other than the app's publisher.
  function suggestedBy(app){
    var sender = sentBy(app, app && app.pending);
    return sender.known && !sender.publisher ? sender.name : '';
  }

  // An app's history as the company answers it: newest first, each version with
  // who sent it and who decided it. Rows that do not fit are dropped.
  function normalizeHistory(reply){
    var rows = reply && Array.isArray(reply.versions) ? reply.versions : [];
    var seconds = function(value){ return Number.isSafeInteger(value) && value > 0 ? value : 0; };
    var id = function(value){ return typeof value === 'string' ? value.slice(0, 200) : ''; };
    return rows.filter(function(row){ return row && typeof row === 'object' && Number.isSafeInteger(row.version) && row.version > 0; }).slice(0, HISTORY_LIMIT).map(function(row){
      var link = row.kind === 'link';
      return {version: row.version, kind: link ? 'link' : 'bundle', url: link && isPublishableAddress(row.url) ? String(row.url).slice(0, MAX_URL_LENGTH) : '',
        note: typeof row.note === 'string' ? row.note.trim().slice(0, MAX_NOTE_LENGTH) : '',
        state: ['pending', 'approved', 'rejected', 'superseded'].indexOf(row.state) === -1 ? '' : row.state,
        proposedBy: id(row.proposedBy), proposedByName: personName(row.proposedByName), proposedAt: seconds(row.proposedAt),
        decidedBy: id(row.decidedBy), decidedByName: personName(row.decidedByName), decidedAt: seconds(row.decidedAt)};
    });
  }
  function historyDate(seconds){
    return new Date(seconds * 1000).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
  }
  function historyOutcome(app, version){
    if(version.state === 'approved') return app.live && app.live.version === version.version ? 'Live now' : 'Was live';
    if(version.state === 'pending') return 'Waiting for approval';
    if(version.state === 'rejected') return 'Turned down';
    if(version.state === 'superseded') return version.decidedBy ? 'Turned down, then replaced' : 'Replaced before going live';
    return 'Unknown';
  }
  function historyDecision(version, when){
    if(!version.decidedBy) return '';
    var name = version.decidedByName || 'an admin', on = version.decidedAt ? ' on ' + when(version.decidedAt) : '';
    if(version.state === 'approved') return (version.decidedBy === version.proposedBy ? 'published directly by ' + name + ', an admin' : 'approved by ' + name) + on;
    return 'turned down by ' + name + on;
  }
  // The history list, the same on the Apps page and in Company controls.
  // entry: {loading} | {error} | {versions}. when(seconds) writes a date.
  function historyHtml(esc, app, entry, when){
    when = when || historyDate;
    var html = '<div class="app-history" data-app-history-of="' + esc(app.id) + '"><div class="app-history-head">History of ' + esc(app.name) + '</div>';
    if(!entry || entry.loading && !entry.versions) return html + '<div class="app-history-note" role="status">Loading…</div></div>';
    if(entry.error) return html + '<div class="app-history-note app-history-bad" role="alert">' + esc(entry.error) + '</div></div>';
    var versions = entry.versions || [];
    if(!versions.length) return html + '<div class="app-history-note">No versions to show.</div></div>';
    html += '<ol class="app-history-list">' + versions.map(function(version){
      var sender = sentBy(app, version), decided = historyDecision(version, when);
      var who = 'Sent by ' + sender.name + (sender.known && !sender.publisher ? ', as a suggested edit' : '') + (version.proposedAt ? ' on ' + when(version.proposedAt) : '');
      var detail = [version.url, version.note].filter(Boolean).join(' · ');
      return '<li class="app-history-row"><div class="app-history-line"><span class="app-history-version">Version ' + Number(version.version) + '</span>'
        + '<span class="app-history-state' + (version.state ? ' app-history-' + version.state : '') + '">' + esc(historyOutcome(app, version)) + '</span></div>'
        + '<div class="app-history-who">' + esc(who) + (decided ? ' · ' + esc(decided) : '') + '</div>'
        + (detail ? '<div class="app-history-detail">' + esc(detail) + '</div>' : '') + '</li>';
    }).join('') + '</ol>';
    if(versions.length >= HISTORY_LIMIT) html += '<div class="app-history-note">These are the newest ' + HISTORY_LIMIT + ' versions.</div>';
    return html + '</div>';
  }
  function historyError(error){
    if(error && (error.status === 404 || error.code === 'not_found')) return 'This app’s history is not available.';
    return errorMessage(error, 'The history could not be loaded. Try again.');
  }
  function publishConfirmText(files, target){
    if(target && target.suggest) return 'Send these ' + files.length + ' files as a suggested edit to "' + target.app.name + '"? An admin approves it before anyone gets it.\n\n' + files.join('\n');
    return 'Publish these ' + files.length + ' files to the company?\n\n' + files.join('\n');
  }
  function publishedNotice(name, target, isAdmin){
    if(target && target.suggest) return isAdmin ? 'Your edit to "' + target.app.name + '" is live.' : 'Your edit to "' + target.app.name + '" is waiting for an admin to approve it.';
    return isAdmin ? '"' + name + '" is published.' : '"' + name + '" is waiting for an admin to approve it.';
  }
  function copiedNotice(name, folder){ return 'A copy of "' + name + '" is in your Mia folder, in ' + folder + '. Change it, then choose Suggest an edit.'; }

  function matches(values, query){
    var q = String(query || '').trim().toLowerCase();
    if(!q) return true;
    return values.some(function(value){ return String(value || '').toLowerCase().indexOf(q) !== -1; });
  }

  // ---- Publishing -------------------------------------------------------------
  // Add the app or a new version of it. Member publishes wait for an admin; the
  // Hub decides that, so this only reports what it says. The file may still be in
  // its virus check, which the Hub can refuse with file_not_ready: wait, then ask again.
  async function submitVersion(options){
    var call = options.call, base = '/v1/teams/' + options.teamId + '/apps', body = options.version;
    var send = function(){
      if(options.existing) return call('POST', base + '/' + options.existing.id + '/versions', body);
      return call('POST', base, Object.assign({id: options.newId(), name: hubName(options.name), description: options.description || ''}, body));
    };
    for(var attempt = 0;; attempt++){
      try { return await send(); }
      catch(error){
        if(!error || error.code !== 'file_not_ready' || !options.waitForScan || attempt) throw error;
        await options.waitForScan();
      }
    }
  }

  async function publishLink(options){
    var problem = linkPublishProblem(options.link);
    if(problem) throw fail(problem);
    return submitVersion({call: options.call, teamId: options.teamId, existing: options.existing, newId: options.newId, name: options.link.name,
      version: {kind: 'link', url: options.link.url}});
  }

  // The team files upload manager, with one upload's progress to follow. These
  // uploads aren't resumed after a restart: publishing again starts over.
  function createUploader(createManager, options){
    var listeners = [];
    var manager = createManager(Object.assign({}, options, {onChange: function(jobs){
      listeners.slice().forEach(function(listener){ listener(jobs); });
    }}));
    return {
      addJob: function(file){
        var rejected = manager.add([file]);
        if(rejected && rejected.length) return {rejected: rejected[0].message};
        var jobs = manager.jobs();
        return {id: jobs[jobs.length - 1].id};
      },
      forget: function(id){ manager.forget(id); },
      watch: function(listener){
        listeners.push(listener);
        return function(){ listeners = listeners.filter(function(entry){ return entry !== listener; }); };
      },
      jobs: function(){ return manager.jobs(); },
    };
  }

  // Waits for one upload to reach the Hub, then for nothing else: the page shows
  // the virus check from the catalog after that.
  function uploaded(uploader, jobId){
    return new Promise(function(resolve, reject){
      var stop = function(){};
      function look(jobs){
        var job = jobs.filter(function(entry){ return entry.id === jobId; })[0];
        if(!job){ stop(); reject(fail('The upload stopped. Try again.')); return; }
        if(job.state === 'scanning' || job.state === 'clean'){ stop(); resolve(job); }
        else if(job.state === 'quarantined'){ stop(); reject(fail('The virus check refused this app.')); }
        else if(job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired' || job.state === 'interrupted'){
          stop();
          reject(fail(job.error && job.error.message || 'The upload did not finish. Try again.'));
        }
      }
      stop = uploader.watch(look);
      look(uploader.jobs());
    });
  }

  // Builds the bundle, uploads it to the team's app space and publishes it.
  // Steps are named so the page can say what is happening.
  async function publishFolder(options){
    var step = options.onStep || function(){};
    step('building');
    if(typeof options.previewBundle !== 'function' || typeof options.confirmBundle !== 'function') throw fail('Review the app files before publishing.');
    var preview = await options.previewBundle(options.item.id);
    if(!preview || !Array.isArray(preview.files) || !/^[a-f0-9]{64}$/.test(preview.sha256 || '') || preview.files.length !== preview.fileCount) throw fail('The app file list could not be checked.');
    step('reviewing');
    if(!await options.confirmBundle(preview.files)) return {cancelled: true};
    var bundle = await options.buildBundle(options.item.id, preview.sha256);
    step('uploading');
    var added = options.uploader.addJob(bundle.file);
    if(added.rejected) throw fail(added.rejected);
    var job = await uploaded(options.uploader, added.id);
    var fileId = job.record && job.record.fileId;
    if(!ID.test(fileId || '')) throw fail('The upload did not finish. Try again.');
    // Mia follows this file's virus check through the catalog, not the upload list.
    options.uploader.forget(added.id);
    step('publishing');
    return submitVersion({call: options.call, teamId: options.teamId, existing: options.existing, newId: options.newId, name: options.item.name,
      version: {kind: 'bundle', fileId: fileId},
      waitForScan: function(){ return waitForScan({client: options.client, fileId: fileId, sleep: options.sleep, verdict: options.verdict}); }});
  }

  async function waitForScan(options){
    for(var i = 0; i < SCAN_WAITS; i++){
      var verdict = options.verdict(await options.client.status(options.fileId));
      if(verdict === 'clean') return;
      if(verdict === 'blocked') throw fail('The virus check refused this app.');
      await options.sleep(SCAN_WAIT_MS);
    }
    throw fail('The virus check is taking a while. Try publishing again soon.');
  }

  // ---- Opening a team app -----------------------------------------------------
  // Installed already, or downloaded from the team (the client checks the file's
  // hash) and handed to the backend, which checks it and every path again.
  async function installVersion(options){
    var version = options.version;
    if(!version || version.kind !== 'bundle' || !ID.test(version.fileId || '') || !SHA256.test(version.sha256 || '')) throw fail('That app could not be found.');
    var identity = {teamId: options.teamId, appId: options.appId, version: version.version};
    if(await options.isInstalled(identity, version.sha256)) return identity;
    var blob = await options.download({fileId: version.fileId, sizeBytes: version.sizeBytes, sha256: version.sha256, spaceId: options.teamId, spaceKind: 'app'});
    await options.install(identity, version.sha256, blob);
    return identity;
  }

  // ---- Tabs -------------------------------------------------------------------
  function stripTabs(state, icon){
    var waiting = reviewCount(state);
    var page = state.tabClosed ? [] : [{id: 'page', label: waiting ? 'Apps (' + waiting + ')' : 'Apps', iconHtml: icon, active: state.open && state.activeTab === 'page'}];
    return page.concat(state.tabs.map(function(tab){
      return {id: tab.key, label: tab.name, title: tab.name, iconHtml: icon, active: state.open && state.activeTab === tab.key};
    }));
  }
  function nextTabAfterClose(state, key){
    if(state.activeTab !== key) return state.activeTab;
    var at = state.tabs.findIndex(function(tab){ return tab.key === key; });
    var rest = state.tabs.filter(function(tab){ return tab.key !== key; });
    return rest.length ? rest[Math.min(at, rest.length - 1)].key : 'page';
  }

  // ---- Markup -----------------------------------------------------------------
  function address(url){
    try { var parsed = new URL(url); return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname); }
    catch(_){ return String(url || ''); }
  }
  function button(esc, label, attributes, primary){
    return '<button type="button" class="artifacts-bar-text-btn' + (primary ? ' primary' : '') + '" ' + attributes + '>' + esc(label) + '</button>';
  }
  function row(esc, thumb, name, meta, actions, siteUrl){
    return '<div class="artifacts-row apps-row" role="listitem"><div class="apps-row-main"><span class="artifacts-thumb"' + (siteUrl ? ' data-site-url="' + esc(siteUrl) + '"' : '') + '>' + esc(thumb) + '</span>'
      + '<span class="artifacts-row-text"><span class="artifacts-row-name">' + esc(name) + '</span>'
      + '<span class="artifacts-row-meta apps-row-meta">' + meta + '</span></span></div>'
      + '<div class="apps-row-actions">' + actions + '</div></div>';
  }
  function section(esc, title, rows){
    return rows.length ? '<div class="artifacts-section-title">' + esc(title) + '</div><div class="artifacts-list" role="list">' + rows.join('') + '</div>' : '';
  }
  var STEP_TEXT = {building: 'Checking app files…', reviewing: 'Waiting for your review…', uploading: 'Uploading…', publishing: 'Publishing…'};
  function publishCell(esc, item, state, itemId, target){
    var job = state.publishing && state.publishing[itemId];
    if(job && job.step) return '<span class="apps-note" role="status">' + esc(STEP_TEXT[job.step] || 'Working…') + '</span>';
    var label = target ? (target.suggest ? 'Suggest an edit' : 'Publish update') : 'Publish to company';
    return (job && job.error ? '<span class="apps-note apps-note-bad" role="alert">' + esc(job.error) + '</span>' : '')
      + button(esc, label, 'data-app-publish="' + esc(itemId) + '"');
  }
  function localRows(esc, state){
    var team = !!state.teamId;
    var folders = state.local.filter(function(item){ return matches([item.name, item.folder, item.from], state.query); }).map(function(item){
      var target = team ? publishTarget(state.catalog, item, state.teamId, state.me) : null;
      var meta = esc(item.folder) + (item.from ? ' · ' + esc(item.from) : '') + (target && target.suggest ? ' · your copy of ' + esc(target.app.name) : '');
      return row(esc, 'App', item.name, meta, button(esc, 'Open', 'data-app-open-local="' + esc(item.id) + '"', true) + (team ? publishCell(esc, item, state, item.id, target) : ''));
    });
    var links = state.links.filter(function(item){ return matches([item.name, item.url], state.query); }).map(function(item){
      var existing = team ? publishTarget(state.catalog, item, state.teamId, state.me) : null;
      var running = item.running === true ? ' · <span class="artifacts-dot on">● running</span>' : item.running === false ? ' · <span class="artifacts-dot">○ off</span>' : '';
      return row(esc, 'Link', item.name, esc(address(item.url)) + running, (item.running === true && item.local ? button(esc, 'Stop', 'data-app-stop-link="' + esc(item.id) + '"') : '') + button(esc, 'Open', 'data-app-open-link="' + esc(item.id) + '"', true) + (team ? publishCell(esc, item, state, item.id, existing) : ''), item.url);
    });
    return folders.concat(links);
  }
  function catalogRow(esc, app, state){
    var status = appState(app, state.scans), busy = state.installing && state.installing[app.id], copying = state.copying && state.copying[app.id];
    var who = app.publisher && app.publisher.name ? esc(app.publisher.name) : '';
    var edit = isWaitingForReview(app) && suggestedBy(app);
    var meta = [who, app.description ? esc(app.description) : '', '<span class="apps-state apps-state-' + esc(status) + '">' + esc(stateText(status)) + '</span>',
      edit ? 'edit suggested by ' + esc(edit) : ''].filter(Boolean).join(' · ');
    var actions = '';
    if(busy && busy.error) actions += '<span class="apps-note apps-note-bad" role="alert">' + esc(busy.error) + '</span>';
    if(busy && !busy.error) actions += '<span class="apps-note" role="status">' + esc(busy.percent != null ? 'Getting it… ' + busy.percent + '%' : 'Getting it…') + '</span>';
    else if(app.live) actions += button(esc, 'Open', 'data-app-open-team="' + esc(app.id) + '"', true);
    // A copy in the Mia folder is where a change to this app is made, by anyone.
    if(copying && copying.error) actions += '<span class="apps-note apps-note-bad" role="alert">' + esc(copying.error) + '</span>';
    if(copying && !copying.error) actions += '<span class="apps-note" role="status">Copying…</span>';
    else if(app.live && app.live.kind === 'bundle' && !(busy && !busy.error)) actions += button(esc, 'Edit a copy', 'data-app-copy="' + esc(app.id) + '"');
    if(state.isAdmin && app.pending && app.pending.state !== 'rejected'){
      var ready = status === 'pending' || status === 'live-pending';
      if(ready) actions += button(esc, 'Approve', 'data-app-approve="' + esc(app.id) + '"') + button(esc, 'Reject', 'data-app-reject="' + esc(app.id) + '"');
    }
    var history = state.history && state.history[app.id];
    actions += button(esc, history ? 'Hide history' : 'History', 'data-app-history="' + esc(app.id) + '"' + (history ? ' aria-expanded="true"' : ' aria-expanded="false"'));
    if(state.isAdmin || (state.me && app.publisher.id === state.me)) actions += button(esc, 'Remove', 'data-app-archive="' + esc(app.id) + '" aria-label="Remove ' + esc(app.name) + ' from the company"');
    return row(esc, app.live && app.live.kind === 'link' || (!app.live && app.pending && app.pending.kind === 'link') ? 'Link' : 'App', app.name, meta, actions)
      + (state.isAdmin && isWaitingForReview(app) ? reviewBlock(esc, app, state, status) : '')
      + (history ? historyHtml(esc, app, history, state.historyDate) : '');
  }
  // What an admin can look at before deciding. Nothing here opens by itself.
  function reviewBlock(esc, app, state, status){
    var pending = app.pending, html = '<div class="apps-review" role="listitem" data-app-review="' + esc(app.id) + '">';
    var edit = suggestedBy(app);
    if(pending.kind === 'link'){
      return html + '<div class="apps-review-head">Version ' + Number(pending.version) + (edit ? ', an edit suggested by ' + esc(edit) + ',' : '') + ' is this address:</div><div class="apps-review-address">' + esc(pending.url) + '</div>'
        + '<div class="apps-review-actions">' + button(esc, 'Open address', 'data-app-preview="' + esc(app.id) + '"') + '</div></div>';
    }
    html += '<div class="apps-review-head">Version ' + Number(pending.version) + ' · ' + esc(formatSize(pending.sizeBytes)) + (edit ? ' · an edit suggested by ' + esc(edit) : '') + '</div>';
    if(status === 'scanning') return html + '<div class="apps-note" role="status">You can preview it once the virus check is done.</div></div>';
    if(status === 'blocked') return html + '<div class="apps-note apps-note-bad" role="status">The virus check refused this version, so it can’t be previewed.</div></div>';
    var previews = state.previews || {}, preview = previews[app.id] && previews[app.id].version === pending.version ? previews[app.id] : null;
    var actions = preview && preview.loading
      ? '<span class="apps-note" role="status">' + esc(preview.percent != null ? 'Getting it… ' + preview.percent + '%' : 'Getting it…') + '</span>'
      : button(esc, 'Preview', 'data-app-preview="' + esc(app.id) + '"');
    if(preview && preview.error) actions = '<span class="apps-note apps-note-bad" role="alert">' + esc(preview.error) + '</span>' + actions;
    html += '<div class="apps-review-actions">' + actions + '<span class="apps-note">Runs in a sandbox, apart from the live app.</span></div>';
    if(preview && preview.files){
      html += '<div class="apps-review-head">' + preview.files.length + (preview.files.length === 1 ? ' file' : ' files') + ' · ' + esc(formatSize(preview.totalBytes)) + '</div><ul class="apps-review-files">'
        + preview.files.map(function(file){ return '<li><span class="apps-review-path">' + esc(file.path) + '</span><span class="apps-note">' + esc(formatSize(file.sizeBytes)) + '</span></li>'; }).join('') + '</ul>';
    }
    return html + '</div>';
  }
  function bodyHtml(state, esc){
    var team = !!state.teamId;
    if(state.loading && !state.local.length && !state.links.length && !state.catalog.length) return '<div class="artifacts-empty">Loading…</div>';
    var mine = localRows(esc, state);
    var listed = team ? state.catalog.filter(function(app){ return matches([app.name, app.description, app.publisher.name], state.query); }) : [];
    var toReview = state.isAdmin ? listed.filter(isWaitingForReview) : [];
    var rowOf = function(app){ return catalogRow(esc, app, state); };
    var shared = listed.filter(function(app){ return toReview.indexOf(app) === -1; }).map(rowOf);
    var html = '';
    if(state.error) html += '<div class="artifacts-empty">' + esc(state.error) + '</div>';
    if(team && state.catalogError) html += '<div class="apps-banner" role="status"><span>' + esc(state.catalogError) + '</span>' + button(esc, 'Try again', 'data-apps-retry') + '</div>';
    if(team) html += section(esc, 'Waiting for your review', toReview.map(rowOf)) + section(esc, 'Your company', shared);
    html += section(esc, 'On this computer', mine);
    if(html) return html;
    if(state.query) return '<div class="artifacts-empty">Nothing matches.</div>';
    return '<div class="artifacts-empty"><div class="artifacts-empty-title">Your apps show up here</div>'
      + '<div>' + (team ? 'Apps your company shares, and any folder with an index.html in your Mia folder.' : 'Any folder with an index.html in your Mia folder, and the links you save.') + '</div>'
      + button(esc, 'Build with a bot', 'data-app-build', true) + '</div>';
  }
  function runHtml(tab, esc){
    if(tab.status === 'error') return '<div class="artifacts-empty"><div class="artifacts-empty-title">' + esc(tab.name) + ' could not run</div><div>' + esc(tab.error || 'This app could not be loaded.') + '</div>'
      + button(esc, 'Try again', 'data-app-reload="' + esc(tab.key) + '"', true) + '</div>';
    return '';
  }

  var BUILD_PROMPT = 'Build me a small web app: [say what it should do].\n\n'
    + 'Make it a static web app, using only HTML, CSS and JavaScript with no server, in a new folder under apps/ in the Mia folder, '
    + 'with an index.html at the top of that folder. Keep every file it needs inside that folder. Tell me the folder name when it is done.';

  return {APP_SCAN_NOTE: APP_SCAN_NOTE, approveMessage: approveMessage, blockedLinkNote: blockedLinkNote, isWaitingForReview: isWaitingForReview, reviewCount: reviewCount, reviewFromEvent: reviewFromEvent, reviewNotice: reviewNotice, reviewTag: reviewTag, reviewTagApp: reviewTagApp,
    BUILD_PROMPT: BUILD_PROMPT, appState: appState, bodyHtml: bodyHtml, createUploader: createUploader, errorMessage: errorMessage, filesToCheck: filesToCheck, installVersion: installVersion,
    isPublishableAddress: isPublishableAddress, linkPublishProblem: linkPublishProblem, matches: matches, newAppId: newAppId, openErrorMessage: openErrorMessage, nextTabAfterClose: nextTabAfterClose,
    normalizeCatalog: normalizeCatalog, publishFolder: publishFolder, publishLink: publishLink, publishedAs: publishedAs, publishTarget: publishTarget, publishConfirmText: publishConfirmText, publishedNotice: publishedNotice, copiedNotice: copiedNotice, suggestedBy: suggestedBy, sentBy: sentBy, senderLine: senderLine, normalizeHistory: normalizeHistory, historyHtml: historyHtml, historyError: historyError, runHtml: runHtml, stateText: stateText,
    stripTabs: stripTabs, submitVersion: submitVersion, waitForScan: waitForScan};
});
