import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  var AUTOMATION_STEP_EXAMPLES');
const end = source.indexOf('  function automationsDetailHtml(');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return '&#' + c.charCodeAt(0) + ';'; }); }
function els(sel, root){ return root.inputs; }
` + source.slice(start, end), ctx);

const rows = (html) => [...html.matchAll(/<span class="cip-automation-step-n">(\d+)<\/span><input [^>]*value="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]);

test('the automation editor numbers its steps like the Automations page, five rows to start', () => {
  const empty = ctx.automationStepRowsHtml([]);
  assert.deepEqual(rows(empty).map(([n]) => n), [1, 2, 3, 4, 5]);
  assert.match(empty, /placeholder="Search the web for today&#39;s AI news"/, 'an empty list shows example steps');
  assert.doesNotMatch(source.slice(source.indexOf('function renderAutomationDetailPane'), source.indexOf('function renderAutomationDetailPane') + 20000), /one per line/);
});

test('saved steps fill their rows in order, with one empty row after them', () => {
  const steps = ['One', 'Two', 'Three', 'Four', 'Five', 'Six <b>'];
  const filled = rows(ctx.automationStepRowsHtml(steps));
  assert.deepEqual(filled, [[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four'], [5, 'Five'], [6, 'Six &#60;b&#62;'], [7, '']]);
  assert.doesNotMatch(ctx.automationStepRowsHtml(steps), /placeholder=/, 'no examples once there are real steps');
  assert.equal(rows(ctx.automationStepRowsHtml(Array.from({ length: 20 }, (_, i) => 'Step ' + i))).length, 20, 'never more than 20 rows');
});

test('saving reads the filled rows in order and skips empty ones', () => {
  const list = { inputs: [{ value: ' Search ' }, { value: '' }, { value: 'Post' }, { value: '  ' }] };
  assert.deepEqual([...ctx.automationStepRowValues(list)], ['Search', 'Post']);
});
