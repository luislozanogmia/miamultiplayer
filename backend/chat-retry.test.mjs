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
