(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaAgentActivity = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  'use strict';
  var MAX_FILES = 30;

  // Folds one live activity signal (see backend/agent-activity.js) into the
  // room's status-panel state. A new dispatch replaces the previous turn.
  // Files are most-recent-first; a file that was edited stays "edit" even if
  // it is read again afterwards.
  function reduceActivity(state, activity){
    if(!activity || typeof activity.dispatchId !== 'string' || !activity.dispatchId) return state || null;
    var at = Number(activity.at) || Date.now();
    var next = state && state.dispatchId === activity.dispatchId ? {
      dispatchId: state.dispatchId, agentName: state.agentName, startedAt: state.startedAt,
      label: state.label, files: state.files.slice()
    } : {
      dispatchId: activity.dispatchId, agentName: activity.agentName || '', startedAt: at, label: '', files: []
    };
    if(activity.phase === 'start' && activity.label) next.label = String(activity.label);
    var paths = Array.isArray(activity.paths) ? activity.paths : [];
    for(var i = 0; i < paths.length; i++){
      var path = String(paths[i] || '');
      if(!path) continue;
      var kind = activity.kind === 'edit' ? 'edit' : 'read';
      for(var j = 0; j < next.files.length; j++){
        if(next.files[j].path === path){
          if(next.files[j].kind === 'edit') kind = 'edit';
          next.files.splice(j, 1);
          break;
        }
      }
      next.files.unshift({path: path, kind: kind, at: at});
    }
    if(next.files.length > MAX_FILES) next.files.length = MAX_FILES;
    return next;
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

  return {reduceActivity: reduceActivity, basename: basename, formatElapsed: formatElapsed, MAX_FILES: MAX_FILES};
});
