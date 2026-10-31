import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const requirements = JSON.parse(readFileSync('docs/phase-0/requirements.json', 'utf8'));
const expected = [];
for (const [prefix, count] of [...Array.from({length:10}, (_,i)=>[`D${i+1}`,10]), ['DF',8], ['B',12], ['S',10]]) {
  for (let i=1; i<=count; i++) expected.push(`${prefix}-${String(i).padStart(2,'0')}`);
}
assert.deepEqual(requirements.map(r=>r.id).sort(), expected.sort());
for (const r of requirements) assert.ok(r.rule && r.stage && r.case && r.task, r.id);
const decisions = readFileSync('docs/phase-0/decisions.md','utf8');
for (let i=1;i<=18;i++) assert.ok(decisions.includes(`|T-${String(i).padStart(2,'0')}|`));
console.log('PASS: 130 unique requirements with tasks/cases; 18 decision rows');
