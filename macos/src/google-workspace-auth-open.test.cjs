const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

test('Google system-browser IPC rejects untrusted senders and unsafe authorization URLs', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf('ipcMain.handle("miaos-google-workspace-auth-open"');
  const end = source.indexOf('\nipcMain.handle("miaos-artifact-open"', start);
  let handler;
  const opened = [];
  const googleAuthOpenSecret = 'fixture-process-secret';
  vm.runInNewContext(source.slice(start, end), {
    URL, Set, Buffer, crypto, googleAuthOpenSecret, ipcMain: { handle: (_name, fn) => { handler = fn; } },
    isMainWindowSender: event => event.trusted,
    shell: { openExternal: async url => opened.push(url) },
  });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({redirect_uri: 'http://127.0.0.1:54321/callback', response_type:'code',
    state:'s'.repeat(43), code_challenge:'c'.repeat(43), code_challenge_method:'S256'});
  const request = url => ({ url, proof: crypto.createHmac('sha256', googleAuthOpenSecret).update(url).digest('base64url') });
  assert.equal((await handler({trusted:false}, request(auth.href))).ok, false);
  assert.equal((await handler({trusted:true}, request(auth.href))).ok, true);
  assert.equal((await handler({trusted:true}, { url: auth.href, proof: 'x'.repeat(43) })).ok, false);
  for (const [key, value] of [['redirect_uri','https://evil.example/callback'], ['redirect_uri','http://user@127.0.0.1:54321/callback'],
    ['code_challenge_method','plain'], ['state','short'], ['response_type','token']]) {
    const bad = new URL(auth); bad.searchParams.set(key,value);
    assert.equal((await handler({trusted:true}, request(bad.href))).ok, false);
  }
  for (const value of ['file:///etc/passwd', auth.href.replace('accounts.google.com','accounts.google.com.evil.test'), auth.href + '&state=duplicate', auth.href + '#fragment']) {
    assert.equal((await handler({trusted:true}, request(value))).ok, false);
  }
  assert.equal(opened.length,1);
});
