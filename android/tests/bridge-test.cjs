// Sandboxed bootstrap contract tests: no browser and no network is used.
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/src/main/assets/diagnostics-bootstrap.js'), 'utf8');
let checks = 0;
function setup(href = 'https://appassets.androidplatform.net/index.html', framed = false) {
  const listeners = new Map(); const sent = []; const dispatched = []; const timers = [];
  const input = {value: 'ws://192.0.2.1:8765'};
  const win = {addEventListener(t,f) {listeners.set('w:'+t,f);}, removeEventListener(t) {listeners.delete('w:'+t);},
    dispatchEvent(e) {dispatched.push(e);}};
  win.top = framed ? {} : win;
  const doc = {addEventListener(t,f) {listeners.set('d:'+t,f);},removeEventListener(t) {listeners.delete('d:'+t);},
    getElementById(id) {return id === 'url' ? input : null;}};
  const port = {postMessage(data) {sent.push(JSON.parse(data));},start() {},close() {this.closed = true;}};
  const context = {window:win,document:doc,location:{href},setTimeout(f) {timers.push(f);return timers.length;},clearTimeout() {},
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}}, Event:class {constructor(type){this.type=type;}}};
  vm.runInNewContext(source, context);
  function bind(nonce='__DIAGNOSTIC_NONCE__') {listeners.get('w:message')?.({data:JSON.stringify({kind:'ros-native-diagnostics',nonce}),ports:[port]});}
  function click(trusted=true) {listeners.get('d:click')?.({isTrusted:trusted,target:{closest(id){return id === '#network-probe' ? {disabled:false} : null;}}});}
  return {win,listeners,sent,dispatched,port,input,timers,bind,click};
}
let t = setup(); t.bind('wrong'); assert.equal(t.win.AndroidDiagnostics, undefined); checks++;
t.bind(); assert.equal(typeof t.win.AndroidDiagnostics.requestNetworkDiagnostics, 'function'); checks++;
assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'one')); checks++;
t.click(false); assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'one')); checks++;
t.click(); assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics('ws://other:8765','one')); checks++;
t.click(); t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'one'); assert.equal(t.sent[0].url,t.input.value); checks++;
assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'two')); checks++;
t.click(); t.input.value='ws://changed:8765'; assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'two')); checks++;
t.click(); assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'invalid id')); checks++;
t.click(); t.timers.at(-1)(); assert.throws(()=>t.win.AndroidDiagnostics.requestNetworkDiagnostics(t.input.value,'two')); checks++;
t.port.onmessage({data:JSON.stringify({requestId:'one',status:'complete'})}); assert.equal(t.dispatched.at(-1).type,'androidnetworkdiagnostics'); checks++;
t.win.__disposeAndroidDiagnostics(); assert.equal(t.win.AndroidDiagnostics,undefined); assert.equal(t.port.closed,true); checks++;
t=setup('https://evil.example/index.html'); assert.equal(t.listeners.size,0); checks++;
t=setup(undefined,true); assert.equal(t.listeners.size,0); checks++;
console.log('Android JS bridge checks passed: '+checks+' (no network requests)');
