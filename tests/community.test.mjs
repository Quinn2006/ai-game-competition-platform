import test from 'node:test';
import assert from 'node:assert/strict';
import {advance,dayOf} from '../backend/src/modules/community/timing.mjs';
test('community timing: Shanghai midnight, cumulative foreground, interaction, gap, crash and replay',()=>{
 assert.equal(dayOf(Date.parse('2026-11-01T16:00:00Z')),'2026-11-02');
 const s={sequence:2,updated_at:new Date(10000),elapsed_ms:8000,foreground:true,interacted:true,failed:false};
 const i={sequence:3,kind:'tick',foreground:true,interacted:false,healthy:true};
 assert.equal(advance(s,i,12000).valid,true);
 assert.equal(advance(s,{...i,foreground:false},12000).elapsed,8000);
 assert.equal(advance(s,i,20000).valid,false);
 assert.equal(advance(s,{...i,kind:'error'},12000).valid,false);
 assert.equal(advance({...s,interacted:false},i,12000).valid,false);
 assert.throws(()=>advance(s,{...i,sequence:2},12000));
});
