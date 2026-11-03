(function(root){
  'use strict';
  // Personal agents in the sidebar: a list of the person's own extra agents
  // with create, rename, delete (confirmed) and open. They live only in Solo
  // and have no share action anywhere. app.js hands this module its helpers
  // through init(); everything here goes through the /api/private-agents routes.

  function isConversation(conversation){
    var metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
    return !!conversation && conversation.type === 'agent' && typeof metadata.privateAgentId === 'string' && metadata.privateAgentId !== '';
  }
  function agentIdOf(conversation){
    return isConversation(conversation) ? conversation.metadata.privateAgentId : null;
  }
  // The name shown for an agent's replies (events from the shared 'gateway' sender).
  function nameForConversation(conversations, conversationId){
    var found = (conversations || []).filter(function(item){ return item && item.id === conversationId; })[0];
    return isConversation(found) ? (found.name || null) : null;
  }
  function mainConversation(conversations, agentId){
    return (conversations || []).filter(function(item){
      return agentIdOf(item) === agentId && !(item.metadata && item.metadata.conversationMode === 'fresh');
    }).sort(function(a, b){ return String(a.createdAt).localeCompare(String(b.createdAt)); })[0] || null;
  }

  function rowHtml(agent, options){
    var esc = options.esc, active = !!options.active;
    var name = String(agent.name || 'Agent');
    return '<div class="private-agent-row" data-private-agent-id="' + esc(agent.id) + '">' +
      '<button type="button" class="chat-recent-row' + (active ? ' active' : '') + '" data-private-agent-open="' + esc(agent.id) + '" title="Private to you">' +
        '<span class="chat-row-mark tile">' + (options.avatar ? options.avatar(name, agent.id) : esc(name.charAt(0).toUpperCase())) + '</span>' +
        '<span class="row-text"><span class="row-line1"><span class="row-label">' + esc(name) + '</span></span>' +
        '<span class="row-preview">Private agent</span></span></button>' +
      '<span class="private-agent-actions">' +
        '<button type="button" class="chat-section-icon-btn" data-private-agent-rename="' + esc(agent.id) + '" title="Rename" aria-label="Rename ' + esc(name) + '">Rename</button>' +
        '<button type="button" class="chat-section-icon-btn" data-private-agent-delete="' + esc(agent.id) + '" title="Delete" aria-label="Delete ' + esc(name) + '">Delete</button>' +
      '</span></div>';
  }

  var host = null, agents = [], loaded = false, loading = false, listEl = null, lastUser = null;

  function messageFor(res, fallback){
    return res && res.data && (res.data.message || res.data.error) ? (res.data.message || res.data.error) : fallback;
  }
  function solo(){ return !host.hubWorkspace(); }

  function render(){
    if(!host || !listEl) return;
    if(!solo()){ listEl.innerHTML = ''; return; }
    var activeRoom = host.activeRoomId();
    listEl.innerHTML = agents.map(function(agent){
      var chat = mainConversation(host.conversations(), agent.id);
      return rowHtml(agent, {esc: host.esc, avatar: host.avatar, active: !!chat && chat.id === activeRoom});
    }).join('');
  }
  function refresh(){
    if(!host || !solo() || loading) return Promise.resolve();
    loading = true;
    return host.api('/api/private-agents').then(function(res){
      if(res.status === 200 && res.data && Array.isArray(res.data.agents)){ agents = res.data.agents; loaded = true; }
    }).catch(function(){}).then(function(){ loading = false; render(); });
  }
  // Called whenever the sidebar redraws.
  function sync(){
    if(!host) return;
    var who = host.currentUser();
    if(who !== lastUser){ lastUser = who; agents = []; loaded = false; }
    if(!loaded && !loading) refresh(); else render();
  }

  function open(agentId){
    var agent = agents.filter(function(item){ return item.id === agentId; })[0];
    if(!agent) return Promise.resolve();
    return host.api('/api/private-agents/' + encodeURIComponent(agentId) + '/conversation', {method:'POST', body:{}}).then(function(res){
      if(res.status !== 200 || !res.data || !res.data.conversation){
        host.toast(messageFor(res, 'Could not open this agent.'));
        return;
      }
      host.adopt(res.data.conversation);
      return host.loadChatRoom(res.data.conversation.id, 'agent', agent.name);
    }).catch(function(){ host.toast('Could not open this agent.'); });
  }

  function create(){
    if(!host || !solo()) return Promise.resolve();
    return host.prompt('', {
      title: 'New agent', message: 'Name your agent. It is private to you, runs on your computer, and keeps its own memory.',
      singleLine: true, maxLength: 40, inputLabel: 'Agent name', submitLabel: 'Create'
    }).then(function(name){
      name = String(name || '').trim();
      if(!name) return;
      return host.api('/api/private-agents', {method:'POST', body:{name:name}}).then(function(res){
        if(res.status !== 201 || !res.data || !res.data.agent){ host.toast(messageFor(res, 'Could not create the agent.')); return; }
        agents.push(res.data.agent);
        render();
        return open(res.data.agent.id);
      });
    }).catch(function(){ host.toast('Could not create the agent.'); });
  }

  function rename(agentId){
    var agent = agents.filter(function(item){ return item.id === agentId; })[0];
    if(!agent) return Promise.resolve();
    return host.prompt(agent.name, {
      title: 'Rename agent', message: 'Choose a new name.', singleLine: true, maxLength: 40, inputLabel: 'Agent name', submitLabel: 'Rename'
    }).then(function(name){
      name = String(name || '').trim();
      if(!name || name === agent.name) return;
      return host.api('/api/private-agents/' + encodeURIComponent(agentId), {method:'PATCH', body:{name:name}}).then(function(res){
        if(res.status !== 200 || !res.data || !res.data.agent){ host.toast(messageFor(res, 'Could not rename the agent.')); return; }
        agent.name = res.data.agent.name;
        host.renamed(agentId, agent.name);
        render();
      });
    }).catch(function(){ host.toast('Could not rename the agent.'); });
  }

  function remove(agentId){
    var agent = agents.filter(function(item){ return item.id === agentId; })[0];
    if(!agent) return Promise.resolve();
    return host.confirm('Delete ' + agent.name + '? Its conversations are removed and its memory is moved to the Trash. Mia and your bots are not affected.', 'Delete').then(function(ok){
      if(!ok) return;
      return host.api('/api/private-agents/' + encodeURIComponent(agentId), {method:'DELETE', body:{confirm:true}}).then(function(res){
        if(res.status !== 200){ host.toast(messageFor(res, 'Could not delete the agent.')); return; }
        agents = agents.filter(function(item){ return item.id !== agentId; });
        host.removed(agentId);
        render();
      });
    }).catch(function(){ host.toast('Could not delete the agent.'); });
  }

  function init(hostApi){
    host = hostApi;
    listEl = host.container();
    if(!listEl) return;
    listEl.addEventListener('click', function(event){
      var target = event.target.closest('[data-private-agent-open],[data-private-agent-rename],[data-private-agent-delete]');
      if(!target) return;
      event.preventDefault();
      if(target.hasAttribute('data-private-agent-open')) open(target.getAttribute('data-private-agent-open'));
      else if(target.hasAttribute('data-private-agent-rename')) rename(target.getAttribute('data-private-agent-rename'));
      else remove(target.getAttribute('data-private-agent-delete'));
    });
  }
  function reset(){ agents = []; loaded = false; loading = false; render(); }

  root.miaPrivateAgents = {
    isConversation: isConversation, agentIdOf: agentIdOf, nameForConversation: nameForConversation,
    mainConversation: mainConversation, rowHtml: rowHtml,
    init: init, sync: sync, refresh: refresh, create: create, reset: reset,
    _state: function(){ return {agents: agents.slice(), loaded: loaded}; }
  };
  if(typeof module !== 'undefined' && module.exports) module.exports = root.miaPrivateAgents;
})(typeof window !== 'undefined' ? window : globalThis);
