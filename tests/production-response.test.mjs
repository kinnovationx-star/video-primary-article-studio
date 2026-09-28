import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeneratedJson, generatedText, settleProductionBatch } from '../lib/production-response.ts';

test('preserves HTML and variant characters in fenced JSON', () => {
  const article = { title: '青﨑曹', html: '<p class="quote">文章</p>', sections: ['a', 'b'] };
  assert.deepEqual(parseGeneratedJson(`\n\`\`\`json\n${JSON.stringify(article)}\n\`\`\``), article);
});
test('malformed arrays produce a helpful error without raw parser output', () => {
  assert.throws(() => parseGeneratedJson('{"sections":["a" "b"]}'), /入力内容を保持/);
  assert.throws(() => parseGeneratedJson(''), /不完全/);
});
test('rejects truncated and refused responses even when JSON appears valid', () => {
  for (const stop_reason of ['max_tokens', 'refusal']) {
    assert.throws(() => generatedText({stop_reason, content: [{type: 'text', text: '{}'}]}));
  }
  assert.throws(() => generatedText({content: []}), /受信できません/);
  assert.equal(generatedText({stop_reason: 'end_turn', content: [{type:'text',text:'{}'}]}), '{}');
});
test('batch failure is reported only after sibling operations settle', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let finished = false;
  const failure = new Error('first failed');
  const batch = settleProductionBatch([Promise.reject(failure), pending]).catch(error => {
    finished = true;
    assert.equal(error, failure);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release('saved');
  await batch;
  assert.equal(finished, true);
  assert.deepEqual(await settleProductionBatch([Promise.resolve('one'),Promise.resolve('two')]), ['one','two']);
});
