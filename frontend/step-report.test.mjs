import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const report = createRequire(import.meta.url)('./step-report.js');
const esc = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const full = { did: 'Drafted <b>it</b>', how: 'From the sheet.', failed: 'Totals not checked', next: 'Check totals', decision: 'Which <i>price</i>?' };

test('it knows nothing about workflows, so automations can use it', () => {
  const text = report.closingBlock();
  assert.doesNotMatch(text, /workflow|step|teammate/i);
  for(const line of ['RESULT: done | partial | failed', 'DID: ...', 'HOW: ...', "FAILED OR UNCHECKED: Nothing, or what failed or wasn't checked", 'NEXT: ...', 'NEEDS A DECISION: only if someone has to decide something']) assert.ok(text.split('\n').includes(line), line);
});

test('what the closing block asks for is what the parser reads', () => {
  assert.equal(report.readReply('Working.\nRESULT: done\nDID: a\nHOW: b\nFAILED OR UNCHECKED: Nothing\nNEXT: c\nNEEDS A DECISION: d').kind, 'send');
  assert.equal(report.readReply('Working.\nRESULT: done\nDID: a\nHOW: b\nFAILED OR UNCHECKED: Nothing\nNEXT: c\nNEEDS A DECISION: d').report.decision, 'd');
  assert.equal(report.readReply(report.closingBlock()).kind, 'unclear');
});

test('the summary shows the result and what was done, a decision in view, and the rest behind Read report', () => {
  const html = report.summaryHtml({ outcome: 'partial', note: 'x', report: full }, esc, 'report:1');
  assert.match(html, /Partly done/);
  assert.match(html, /data-outcome="partial"/);
  assert.ok(html.indexOf('Drafted') < html.indexOf('<details'));
  assert.ok(html.indexOf('Needs a decision') < html.indexOf('<details'));
  assert.match(html, /<summary>Read report<\/summary>/);
  assert.match(html, /data-wf-keep-open="report:1"/);
  assert.ok(html.indexOf('From the sheet') > html.indexOf('<details'));
  assert.doesNotMatch(html, /<b>|<i>/);
});

test('an older step has only its note; a garbled report is not drawn', () => {
  assert.match(report.summaryHtml({ note: 'Old <note>', outcome: null, report: null }, esc), /Old &#60;note/);
  assert.doesNotMatch(report.summaryHtml({ note: 'n', report: { did: 'only' } }, esc), /Read report/);
  assert.equal(report.summaryHtml({ report: null }, esc), '');
  assert.equal(report.fullHtml({ report: null }, esc), '');
});

test('the full view hides nothing and has no toggle', () => {
  const html = report.fullHtml({ outcome: 'done', report: full }, esc);
  assert.doesNotMatch(html, /<details/);
  for(const text of ['From the sheet', 'Totals not checked', 'Check totals', 'Suggested next', 'Needs a decision']) assert.ok(html.includes(text), text);
});

test('an addition to what was done never pushes a report past the limit', () => {
  const big = { did: 'd', how: 'h'.repeat(400), failed: 'f'.repeat(395), next: 'n', decision: 'q' };
  const out = report.addToDid(big, '(1 file was not shared.)');
  assert.match(out.did, /not shared/);
  assert.ok(Array.from(Object.values(out).join('')).length <= report.LIMIT);
  assert.equal(report.addToDid(big, ''), big);
});

test('an older Hub gets its own shape: no report, and partial as done with a note that says so', () => {
  assert.deepEqual(report.hubBody('c', 'done', 'n', full, []), { claimId: 'c', outcome: 'done', note: 'n', report: full });
  assert.deepEqual(report.olderHubBody('c', 'partial', 'Half', ['f']), { claimId: 'c', outcome: 'done', note: 'Half (Partly done.)', fileIds: ['f'] });
  assert.deepEqual(report.olderHubBody('c', 'failed', 'No', []), { claimId: 'c', outcome: 'failed', note: 'No' });
  assert.equal(Array.from(report.olderHubBody('c', 'partial', 'x'.repeat(200), []).note).length, 200);
});
