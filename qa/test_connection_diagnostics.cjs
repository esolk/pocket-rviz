// Independent deterministic state-machine regression, no browser, robot or network.
// Run: node qa/test_connection_diagnostics.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireWeb = createRequire(path.join(__dirname, '../web/package.json'));
const esbuild = requireWeb('esbuild');
const artifactDir = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
const bundle = path.join(artifactDir, 'diagnostics-client-under-test.cjs');
esbuild.buildSync({stdin: {contents:'export { RosConnection } from "./client"; export * from "./diagnostics";', resolveDir:path.join(__dirname,'../web/src'),loader:'ts'}, bundle:true, platform:'node', format:'cjs', outfile:bundle});
const { RosConnection, connectionSummary, DIAGNOSTIC_LIMIT, redactDiagnosticText } = require(bundle);
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-data.json')));
const channels = fixtures.channels.map(({payloadBase64, ...c}) => c);
const realTimeout = global.setTimeout, realClear = global.clearTimeout, realNow = Date.now;
let now = 1_700_000_000_000, nextTimer = 0, timers = new Map();
global.setTimeout = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id,{at:now + delay,fn}); return id; };
global.clearTimeout = id => timers.delete(id);
Date.now = () => now;
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const first = [...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    if (!first || first[1].at > end) break;
    timers.delete(first[0]); now = first[1].at; first[1].fn();
  }
  now = end;
}
class Socket {
  readyState = 0; protocol = 'foxglove.websocket.v1'; binaryType = ''; sent = [];
  send(data) { assert.equal(typeof data, 'string'); this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  json(message) { this.onmessage?.({data:JSON.stringify(message)}); }
  serverClose(code=1000, reason='', wasClean=true) { this.readyState=3; this.onclose?.({code,reason,wasClean}); }
  close() { this.serverClose(); }
  refuse() { this.onerror?.({}); this.serverClose(1006,'',false); }
  binary(subscriptionId, payload) {
    const data = new ArrayBuffer(13 + payload.length), view = new DataView(data);
    view.setUint8(0, 1); view.setUint32(1, subscriptionId, true); view.setBigUint64(5, 123n, true);
    new Uint8Array(data,13).set(payload); this.onmessage?.({data});
  }
}
let active;
const results = [];
function setup(url='ws://127.0.0.1:8876/normal') {
  const sockets = [], packets = [], notices=[];
  const client = new RosConnection(() => { const ws = new Socket(); sockets.push(ws); return ws; });
  client.onPacket = p => packets.push(p); client.onError = n => notices.push(n);
  client.connect(url); active=client;
  return {client,sockets,ws:sockets[0],packets,notices};
}
function test(name, fn) {
  timers.clear(); now += 60_000;
  try { fn(); results.push({name,passed:true}); }
  catch (error) { results.push({name,passed:false,error:error.message,stack:error.stack}); }
  finally { active?.disconnect(); active=undefined; timers.clear(); }
}
function normal(client, ws) {
  ws.open(); ws.json({op:'serverInfo',name:'SYNTHETIC QA',capabilities:['clientPublish','services','parameters']});
  ws.json({op:'advertise',channels});
}
test('Refused transport never becomes connected and retains opaque browser-error limits',()=>{
  const {client,ws,sockets} = setup(); ws.refuse();
  assert.equal(client.diagnostics.phase,'closed'); assert.equal(client.diagnostics.openedAt,undefined);
  assert.notEqual(client.state,'已连接'); assert.match(connectionSummary(client.diagnostics),/未建立成功/);
  assert.equal(client.diagnostics.close.code,1006); assert.equal(client.diagnostics.retryDelayMs,1000);
  advance(1000); assert.equal(sockets.length,2);
});
test('Open socket with no serverInfo stays open after 30 seconds and reports protocol wait',()=>{
  const {client,ws,sockets}=setup(); ws.open(); advance(30_000);
  assert.equal(client.diagnostics.phase,'open'); assert.equal(sockets.length,1);
  assert.match(connectionSummary(client.diagnostics),/已打开.*等待/); assert.doesNotMatch(connectionSummary(client.diagnostics),/连接已关闭|未建立成功/);
});
test('Empty serverInfo is distinct from socket failure and absent advertise',()=>{
  const {client,ws}=setup(); ws.open(); ws.json({op:'serverInfo'}); advance(15_000);
  assert.ok(client.diagnostics.serverInfoAt); assert.equal(client.diagnostics.phase,'open');
  assert.equal(client.diagnostics.firstAdvertiseAt,undefined); assert.match(connectionSummary(client.diagnostics),/已收到 serverInfo.*尚未收到话题广播/);
});
test('Explicit zero-topic advertisement is recorded without disconnect or retry',()=>{
  const {client,ws,sockets}=setup(); ws.open(); ws.json({op:'advertise',channels:[]}); advance(15_000);
  assert.ok(client.diagnostics.firstAdvertiseAt); assert.equal(client.diagnostics.advertised,0);
  assert.equal(client.diagnostics.phase,'open'); assert.equal(sockets.length,1); assert.match(connectionSummary(client.diagnostics),/空话题列表/);
});
test('Unsupported schema has advertised=1 eligible=0 subscribed=0 while socket remains open',()=>{
  const {client,ws}=setup(); ws.open(); ws.json({op:'advertise',channels:[{...channels[0],encoding:'cdr',schemaEncoding:'ros2msg'}]});
  assert.equal(client.diagnostics.advertised,1); assert.equal(client.diagnostics.eligible,0); assert.equal(client.diagnostics.subscribed,0);
  assert.equal(client.diagnostics.phase,'open'); assert.equal(ws.sent.length,0); assert.match(connectionSummary(client.diagnostics),/没有可解析的 ROS1 schema/);
});
test('Eight-topic fixture receives binary data and only sends subscribe/unsubscribe',()=>{
  const {client,ws,packets}=setup(); normal(client,ws);
  assert.equal(client.diagnostics.advertised,8); assert.equal(client.diagnostics.eligible,8); assert.equal(client.diagnostics.subscribed,7);
  for (const m of [...ws.sent]) for (const s of m.subscriptions || []) {
    const fixture=fixtures.channels.find(c=>c.id===s.channelId);
    ws.binary(s.id,Buffer.from(fixture.payloadBase64,'base64'));
  }
  client.flush(); assert.equal(packets.length,7); assert.ok(client.diagnostics.firstBinaryAt); assert.ok(client.diagnostics.lastDataAt);
  assert.match(connectionSummary(client.diagnostics),/正在接收数据/);
  advance(11_000); assert.match(connectionSummary(client.diagnostics),/低频\/静态.*不能据此判定断网/);
  client.toggle(3,false); assert.ok(ws.sent.some(m=>m.op==='unsubscribe'));
  assert.ok(ws.sent.every(m=>['subscribe','unsubscribe'].includes(m.op)));
});
for (const code of [1000,1008,1011]) test(`Close ${code} preserves code, redacts reason, backs off and reconnects`,()=>{
  const {client,ws,sockets}=setup('ws://127.0.0.1:8876/normal?token=QA_URL_SECRET'); normal(client,ws);
  ws.serverClose(code,'token=QA_SECRET_TOKEN password=QA_SECRET_PASSWORD ws://user:QA_PASS@localhost/?key=QA_KEY QA_URL_SECRET',true);
  assert.equal(client.diagnostics.phase,'closed'); assert.equal(client.diagnostics.close.code,code); assert.equal(client.diagnostics.close.wasClean,true);
  assert.equal(client.diagnostics.subscribed,0); assert.equal(client.diagnostics.retryDelayMs,1000);
  assert.doesNotMatch(JSON.stringify([client.diagnostics,client.diagnosticLog]),/QA_SECRET_TOKEN|QA_SECRET_PASSWORD|QA_PASS|QA_KEY|QA_URL_SECRET/);
  advance(1000); assert.equal(sockets.length,2); normal(client,sockets[1]); sockets[1].serverClose(code);
  assert.equal(client.diagnostics.retryDelayMs,2000); advance(2000); assert.equal(sockets.length,3);
});
test('Manual disconnect cancels retry and ignores delayed callbacks',()=>{
  const {client,ws,sockets}=setup(); ws.refuse(); client.disconnect();
  ws.open(); ws.json({op:'advertise',channels}); advance(60_000);
  assert.equal(client.diagnostics.phase,'idle'); assert.equal(client.diagnostics.retryAt,undefined); assert.equal(sockets.length,1);
});
test('Diagnostic ring and each event are bounded',()=>{
  const {client}=setup(); for(let i=0;i<2000;i++)client.addDiagnostic('fixture'+i,'x'.repeat(5000));
  assert.equal(client.diagnosticLog.length,DIAGNOSTIC_LIMIT); assert.ok(DIAGNOSTIC_LIMIT<=200);
  assert.ok(client.diagnosticLog.every(e=>e.detail.length<=1200));
});
test('Bearer credentials in server text are redacted',()=>{
  assert.doesNotMatch(redactDiagnosticText('Authorization: Bearer QA_BEARER_SECRET'),/QA_BEARER_SECRET/);
});
global.setTimeout=realTimeout; global.clearTimeout=realClear; Date.now=realNow;
const report={type:'deterministic fake-transport client regression, not browser or Android',testedAt:new Date().toISOString(),passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results};
fs.writeFileSync(path.join(artifactDir,'connection-diagnostics-tests.json'),JSON.stringify(report,null,2)+'\n');
for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.error?'\n  '+r.error:''}`);
console.log(`${report.passed}/${results.length} passed`); process.exitCode=report.failed?1:0;
