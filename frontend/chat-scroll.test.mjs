import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const scroll = require('./chat-scroll.js');
const appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

class FakeTimeline {
  constructor(layout, clientHeight = 100) {
    this.clientHeight = clientHeight;
    this.scrollTop = 0;
    this.layout = layout;
    this.nextLayout = layout;
    this.attributes = {};
    this.refreshHeight();
  }
  refreshHeight() { this.scrollHeight = this.layout.reduce((sum, row) => sum + row.height, 0); }
  get innerHTML() { return this.markup || ''; }
  set innerHTML(value) { this.markup = value; this.layout = this.nextLayout; this.refreshHeight(); }
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight }; }
  querySelectorAll() {
    let top = -this.scrollTop;
    return this.layout.map((entry) => {
      const rowTop = top;
      top += entry.height;
      return {
        getAttribute(name) { return name === 'data-event-id' ? entry.id : null; },
        getBoundingClientRect() { return { top: rowTop, bottom: rowTop + entry.height }; },
      };
    });
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
}

function layout(heights) {
  return heights.map((height, index) => ({ id: `m${index + 1}`, height }));
}

function withAnimationFrameQueue(run) {
  const callbacks = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callbacks.push(callback); };
  try { run(callbacks); }
  finally {
    if(original) globalThis.requestAnimationFrame = original;
    else delete globalThis.requestAnimationFrame;
  }
}

test('concise incoming message preserves the visible anchor while scrolled up', () => {
  const view = new FakeTimeline(layout([100, 100, 100]));
  const state = { followLatest: true };
  view.scrollTop = 100;
  scroll.capture(view, state);
  assert.equal(state.followLatest, false);
  assert.deepEqual(state.chatScrollAnchor, { id: 'm2', offset: 0 });
  view.nextLayout = layout([100, 100, 100, 100]);
  scroll.replace(view, '<div data-event-id="m4">incoming</div>', state);
  assert.equal(view.scrollTop, 100);
  assert.equal(scroll.visibleAnchor(view).id, 'm2');
});

test('verbose rerender anchors the same message when earlier content changes height', () => {
  const view = new FakeTimeline(layout([100, 160, 100]));
  const state = { followLatest: true };
  view.scrollTop = 100;
  scroll.capture(view, state);
  view.nextLayout = layout([260, 160, 100, 220]);
  scroll.replace(view, '<div data-event-id="m4">verbose stream</div>', state);
  assert.equal(view.scrollTop, 260);
  assert.deepEqual(scroll.visibleAnchor(view), { id: 'm2', offset: 0 });
});

test('followers stay at the latest message and the jump control resumes following', () => {
  const view = new FakeTimeline(layout([100, 100, 100]));
  const state = { followLatest: true };
  view.scrollTop = 200;
  scroll.capture(view, state);
  view.nextLayout = layout([100, 100, 100, 100]);
  scroll.replace(view, '<div data-event-id="m4">stream</div>', state);
  assert.equal(view.scrollTop, view.scrollHeight);

  view.scrollTop = 100;
  scroll.capture(view, state);
  const attrs = {};
  const button = { hidden: true, setAttribute(name, value) { attrs[name] = value; } };
  scroll.syncButton(button, view, state);
  assert.equal(button.hidden, false);
  scroll.jumpToLatest(view, state);
  scroll.syncButton(button, view, state);
  assert.equal(state.followLatest, true);
  assert.equal(button.hidden, true);
  assert.equal(attrs['aria-hidden'], 'true');
});

test('room switches restore independent anchors instead of sharing one scroll position', () => {
  const view = new FakeTimeline(layout([80, 80, 80, 80]));
  const roomA = { followLatest: true };
  const roomB = { followLatest: true };
  view.scrollTop = 80;
  scroll.capture(view, roomA);
  view.nextLayout = layout([120, 120, 120]);
  scroll.replace(view, 'room-b', roomB);
  assert.equal(view.scrollTop, view.scrollHeight);
  view.nextLayout = layout([80, 80, 80, 80, 80]);
  scroll.replace(view, 'room-a', roomA);
  assert.equal(scroll.visibleAnchor(view).id, 'm2');
});

test('a queued restore from the previous room cannot move the replacement room', () => {
  withAnimationFrameQueue((callbacks) => {
    const view = new FakeTimeline(layout([100, 100, 100]));
    const roomA = { followLatest: false, chatScrollTop: 100, chatScrollAnchor: { id: 'm2', offset: 0 } };
    const roomB = { followLatest: true };
    view.nextLayout = layout([200, 100, 100]);
    scroll.replace(view, 'room-a', roomA);
    view.nextLayout = layout([80, 80, 80, 80]);
    scroll.replace(view, 'room-b', roomB);
    const roomBTop = view.scrollTop;
    callbacks[0]();
    assert.equal(view.scrollTop, roomBTop);
    callbacks[1]();
    assert.equal(view.scrollTop, view.scrollHeight);
  });
});

test('a user scroll invalidates the queued post-layout restore', () => {
  withAnimationFrameQueue((callbacks) => {
    const view = new FakeTimeline(layout([100, 100, 100]));
    const state = { followLatest: false, chatScrollTop: 100, chatScrollAnchor: { id: 'm2', offset: 0 } };
    view.nextLayout = layout([220, 100, 100, 100]);
    scroll.replace(view, 'streaming', state);
    view.scrollTop = 40;
    scroll.capture(view, state, { invalidatePending: true });
    callbacks[0]();
    assert.equal(view.scrollTop, 40);
    assert.equal(state.followLatest, false);
  });
});

test('production chat render path delegates replacement and has no unconditional delayed bottom jump', () => {
  assert.match(html, /id="chatJumpLatest"[^>]+aria-label="Jump to latest message"/);
  assert.match(html, /chat-scroll\.js[^>]*>[\s\S]*native-browser\.js[\s\S]*app\.js/);
  assert.match(appSource, /function replaceChatTimeline\([\s\S]*MiaChatScroll\.replace\(thread, html, state/);
  assert.match(appSource, /MiaChatScroll\.capture\(thread, state, \{invalidatePending:movedSinceRestore\}\)/);
  assert.match(appSource, /replaceChatTimeline\(thread, roomId, state, historyControl \+ dateDivider \+ html, options\)/);
  assert.doesNotMatch(appSource, /setTimeout\(function\(\)\{ var t = el\('#chatThread'\); if\(t\) t\.scrollTop = t\.scrollHeight/);
  assert.doesNotMatch(appSource.slice(appSource.indexOf('function renderChatThread(options)'), appSource.indexOf('function chatThreadFooterHtml')), /thread\.scrollTop = thread\.scrollHeight/);
});
