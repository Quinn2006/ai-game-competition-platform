// Synthetic component fixture only. Not a scanner bypass or application startup path.
import { createApp } from '../src/app.mjs';
import { createGameHttp } from '../src/modules/uploads/http.mjs';
import { loadConfig } from '../src/config.mjs';
import { zipFixture } from './zip-fixture.mjs';
import { createHash } from 'node:crypto';
const config=loadConfig({MAIN_ORIGIN:'http://127.0.0.1:4330',GAME_ORIGIN:'http://127.0.0.2:4331',PORT:'4330'});
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const versions=ids.map((id,i)=>({id,work_id:id,title:'安全测试作品 '+(i+1),metadata:{domains:[],orientation:i?'portrait':'landscape',saveVersion:'v1'}}));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font-family:system-ui;padding:20px;background:#eff5ed;color:#203a36}button,a{padding:12px;margin:8px;display:inline-block}pre{white-space:pre-wrap}</style><h1>隔离测试游戏</h1><p id="score">存档待加载</p><button id="save">保存进度 42</button><a href="https://example.com/">外部链接</a><pre id="probe"></pre><script>
const report={};try{parent.document.body;report.parent='FAIL';}catch{report.parent='blocked';}try{localStorage.getItem('secret');report.storage='FAIL';}catch{report.storage='blocked';}
fetch('https://example.com/probe').then(()=>report.network='FAIL').catch(()=>{report.network='blocked';document.querySelector('#probe').textContent=JSON.stringify(report);});
window.addEventListener('platform:save',e=>{document.querySelector('#score').textContent='存档：'+JSON.stringify(e.detail);});document.querySelector('#save').onclick=()=>{PlatformGame.save({score:42});document.querySelector('#score').textContent='已保存 42';};
</script></html>`;
const bytes=zipFixture([['index.html',html]]);
for(const v of versions)v.digest=createHash('sha256').update(bytes).digest('hex');
const uploads={
  async published(id){const v=versions.find(v=>v.work_id===id);if(!v)throw new Error('Not found');return v;},
  async run(action,input){if(action==='list')return{works:versions.map(v=>({id:v.work_id,title:v.title}))};if(action==='detail')return{work:{id:input.workId,title:'测试作品'},versions:[],events:[]};throw new Error('Fixture is read only');},
};
const storage={get:async()=>bytes,health:async()=>true};
const games=createGameHttp({config,uploads,storage});
const app=createApp({config,database:null,storage,log:()=>{},games:games.main});
app.listen(4330,'127.0.0.1');games.game.listen(4331,'127.0.0.2');
console.log('Synthetic browser fixture: http://127.0.0.1:4330/play?work='+ids[0]);
process.on('SIGINT',()=>{app.close();games.game.close();});
