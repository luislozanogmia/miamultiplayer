const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const rule=selector=>{const m=css.match(new RegExp('\\n  '+selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}'));assert.ok(m,selector);return m[1];};
// Section headers and rows share one grid, so a + never floats mid-line.
test('section actions end on the right edge in every header',()=>{
  assert.match(rule('.chat-recents-head > .chat-section-icon-btn,.chat-recents-head > .chat-dm-add-btn'),/margin-left:auto/);
  const all=html.slice(html.indexOf('id="chatAllCount"'),html.indexOf('id="chatDmAddPopover"'));
  assert.match(all,/class="chat-dm-add-btn"/,'All conversations keeps its + in the header');
  assert.doesNotMatch(css,/body\.styled-skin \.chat-recents-count\{display:none/);
  assert.ok(!html.includes('id="chatPinnedCount"'),'Pinned has no count');
});
test('section titles are row-sized and the chevron shows on hover or when folded',()=>{
  const row=Number(rule('body.styled-skin .chat-recent-row .row-label').match(/font-size:(\d+)px/)[1]);
  assert.equal(Number(rule('body.styled-skin .chat-recents-title').match(/font-size:(\d+)px/)[1]),row);
  assert.match(rule('.chat-recents-head > .chat-section-toggle'),/opacity:0/);
  assert.ok(css.includes('.chat-recents-head:hover > .chat-section-toggle,.chat-recents-head > .chat-section-toggle:focus-visible,.chat-recents-head > .chat-section-toggle[aria-expanded="false"]{opacity:1;}'));
  const avatar=Number(rule('body.styled-skin .chat-row-mark.tile').match(/width:(\d+)px/)[1]);
  assert.equal(Number(rule('.sidebar-upcoming-mark').match(/width:(\d+)px/)[1]),avatar);
  assert.match(html,/class="sidebar-upcoming-row"[^>]*><span class="sidebar-upcoming-mark"[\s\S]*?<span class="row-label">New agent<\/span><span class="row-preview">Coming soon<\/span>/);
});
