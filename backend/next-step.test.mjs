import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nextStepInstruction, splitNextStep } = require('./next-step');

test('instruction asks for one closing Next: line', () => {
  assert.match(nextStepInstruction(), /"Next:"/);
});

test('takes the closing Next: line off the reply', () => {
  assert.deepEqual(splitNextStep('Python 3.15.1 is out.\n\nNext: Compare it with 3.14.\n'), {
    text: 'Python 3.15.1 is out.',
    nextStep: 'Compare it with 3.14',
  });
  assert.deepEqual(splitNextStep('Done.\n**Next:** "Summarize the HN thread"'), {
    text: 'Done.',
    nextStep: 'Summarize the HN thread',
  });
  assert.deepEqual(splitNextStep('Done.\nNext step: Track the price'), { text: 'Done.', nextStep: 'Track the price' });
  assert.deepEqual(splitNextStep('Listo.\n\n[Mia] Next: Imprime las tarjetas y recórtalas por la línea'), {
    text: 'Listo.',
    nextStep: 'Imprime las tarjetas y recórtalas por la línea',
  });
  assert.deepEqual(splitNextStep('Done.\nNext: Track the price [Weather]'), { text: 'Done.', nextStep: 'Track the price' });
});

test('leaves replies without a closing Next: line alone', () => {
  assert.deepEqual(splitNextStep('Next: is mentioned first.\nThen more text'), {
    text: 'Next: is mentioned first.\nThen more text',
    nextStep: null,
  });
  assert.deepEqual(splitNextStep('Next: only a line'), { text: 'Next: only a line', nextStep: null });
  assert.deepEqual(splitNextStep(''), { text: '', nextStep: null });
});

test('drops an over-long suggestion but still hides the line', () => {
  const result = splitNextStep('Answer.\nNext: ' + 'x'.repeat(120));
  assert.deepEqual(result, { text: 'Answer.', nextStep: null });
});
