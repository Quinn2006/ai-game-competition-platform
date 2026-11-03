import test from 'node:test';
import assert from 'node:assert/strict';
import {decimal,judgeScore,judgeAverage,popularity,finalScore,display,rank,serialize,compare} from '../backend/src/modules/competition/scoring.mjs';
test('competition exact formula, display boundaries and arbitrary integer counts',()=>{
 assert.equal(display(judgeScore([80,90,70,80,100])),'83.50');
 assert.equal(display(finalScore(decimal(85),decimal(68))),'78.20');
 assert.equal(display(decimal('1.005')),'1.01');
 assert.equal(display(popularity(0,0,0,0)),'0.00');
 assert.equal(display(popularity('9007199254740993',0,'9007199254740993',0)),'60.00');
 assert.deepEqual(serialize(popularity(1,0,7,0)),{numerator:'60',denominator:'7',display:'8.57'});
 assert.equal(display(judgeAverage([[0,0,0,0,0],[100,100,100,100,100],[100,100,100,100,100]])),'66.67');
 for(const value of [-1,101,NaN,Infinity,{},'1e2'])assert.throws(()=>decimal(value));
 assert.throws(()=>judgeAverage([[1,1,1,1,1]]));assert.throws(()=>judgeScore([1]));
 assert.throws(()=>popularity(2,0,1,0));assert.throws(()=>popularity(Number.MAX_SAFE_INTEGER+1,0,1,0));
});
test('competition full precision ordering, three tie breakers and shared ranks',()=>{
 const row=(id,t,a,l=1,p=1)=>({id,total:decimal(t),average:decimal(a),likes:l,plays:p});
 const result=rank([row('a',80,80),row('b','80.000000001',80),row('c',80,80),row('d',70,99)]);
 assert.deepEqual(result.map(x=>[x.id,x.rank]),[['b',1],['a',2],['c',2],['d',4]]);
 assert.deepEqual(rank([row('a',80,80,1,1),row('b',80,80,1,2),row('c',80,80,2,0),row('d',80,81,0,0)]).map(x=>x.id),['d','c','b','a']);
 assert.equal(compare(judgeScore(['0.1','0.1','0.1','0.1','0.1']),decimal('0.1')),0);
});
test('V-06 sensitivity: outlier normalization, monotonicity and judge/popularity bounds',()=>{
 const baseline=finalScore(decimal(85),popularity(50,50,100,100));
 const outlier=finalScore(decimal(85),popularity(50,50,10000,10000));
 assert.equal(display(baseline),'71.00');assert.equal(display(outlier),'51.20');
 assert.equal(display(finalScore(decimal(85),popularity(50,50,10000,100))),'59.12');
 for(let l=0;l<100;l++)assert.ok(compare(popularity(l+1,10,100,100),popularity(l,10,100,100))>0);
 assert.equal(display(finalScore(decimal(100),decimal(0))),'60.00');
 assert.equal(display(finalScore(decimal(0),decimal(100))),'40.00');
});
