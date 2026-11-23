import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./automation-app-review.js');
const review = globalThis.MiaAutomationAppReview;

test('an upgrade review opens Mia, while Later leaves app approval pending', async () => {
  let overlay = null;
  const buttons = {
    mia: { addEventListener(_event, handler) { this.click = handler; }, focus() {} },
    later: { addEventListener(_event, handler) { this.click = handler; } },
  };
  globalThis.document = {
    createElement() { return {
      setAttribute() {}, appendChild() {}, remove() { overlay = null; },
      querySelector(selector) { return selector.includes('later') ? buttons.later : buttons.mia; },
    }; },
    body: { appendChild(node) { overlay = node; } },
    querySelector() { return overlay; },
    addEventListener() {}, removeEventListener() {},
  };
  const requests = [], opened = [];
  review.showOnce({
    api: (url) => { requests.push(url); return Promise.resolve({ status: 200, data: { state: 'review', count: 2 } }); },
    reviewWithMia: (count) => opened.push(count),
  });
  await new Promise(setImmediate);
  assert.deepEqual(requests, ['/api/automation-app-review']);
  assert.ok(overlay);
  buttons.mia.click();
  assert.deepEqual(opened, [2]);
  assert.equal(overlay, null);
  review.showOnce({ workspaceKey: 'company-a', api: (url) => {
    requests.push(url); return Promise.resolve({ status: 200, data: { state: 'review', count: 1 } });
  }, reviewWithMia: (count) => opened.push(count) });
  await new Promise(setImmediate);
  assert.ok(overlay, 'a second workspace receives its own upgrade review');
  buttons.later.click();
  assert.deepEqual(opened, [2], 'Later does not grant access or open Mia');
});
