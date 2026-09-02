import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readState, compare, fetchModels } from '../tools/release-watch.mjs';

test('readState: JSON, legacy plain version, empty', () => {
  assert.deepEqual(readState('{"harness":"2.1.1","models":["a"]}'), { harness: '2.1.1', models: ['a'] });
  assert.deepEqual(readState('2.1.1\n'), { harness: '2.1.1', models: null });
  assert.deepEqual(readState(''), { harness: null, models: null });
});

test('compare: harness only, model only, both, none, first snapshot, pin retired', () => {
  const prev = { harness: '2.1.1', models: ['claude-sonnet-5', 'claude-haiku-4-5'] };
  assert.equal(compare(prev, { harness: '2.1.2', models: prev.models }).reason, 'harness');
  const m = compare(prev, { harness: '2.1.1', models: ['claude-sonnet-5', 'claude-sonnet-5-1', 'claude-haiku-4-5'] }, 'claude-sonnet-5');
  assert.equal(m.reason, 'model'); assert.deepEqual(m.newModels, ['claude-sonnet-5-1']); assert.equal(m.pinRetired, false);
  const both = compare(prev, { harness: '2.1.2', models: ['claude-haiku-4-5'] }, 'claude-sonnet-5');
  assert.equal(both.reason, 'both'); assert.deepEqual(both.retiredModels, ['claude-sonnet-5']); assert.equal(both.pinRetired, true);
  const none = compare(prev, { harness: '2.1.1', models: prev.models });
  assert.equal(none.changed, false); assert.equal(none.reason, 'none');
  const first = compare({ harness: '2.1.1', models: null }, { harness: '2.1.1', models: ['x'] });
  assert.equal(first.changed, false, 'the first model snapshot is not a change'); assert.equal(first.firstModelSnapshot, true);
  assert.equal(compare({ harness: null, models: null }, { harness: '2.1.1', models: null }).reason, 'harness', 'no stored state → first run counts as a harness change');
  assert.equal(compare(prev, { harness: '2.1.1', models: null }, 'claude-sonnet-5').pinRetired, null, 'unknown without a model list');
});

test('fetchModels: no key → skipped; server → sorted ids; HTTP error → error', async () => {
  assert.deepEqual(await fetchModels('http://127.0.0.1:1/', undefined), { models: null, error: 'ANTHROPIC_API_KEY / CDC_MODELS_API_KEY not set' });
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/ok')) { assert.equal(req.headers['x-api-key'], 'k'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }] })); }
    else { res.statusCode = 500; res.end('nope'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.deepEqual(await fetchModels(`http://127.0.0.1:${port}/ok`, 'k'), { models: ['claude-haiku-4-5', 'claude-sonnet-5'], error: null });
  assert.deepEqual(await fetchModels(`http://127.0.0.1:${port}/bad`, 'k'), { models: null, error: 'HTTP 500' });
  srv.close();
});
