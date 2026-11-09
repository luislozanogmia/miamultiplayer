(function(root){
  'use strict';
  function node(tag,text,parent){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n;}
  // Skills and their executable files are part of the exact version an administrator approves.
  function showSkills(skills,parent){(skills||[]).forEach(function(skill){var item=node('details',undefined,parent);node('summary','Skill: '+skill.name,item);if(skill.description)node('p',skill.description,item);node('pre',skill.body,item).style.whiteSpace='pre-wrap';
    (skill.files||[]).forEach(function(file){var entry=node('details',undefined,item);node('summary','File: '+file.path,entry);node('pre',file.body,entry).style.whiteSpace='pre-wrap';});});}
  async function open(scope){
    var old=document.querySelector('#hubBotManager');if(old)old.remove();
    var dialog=node('dialog');dialog.id='hubBotManager';dialog.className='hub-bot-dialog';
    document.body.append(dialog);node('h2','Shared bot versions and local runs',dialog);
    node('p','Runs use this account’s subscriptions and tools on this computer. Files and thinking traces are not stored in the shared space.',dialog);
    var status=node('p','',dialog),content=node('div',undefined,dialog);
    var base='/v1/teams/'+scope.teamId+'/channels/'+scope.channelId;
    function button(parent,label,action){var b=node('button',label,parent);b.type='button';b.className='btn small';b.onclick=async function(){b.disabled=true;try{await action();status.textContent='Saved.';await render();await scope.refresh();}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};return b;}
    button(dialog,'Close',async function(){dialog.close();dialog.remove();});
    async function render(){
      if(!dialog.isConnected)return;
      var api=root.MiaHubChat;
      var results=await Promise.all([api.call('GET',base+'/bots'),api.localCall('POST','/poll',scope),api.call('GET','/v1/teams/'+scope.teamId+'/members')]);
      content.replaceChildren();node('h3','Waiting for your approval',content);
      var jobs=results[1].pending||[];
      if(!jobs.length)node('p','No runs waiting. Refresh after mentioning an approved shared bot.',content);
      jobs.forEach(function(job){var row=node('section',undefined,content);var bot=results[0].bots.find(function(b){return b.id===job.bot_id;});
        node('p',(bot?bot.name:'Shared bot')+' · version '+job.definition_version,row);
        button(row,'Run on this computer',function(){return api.localCall('POST','/run',Object.assign({},scope,{jobId:job.id}));});
        var select=node('select',undefined,row);select.setAttribute('aria-label','Handoff participant');
        results[2].members.forEach(function(member){var o=node('option',member.email,select);o.value=member.clerk_user_id;});
        button(row,'Hand off for approval',function(){return api.call('POST',base+'/bot-dispatches/'+job.id+'/handoff',{participantId:select.value});});
      });
      node('h3','Shared definitions',content);
      for(var bot of results[0].bots){
        await definitionCard(bot,api);
      }
    }
    async function definitionCard(bot,api){
      var path=base+'/bots/'+bot.id,details=await api.call('GET',path+'/definition');
      var card=node('section',undefined,content);card.className='hub-bot-dialog-card';
      node('h3',bot.name,card);node('p',(details.mode||'No definition')+' · '+(details.definition?'published version '+details.definition.version:'administrator approval required'),card);
      if(details.canEdit){
        var textarea=node('textarea',undefined,card);textarea.setAttribute('aria-label',bot.name+' shared instructions');textarea.value=details.definition?details.definition.instructions:'';textarea.maxLength=100000;
        button(card,'Propose edited version',function(){var skills=details.definition&&details.definition.skills||[];return api.call('POST',path+'/versions',Object.assign({instructions:textarea.value,source:'manual'},skills.length?{skills:skills}:{}));});
        if(details.mode==='linked' && details.isOwner)button(card,'Propose latest solo instructions',function(){return api.localCall('POST','/sync',Object.assign({},scope,{botId:bot.id}));});
      }
      if(details.canEdit || details.isAdmin){
        var versions=await api.call('GET',path+'/versions');
        versions.versions.forEach(function(v){var item=node('details',undefined,card);node('summary','Version '+v.version+(v.approved_by?' · approved':v.rejected_by?' · rejected':' · awaiting approval'),item);node('pre',v.instructions,item).style.whiteSpace='pre-wrap';showSkills(v.skills,item);
          if(details.isAdmin && !v.rejected_by && (!details.definition || details.definition.version!==v.version))button(card,'Approve version '+v.version,function(){return api.call('POST',path+'/versions/'+v.version+'/approve',{});});
        });
      }
      if(details.isOwner){var editors=await api.call('GET',path+'/editors');var members=await api.call('GET','/v1/teams/'+scope.teamId+'/members');
        var select=node('select',undefined,card);select.setAttribute('aria-label',bot.name+' editor');members.members.forEach(function(m){var o=node('option',m.email,select);o.value=m.clerk_user_id;});
        button(card,'Delegate editing',function(){return api.call('POST',path+'/editors',{subject:select.value});});
        editors.editors.forEach(function(e){button(card,'Remove editor '+e.subject,function(){return api.call('DELETE',path+'/editors/'+encodeURIComponent(e.subject),{});});});
      }
    }
    button(dialog,'Refresh',async function(){});dialog.showModal();try{await render();}catch(e){status.textContent=e.message;}
  }
  function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function admissionHtml(request,requester){
    var title=escapeHtml(requester||request.requester_email)+' wants to bring '+escapeHtml(request.name)+'.';
    var status=request.status==='accepted'?'Accepted':request.status==='rejected'?'Rejected':'Waiting for admin approval';
    var controls='';
    if(request.canDecide && request.status==='pending' && request.version){
      controls=['Accept','Reject','Review'].map(function(label){return '<button type="button" data-hub-admission-action="'+label.toLowerCase()+'" data-bot-id="'+escapeHtml(request.id)+'" data-version="'+Number(request.version)+'" style="margin:4px;padding:5px 10px">'+label+'</button>';}).join('');
    }
    return '<div class="chat-msg-system" style="flex-direction:column;align-items:center"><p>'+title+'</p><span>'+status+'</span><div>'+controls+'</div><span role="status" data-admission-feedback></span></div>';
  }
  async function decide(scope,botId,version,action,button){
    if(!/^[a-f0-9]{32}$/.test(botId) || !Number.isSafeInteger(version) || version<1)return;
    var api=root.MiaHubChat,base='/v1/teams/'+scope.teamId+'/channels/'+scope.channelId+'/bots/'+botId;
    var notice=button && button.closest('.chat-msg-system'),feedback=notice && notice.querySelector('[data-admission-feedback]');
    if(button)button.disabled=true;
    try{
      if(action==='review'){
        var result=await api.call('GET',base+'/versions');
        var proposal=result.versions.find(function(v){return v.version===version;});
        if(!proposal)throw new Error('This proposal is no longer available. Refresh the chat.');
        var definition=await api.call('GET',base+'/definition');
        var dialog=node('dialog');dialog.className='hub-bot-dialog';document.body.append(dialog);
        node('h2',definition.bot.name,dialog);node('p','Version '+version+' · '+definition.mode,dialog);
        node('pre',proposal.instructions,dialog).style.whiteSpace='pre-wrap';showSkills(proposal.skills,dialog);
        ['Accept','Reject','Close'].forEach(function(label){var control=node('button',label,dialog);control.type='button';control.className='btn small';control.onclick=async function(){
          if(label==='Close'){dialog.close();dialog.remove();return;}
          control.disabled=true;
          try{await api.call('POST',base+'/versions/'+version+'/'+(label==='Accept'?'approve':'reject'),{});await scope.refresh();dialog.close();dialog.remove();}
          catch(error){node('p',error.message,dialog);control.disabled=false;}
        };});dialog.showModal();
      }else if(action==='accept' || action==='reject'){
        await api.call('POST',base+'/versions/'+version+'/'+(action==='accept'?'approve':'reject'),{});
        await scope.refresh();
      }
    }catch(error){if(feedback)feedback.textContent=error.message;else if(scope.report)scope.report(error.message);}
    finally{if(button)button.disabled=false;}
  }
  root.MiaHubBots={open:open,admissionHtml:admissionHtml,decide:decide};
})(window);
