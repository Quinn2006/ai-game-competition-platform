import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeScore, judgeAverage, popularity, finalScore, displayScore } from '../prototypes/scoring.mjs';
import { evaluatePlay, acceptMessage } from '../prototypes/signals.mjs';

test('document examples: 83.50 and 78.20', () => {
  assert.equal(displayScore(judgeScore([80, 90, 70, 80, 100])), '83.50');
  assert.equal(displayScore(finalScore(85, 68)), '78.20');
});
test('zero denominators, single zero and extremes', () => {
  assert.equal(popularity(0, 0, 0, 0), 0);
  assert.equal(popularity(0, 10, 0, 10), 40);
  assert.equal(popularity(10, 0, 10, 0), 60);
  assert.equal(popularity(10, 10, 10, 10), 100);
  assert.equal(finalScore(0, 0), 0);
  assert.equal(finalScore(100, 100), 100);
});
test('judges must have five valid criteria and at least three valid submissions', () => {
  assert.equal(judgeAverage(Array(3).fill([80, 90, 70, 80, 100])), 83.5);
  assert.throws(() => judgeAverage(Array(2).fill([100, 100, 100, 100, 100])));
  for (const v of [-1, 101, NaN, Infinity, '80']) assert.throws(() => judgeScore([v, 0, 0, 0, 0]));
  assert.throws(() => judgeScore([1]));
});
test('invalid counts and inconsistent snapshot fail closed', () => {
  for (const n of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => popularity(n, 0, 1, 0));
  assert.throws(() => popularity(1, 0, 0, 0));
});
test('arithmetic retains precision until display and is deterministic', () => {
  const raw = popularity(1, 1, 7, 9);
  assert.notEqual(raw, Number(displayScore(raw)));
  assert.equal(raw, popularity(1, 1, 7, 9));
  assert.equal(displayScore(1.125), '1.13');
});
const options = { mode: 'cumulative', maxGapMs: 1500 };
const samples = () => Array.from({length: 11}, (_, i) => ({at: i * 1000, loaded: true, visible: true, healthy: true, online: true, interaction: i === 1}));
test('10 second boundary and actual interaction requirement', () => {
  assert.equal(evaluatePlay(samples(), options).candidate, true);
  assert.equal(evaluatePlay(samples().slice(0, 10), options).candidate, false);
  assert.equal(evaluatePlay(samples().map(s => ({...s, interaction: false})), options).candidate, false);
});
test('load failure, background, offline, crash and heartbeat gaps do not accrue', () => {
  for (const key of ['loaded', 'visible', 'healthy', 'online']) {
    assert.equal(evaluatePlay(samples().map(s => ({...s, [key]: false})), options).candidate, false);
  }
  assert.equal(evaluatePlay([{...samples()[0], interaction: true}, {...samples()[10], at: 20000}], options).candidate, false);
});
test('both pending time policies are explicit; interrupted intervals differ', () => {
  const s = Array.from({length: 14}, (_, i) => ({...samples()[1], at: i * 1000, visible: i !== 6}));
  assert.equal(evaluatePlay(s, options).candidate, true);
  assert.equal(evaluatePlay(s, {...options, mode: 'continuous'}).candidate, false);
  assert.throws(() => evaluatePlay(s, {maxGapMs: 1500}));
  assert.equal(evaluatePlay([s[1], s[0]], options).reason, 'invalid-sequence');
});
test('message rejects origin/source/session/schema/type/replay/flood', () => {
  const source = {}, origin = 'http://127.0.0.2:4311';
  const ctx = () => ({source, origin, session: 'test-session', seq: -1, lastAt: -Infinity, minIntervalMs: 100});
  const msg = {source, origin, data: {v: 1, seq: 0, session: 'test-session', type: 'ready'}};
  for (const bad of [{...msg, origin: 'null'}, {...msg, source: {}}, {...msg, data: {...msg.data, session: 'old'}}, {...msg, data: {...msg.data, type: 'save-any-key'}}, {...msg, data: {...msg.data, extra: 1}}]) assert.equal(acceptMessage(bad, ctx(), 0), false);
  const c = ctx();
  assert.equal(acceptMessage(msg, c, 0), true);
  assert.equal(acceptMessage(msg, c, 1000), false);
  assert.equal(acceptMessage({...msg, data: {...msg.data, seq: 1}}, c, 1), false);
  assert.equal(acceptMessage({...msg, data: {...msg.data, seq: 1}}, c, 1000), true);
});
