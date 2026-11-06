import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const stylesSource = fs.readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');

function frontendFunction(name) {
  const marker = `  function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in frontend/app.js`);
  const bodyStart = appSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === '{') depth += 1;
    if (appSource[index] === '}') depth -= 1;
    if (depth === 0) return vm.runInNewContext(`(${appSource.slice(start + 2, index + 1)})`);
  }
  throw new Error(`Could not extract ${name}`);
}

test('retryable agent failures are distinguished from reconnect failures', () => {
  const retryable = frontendFunction('chatRetryableFailure');
  assert.equal(retryable("I couldn't safely apply the spreadsheet update. Please try again."), true);
  assert.equal(retryable("I couldn't safely apply the spreadsheet layout. Please try again."), true);
  assert.equal(retryable("Google didn't respond in time, so I didn't change the spreadsheet. Please try again."), true);
  assert.equal(retryable("I couldn't apply the spreadsheet update. Please confirm access and try again."), true);
  assert.equal(retryable('I ran out of time before finishing. Nothing was changed. Please try again.'), true);
  assert.equal(retryable('I stopped at step 7 (running a command): it made no progress for 10 minutes. What came before it is done. Ask again to retry from there.'), true);
  assert.equal(retryable("Sorry — I ran into a problem working on that and couldn't finish. Feel free to try again."), true);
  assert.equal(retryable("I couldn't update the spreadsheet because Google needs to be reconnected in Plugins."), false);
  assert.equal(retryable('The spreadsheet update is complete.'), false);
});

test('retry action reuses the same native conversation thread and prevents duplicate clicks', () => {
  assert.match(appSource, /sendActiveRoomMessage\('Try that again\.', threadRootId, null, roomId\)/);
  assert.match(appSource, /if\(!roomId \|\| !threadRootId \|\| !eventId \|\| chatRetryAttempts\[eventId\]\) return;/);
  assert.match(appSource, /opts\.inThread && !isHuman && !m\.pending && chatRetryableFailure\(text\)/);
  assert.match(stylesSource, /\.chat-msg-retry\{/);
});

test('a turn that reaches its output budget ends with a Continue card, not a dead end', async () => {
  const { OUTPUT_LIMIT_NOTICE } = await import('./native-dispatch-runtime.js');
  const notice = frontendFunction('chatOutputLimitNotice');
  assert.equal(notice(OUTPUT_LIMIT_NOTICE), true, 'the app recognizes the notice the server sends');
  assert.equal(notice('⏹ Stopped: this response reached its output budget before finishing. Nothing else was changed.'), true, 'and older notices already in chats');
  assert.equal(notice('I reached the store.'), false);
  const buttonFn = appSource.slice(appSource.indexOf('function chatContinueButtonHtml('), appSource.indexOf('\n  }\n', appSource.indexOf('function chatContinueButtonHtml(')) + 4);
  const card = vm.runInNewContext(`var chatContinued = {}; var chatContinueAnswered = () => false; var esc = s => String(s); ${buttonFn}; (${appSource.slice(appSource.indexOf('function chatContinueHtml('), appSource.indexOf('\n  }\n', appSource.indexOf('function chatContinueHtml(')) + 4)})`);
  const html = card('ev1', OUTPUT_LIMIT_NOTICE);
  assert.match(html, /class="chat-approval"/, 'same card as an ask-before-do approval');
  assert.match(html, /data-chat-continue="ev1">Continue</);
  assert.doesNotMatch(html, /Press Continue/, 'the button speaks for itself');
  assert.match(appSource, /sendActiveRoomMessage\(chatContinueMessage\(state\.messages, eventId\), threadRootId, null, roomId\)/);
  const source = appSource.slice(appSource.indexOf('function chatContinueMessage('), appSource.indexOf('\n  }\n', appSource.indexOf('function chatContinueMessage(')) + 4);
  const message = vm.runInNewContext(`var isHumanSender = s => s === 'me'; var displayBotBody = b => b; var isSupersededNativeProgressMessage = m => !!m.progress;
    ${notice.toString().replace(/^function [^(]*/, 'function chatOutputLimitNotice')}; (${source})`);
  assert.equal(message([], 'x'), 'Continue where you left off.');
  const msgs = [
    { id: 'a', sender: 'me', body: 'Write a story' },
    { id: 'b', sender: 'bot', body: 'The keeper climbed  the stairs' },
    { id: 'p', sender: 'bot', body: 'Working', progress: true },
    { id: 'c', sender: 'bot', body: OUTPUT_LIMIT_NOTICE },
  ];
  assert.equal(message(msgs, 'c'), 'Continue where you left off. Your last reply ended with: "…The keeper climbed the stairs"', 'quotes how the cut-off reply ended');
  assert.equal(message(msgs.filter(m => m.id !== 'b'), 'c'), 'Continue where you left off.', 'nothing to quote when no text was written');
  assert.match(appSource, /else if\(!isHuman && !m\.pending && chatOutputLimitNotice\(text\)\) messageHtml = chatContinueHtml\(m\.id, text\);/);
});
