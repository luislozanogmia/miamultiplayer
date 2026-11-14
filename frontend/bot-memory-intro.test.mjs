import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./bot-memory-intro.js');
const intro = globalThis.MiaBotMemoryIntro;

test('the card names the person\'s bots, with the real Motes, and says what is saved', () => {
  const one = intro.dialogHtml(['Scout']);
  assert.match(one, /Bots now share what they learn/);
  assert.match(one, /Scout can add what it learned working with you/);
  assert.match(one, /Only lessons about the work are saved\. Your messages and files stay with you\./);
  assert.match(one, />Add what they learned</);
  assert.match(one, />No thanks</);
  assert.match(one, /assets\/mote\/mote-static\.svg/);
  assert.match(one, /assets\/mote\/mote-research-static\.svg/);
  assert.match(intro.dialogHtml(['Scout', 'Ledger']), /Scout and Ledger can add what they learned/);
  assert.match(intro.dialogHtml(['A', 'B', 'C', 'D', 'E']), /A, B and 3 more can add what they learned/);
  assert.match(intro.dialogHtml(['<b>x</b>']), /&lt;b&gt;x&lt;\/b&gt; can add/);
});

// A tiny page: one overlay slot, and the card's buttons found by attribute.
function page(){
  const listeners = {};
  let overlay = null;
  const button = () => ({ disabled: false, addEventListener(_, fn){ this.click = fn; }, focus(){} });
  const yes = button(), no = button(), error = { textContent: '' };
  globalThis.document = {
    createElement: () => ({
      setAttribute(){}, appendChild(){}, remove(){ overlay = null; },
      querySelector: (selector) => selector.includes('"yes"') ? yes : selector.includes('"no"') ? no : error,
    }),
    body: { appendChild(node){ overlay = node; } },
    querySelector: () => null,
    addEventListener(name, fn){ listeners[name] = fn; },
    removeEventListener(name){ delete listeners[name]; },
  };
  return { yes, no, open: () => !!overlay };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('nothing is asked until the person has a bot with a company memory; yes starts those bots once', async () => {
  const dom = page();
  const calls = [], started = [];
  let state = 'ask', list = [];
  const options = {
    bots: () => list,
    start: (bots) => started.push(bots.map((item) => item.bot.name)),
    api: (url, request) => {
      calls.push((request && request.method || 'GET') + ' ' + JSON.stringify(request && request.body || null));
      if(request && request.method === 'POST') state = request.body.accept ? 'accepted' : 'declined';
      return Promise.resolve({ status: 200, data: { state } });
    },
  };
  intro.showOnce(options);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(dom.open(), false);

  list = [{ bot: { id: 'b1', name: 'Scout' }, roomId: 'c1' }];
  intro.showOnce(options);
  await tick();
  assert.equal(dom.open(), true);
  dom.yes.click();
  await tick();
  assert.deepEqual(calls, ['GET null', 'POST {"accept":true}']);
  assert.deepEqual(started, [['Scout']]);
  assert.equal(dom.open(), false);

  intro.showOnce(options);
  await tick();
  assert.equal(dom.open(), false);
  assert.equal(calls.length, 2);
});

test('the app asks each bot in its own chat, after pulling the company memory', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /showOnce\(\{api: api, bots: botsWithCompanyMemory, start: addLearnedToBotMemory\}\)/);
  assert.match(app, /pullSharedFolder\(item\.bot\); \}\)\.then\(function\(\)\{\s*return sendNativeConversationEvent\(BOT_MEMORY_INTRO_ASK, null, null, item\.roomId, \{botMemoryIntro: true\}\)/);
  assert.match(app, /Keep lessons about the work only; leave my messages, files and personal details out\./);
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="bot-memory-intro\.js\?v=/);
});
