import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {miaCodeLine,withoutHome,appResourcesFolder,MIA_REPO_URL}=require('./mia-code-reference');

test('bots are told where Mia’s code is: the installed app’s resources, its version and the public repo',()=>{
  const line=miaCodeLine({MIAOS_APP_RESOURCES:'/Applications/Mia.app/Contents/Resources',MIAOS_APP_VERSION:'0.3.7'});
  assert.match(line,/\/Applications\/Mia\.app\/Contents\/Resources/);
  assert.match(line,/version 0\.3\.7/);
  assert.match(line,/at tag v0\.3\.7/);
  assert.ok(line.includes(MIA_REPO_URL));
  assert.match(line,/read-only references/);
});

test('the home folder is written as ~, so no user name reaches a prompt',()=>{
  const home=homedir();
  assert.equal(withoutHome(join(home,'AppData','Local','Programs','Mia','resources'),home),'~/AppData/Local/Programs/Mia/resources');
  assert.equal(withoutHome('/opt/mia/resources',home),'/opt/mia/resources');
  assert.ok(!appResourcesFolder({MIAOS_APP_RESOURCES:join(home,'Applications','Mia.app','Contents','Resources')}).includes(home));
  assert.doesNotMatch(miaCodeLine({MIAOS_APP_VERSION:'not a version'}),/not a version/);
});

test('Solo turns, team turns and automations carry the same Mia code line',()=>{
  process.env.MIAOS_APP_RESOURCES='/Applications/Mia.app/Contents/Resources';
  process.env.MIAOS_APP_VERSION='0.3.7';
  const {buildBotContext,buildScheduledBotPrompt}=require('./inference');
  const line=miaCodeLine();
  const bot={id:'b1',name:'Helper',instructions:'Find display bugs.'};
  const solo=buildBotContext(bot,[],'why are the dashes gone?','Today is Tuesday.','owner@example.test',{});
  const team=buildBotContext({...bot,id:'shared-r1-v1',filesFolder:'/data/team'},[],'why are the dashes gone?',
    'Today is Tuesday.\n\nThis is a shared company channel. Distinguish each speaker.','owner@example.test',{});
  const automation=buildScheduledBotPrompt(bot,{id:'a1',name:'Check',prompt:'Check the chat renderer.',schedule:{kind:'daily',time:'09:00'}},{});
  for(const prompt of [solo,team,automation]) {
    assert.ok(prompt.includes(line),'the same line, from one place');
    assert.ok(prompt.includes('/Applications/Mia.app/Contents/Resources') && prompt.includes('0.3.7') && prompt.includes(MIA_REPO_URL));
  }
});
