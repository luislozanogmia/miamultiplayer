import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createMesh } = require('./shared-space-live.js');

// A loopback stand-in: offers and answers pass through `signal`, and once both
// descriptions are set the two ends' data channels open.
function fakeRTC() {
  const made = [];
  class FakePeer {
    constructor() { this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.connectionState = 'new'; made.push(this); }
    addEventListener() {}
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', bufferedAmount: 0, sent: [], send(text) { this.sent.push(text); this.peer?.onmessage?.({ data: text }); } };
      if (label === 'mia-space-talk') this.talk = channel; else this.channel = channel;
      return channel;
    }
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription(desc) { this.localDescription = desc; if (desc.type === 'offer') this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(desc) { this.remoteDescription = desc; if (desc.type === 'answer') this.signalingState = 'stable'; }
    close() { this.connectionState = 'closed'; }
  }
  return { RTC: FakePeer, made };
}
function connect(aId, bId) {
  const fake = fakeRTC(), inbox = { a: [], b: [] }, sent = [];
  const a = createMesh({ selfId: aId, RTC: fake.RTC, gatherMs: 0, signal: (to, msg) => { sent.push(['a', to, msg]); b.signal(aId, msg); }, onMessage: (from, msg) => inbox.a.push([from, msg]) });
  const b = createMesh({ selfId: bId, RTC: fake.RTC, gatherMs: 0, signal: (to, msg) => { sent.push(['b', to, msg]); a.signal(bId, msg); }, onMessage: (from, msg) => inbox.b.push([from, msg]) });
  return { fake, a, b, inbox, sent };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('only the lower id calls, so two computers never call each other at once', async () => {
  const { a, b, sent, fake } = connect('u1', 'u2');
  b.sync(['u1']);
  await settle();
  assert.equal(sent.length, 0);
  a.sync(['u2']);
  await settle();
  assert.deepEqual(sent.map(([who, , msg]) => [who, msg.kind]), [['a', 'offer'], ['b', 'answer']]);
  assert.equal(fake.made.length, 2);
  a.close(); b.close();
});

test('frames reach an open connection and are skipped on a slow one', async () => {
  const { a, b, inbox, fake } = connect('u1', 'u2');
  a.sync(['u2']);
  await settle();
  const [caller, callee] = fake.made;
  const receiving = { readyState: 'open', bufferedAmount: 0, send() {} };
  callee.ondatachannel({ channel: receiving });
  caller.channel.readyState = 'open';
  caller.channel.peer = receiving;
  assert.equal(a.openCount(), 1);
  a.send({ t: 'f', tab: 'k1', url: 'x' });
  assert.deepEqual(inbox.b, [['u1', { t: 'f', tab: 'k1', url: 'x' }]]);
  caller.channel.bufferedAmount = 10 * 1024 * 1024;
  a.send({ t: 'f', tab: 'k1', url: 'y' });
  assert.equal(inbox.b.length, 1);
  a.close(); b.close();
});

test('a stale answer is ignored and someone who left is dropped', async () => {
  const { a, b, fake } = connect('u1', 'u2');
  a.sync(['u2']);
  await settle();
  const caller = fake.made[0];
  await a.signal('u2', { kind: 'answer', sid: 'someone-else', sdp: 'x' });
  assert.equal(caller.remoteDescription.sdp, 'answer-sdp');
  a.sync([]);
  assert.equal(caller.connectionState, 'closed');
  a.close(); b.close();
});

test('transcript lines use their own kept channel and a late joiner is told when it opens', async () => {
  const fake = fakeRTC(), inbox = [], opened = [];
  const b = createMesh({ selfId: 'u2', RTC: fake.RTC, gatherMs: 0, signal: (to, msg) => a.signal('u2', msg), onMessage: (from, msg) => inbox.push([from, msg]), onOpen: (id) => opened.push(id) });
  const a = createMesh({ selfId: 'u1', RTC: fake.RTC, gatherMs: 0, signal: (to, msg) => b.signal('u1', msg), onMessage() {}, onOpen: (id) => opened.push(id) });
  a.sync(['u2']);
  await settle();
  const [caller, callee] = fake.made;
  const receiving = { label: 'mia-space-talk', readyState: 'open', send() {} };
  callee.ondatachannel({ channel: receiving });
  a.sendKept({ t: 's', id: 'l1', text: 'not open yet' });
  assert.deepEqual(caller.talk.sent, []);
  caller.talk.readyState = 'open';
  caller.talk.peer = receiving;
  caller.talk.onopen();
  receiving.onopen();
  assert.deepEqual(opened, ['u2', 'u1']);
  // A full frame queue never holds a line back.
  caller.channel.readyState = 'open';
  caller.channel.bufferedAmount = 10 * 1024 * 1024;
  a.sendKept({ t: 's', id: 'l1', text: 'hello' });
  a.sendKept({ t: 's', id: 'l2', text: 'only for someone else' }, 'u9');
  a.sendKept({ t: 's', id: 'l3', text: 'just you' }, 'u2');
  assert.deepEqual(inbox, [['u1', { t: 's', id: 'l1', text: 'hello' }], ['u1', { t: 's', id: 'l3', text: 'just you' }]]);
  assert.deepEqual(caller.channel.sent, []);
  a.close(); b.close();
});
