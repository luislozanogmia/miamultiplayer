import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function loadMentionChips() {
  const esc = slice('  function esc(', '\n  }\n') + '\n  }\n';
  const block = slice('  function roomMentionPeople(', '  function chatMsgHtml(');
  return new Function(`
    var hubWorkspace = () => true;
    var hubChat = { members: [
      { email: 'ana@example.com', display_name: 'Ana Ruiz' },
      { email: 'ben@example.com', display_name: 'Ben Ortiz' },
    ] };
    var humanMentionName = (user) => user.displayName;
    var roomMentionBots = () => [{ id: 'b1', name: 'Helper', color: null }];
    var agentAvatarHtml = (name) => '<i class="mote">' + name + '</i>';
    var humanAvatarContent = (email) => '<b>' + email.charAt(0).toUpperCase() + '</b>';
    ${esc}${block}
    return withMentionChips;
  `)();
}

test('a bot tagging a person by email shows the same name chip as a person tagging them', () => {
  const withMentionChips = loadMentionChips();
  const fromPerson = withMentionChips('<p class="chat-md-p">@Ana Ruiz Yes, it is ready.</p>');
  const fromBot = withMentionChips('<p class="chat-md-p">@ana@example.com Yes, it is ready.</p>');
  assert.equal(fromBot, fromPerson);
  assert.match(fromBot, /<span class="chat-msg-mention"><span class="chat-msg-mention-face"><b>A<\/b><\/span>@Ana Ruiz<\/span> Yes/);
  assert.doesNotMatch(fromBot, /ana@example\.com/);
  // Case in the address does not matter, and a sentence can end right after it.
  assert.match(withMentionChips('<p>Thanks @BEN@example.com.</p>'), /Thanks <span class="chat-msg-mention">.*@Ben Ortiz<\/span>\.<\/p>/);
});

test('an address that is not a member, or a longer one, stays as written', () => {
  const withMentionChips = loadMentionChips();
  assert.equal(withMentionChips('<p>@cora@example.com hi</p>'), '<p>@cora@example.com hi</p>');
  assert.equal(withMentionChips('<p>@ana@example.com.mx hi</p>'), '<p>@ana@example.com.mx hi</p>');
  assert.equal(withMentionChips('<p>mail ana@example.com</p>'), '<p>mail ana@example.com</p>');
});

test('an @ inside code stays literal', () => {
  const withMentionChips = loadMentionChips();
  const inline = '<p>Run <code>@ana@example.com</code> and <code>@Helper</code></p>';
  assert.equal(withMentionChips(inline), inline);
  const block = '<pre class="chat-md-code"><code>@Ana Ruiz\n@ana@example.com</code></pre>';
  assert.equal(withMentionChips(block), block);
  assert.match(withMentionChips('<p><code>x</code> @Helper</p>'), /<code>x<\/code> <span class="chat-msg-mention"><i class="mote">Helper<\/i>@Helper<\/span>/);
});
