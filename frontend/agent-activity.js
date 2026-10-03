(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaAgentActivity = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  var MAX_FILES = 30;

  // Folds one live activity signal (see backend/agent-activity.js) into the
  // room's status-panel state. A new dispatch replaces the previous turn.
  // Files are most-recent-first. A write counts as an edit only once its
  // completion reports success: until then the file is "editing", and a
  // failed write is "failed" unless an earlier write to it already succeeded.
  function cloneState(state){
    var pending = {};
    for(var id in state.pending) if(Object.prototype.hasOwnProperty.call(state.pending, id)) pending[id] = state.pending[id];
    return {
      dispatchId: state.dispatchId, agentName: state.agentName, startedAt: state.startedAt,
      label: state.label, files: state.files.slice(), pending: pending
    };
  }

  function touchFile(next, path, kind, at){
    var edited = false;
    for(var j = 0; j < next.files.length; j++){
      if(next.files[j].path === path){
        edited = Boolean(next.files[j].edited);
        next.files.splice(j, 1);
        break;
      }
    }
    if(kind === 'edit') edited = true;
    next.files.unshift({path: path, kind: edited ? 'edit' : kind, edited: edited, at: at});
  }

  function reduceActivity(state, activity){
    if(!activity || typeof activity.dispatchId !== 'string' || !activity.dispatchId) return state || null;
    var at = Number(activity.at) || Date.now();
    var next = state && state.dispatchId === activity.dispatchId ? cloneState(state) : {
      dispatchId: activity.dispatchId, agentName: activity.agentName || '', startedAt: at, label: '', files: [], pending: {}
    };
    if(activity.phase === 'start' && activity.label) next.label = String(activity.label);
    var toolId = typeof activity.toolId === 'string' ? activity.toolId : '';
    var paths = Array.isArray(activity.paths) ? activity.paths : [];
    var isEdit = activity.kind === 'edit';
    if(isEdit && activity.phase === 'complete' && !paths.length && toolId && next.pending[toolId]){
      paths = next.pending[toolId];
    }
    if(isEdit && toolId){
      if(activity.phase === 'start') next.pending[toolId] = paths.slice();
      else delete next.pending[toolId];
    }
    var kind = !isEdit ? 'read'
      : activity.phase === 'start' ? 'editing'
        : activity.ok === false ? 'failed' : 'edit';
    for(var i = 0; i < paths.length; i++){
      var path = String(paths[i] || '');
      if(path) touchFile(next, path, kind, at);
    }
    if(next.files.length > MAX_FILES) next.files.length = MAX_FILES;
    return next;
  }

  // The badge for one file: a successful edit wins over anything after it.
  function fileStatus(file, live){
    if(file.kind === 'edit') return {kind: 'edit', text: 'Edited'};
    if(file.kind === 'failed') return {kind: 'failed', text: 'Edit failed'};
    if(file.kind === 'editing') return live ? {kind: 'editing', text: 'Editing'} : {kind: 'failed', text: 'Not saved'};
    return {kind: 'read', text: 'Read'};
  }

  function basename(path){
    var text = String(path || '').replace(/[\\/]+$/, '');
    var parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
  }

  function formatElapsed(ms){
    var total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    if(minutes >= 60) return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    return minutes > 0 ? minutes + 'm ' + (seconds < 10 ? '0' : '') + seconds + 's' : seconds + 's';
  }

  return {reduceActivity: reduceActivity, fileStatus: fileStatus, basename: basename, formatElapsed: formatElapsed, MAX_FILES: MAX_FILES};
});
