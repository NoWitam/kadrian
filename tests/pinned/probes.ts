/**
 * Custom HTML elements for the isolation tests of §7.6 and the measurements of
 * D23.7. Each one is a conforming element of D23.3 (it answers the time, so a
 * frame resolves) that also runs a probe from inside its own frame and writes
 * the outcome as JSON into `data-probe` of its root element, where the test
 * reads it. Host names end in `.invalid`, so nothing could resolve even if a
 * request escaped; the Producer also aborts and records every request.
 */

/** The acknowledging part of the fixture element (D23.3), written as a function body. */
const CONFORMING = [
  "var meta=document.querySelector('meta[name=kadrion-instance]');",
  "var instanceId=meta?meta.getAttribute('content'):null;",
  "addEventListener('message',function(event){",
  'if(event.source!==window.parent)return;var d=event.data;',
  "if(!d||d.type!=='kadrion:time'||d.instanceId!==instanceId)return;",
  "var bar=document.getElementById('bar');if(bar)bar.style.width=d.timeUs/100000+'%';",
  "window.parent.postMessage({type:'kadrion:time-ack',version:1,instanceId:instanceId,requestId:d.requestId,timeUs:d.timeUs},'*');",
  'if(typeof onAcknowledged==="function")onAcknowledged();',
  '});',
].join('');

const STYLE =
  "<style>html,body{margin:0;height:100%;background:#1d2939}#bar{width:0;height:100%;background:#f79009}</style><div id='bar'></div>";

function element(head: string, script: string): string {
  return `<!doctype html><meta charset='utf-8'>${head}${STYLE}<script>(function(){${CONFORMING}${script}})()</script>`;
}

/**
 * Every probe of §7.6 from inside the element: the host page, a sibling,
 * storage, the network, pop-ups, dialogs, workers, WebRTC, and, last, top-level
 * navigation. Each entry is `allowed:<detail>` or `blocked:<error name>`.
 */
export const ISOLATION_PROBE = element(
  "<link rel='dns-prefetch' href='//kadrion-dns.invalid'><link rel='preconnect' href='https://kadrion-preconnect.invalid'>",
  `
var r={};
function t(n,f){try{var v=f();r[n]='allowed:'+String(v).slice(0,60)}catch(e){r[n]='blocked:'+e.name}}
function p(n,f){return new Promise(function(done){var settled=false;function end(v){if(!settled){settled=true;r[n]=v;done()}}
try{f(function(){end('allowed')},function(e){end('blocked:'+(e&&e.name?e.name:'error'))})}catch(e){end('blocked:'+e.name)}
setTimeout(function(){end('pending')},2000)})}
r.origin=self.origin;
t('parent.document',function(){return parent.document.title});
t('top.document',function(){return top.document.title});
t('top.location.href',function(){return top.location.href});
t('sibling.document',function(){for(var i=0;i<parent.frames.length;i++){if(parent.frames[i]!==window)return parent.frames[i].document.title}throw {name:'NoSibling'}});
t('localStorage',function(){return localStorage.length});
t('sessionStorage',function(){return sessionStorage.length});
t('indexedDB',function(){return indexedDB.open('kadrion')});
t('document.cookie',function(){document.cookie='k=v';return document.cookie});
t('window.open',function(){var w=window.open('https://kadrion-probe.invalid/popup');if(w===null)throw {name:'ReturnedNull'};return 'window'});
t('alert',function(){alert('probe');return 'returned'});
Promise.all([
p('fetch',function(ok,no){fetch('https://kadrion-probe.invalid/fetch').then(ok,no)}),
p('caches',function(ok,no){caches.keys().then(ok,no)}),
p('XMLHttpRequest',function(ok,no){var x=new XMLHttpRequest();x.onload=ok;x.onerror=function(){no({name:'error'})};x.open('GET','https://kadrion-probe.invalid/xhr');x.send()}),
p('WebSocket',function(ok,no){var w=new WebSocket('wss://kadrion-probe.invalid/ws');w.onopen=ok;w.onerror=function(){no({name:'error'})}}),
p('EventSource',function(ok,no){var s=new EventSource('https://kadrion-probe.invalid/sse');s.onopen=ok;s.onerror=function(){s.close();no({name:'error'})}}),
p('Worker',function(ok,no){var w=new Worker('data:text/javascript,postMessage(1)');w.onmessage=ok;w.onerror=function(){no({name:'error'})}}),
p('image',function(ok,no){var i=new Image();i.onload=ok;i.onerror=function(){no({name:'error'})};i.src='https://kadrion-probe.invalid/i.png'}),
p('font',function(ok,no){new FontFace('probe','url(https://kadrion-probe.invalid/f.ttf)').load().then(ok,no)}),
new Promise(function(done){
if(typeof RTCPeerConnection!=='function'){r.webrtc='absent';done();return}
var types=[],addresses=[];try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:kadrion-stun.invalid:3478'},{urls:'turn:kadrion-turn.invalid:3478',username:'k',credential:'k'}]});
pc.onicecandidate=function(e){if(e.candidate){types.push(e.candidate.type||'unknown');addresses.push(e.candidate.address||'')}};
pc.createDataChannel('probe');pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).catch(function(e){types.push('error:'+e.name)});
setTimeout(function(){r.webrtc={constructed:true,candidates:types,addresses:addresses,gathering:pc.iceGatheringState};pc.close();done()},1500)}
catch(e){r.webrtc='blocked:'+e.name;done()}})
]).then(function(){
t('top.location=',function(){top.location.href='https://kadrion-probe.invalid/top';return 'assigned'});
document.documentElement.setAttribute('data-probe',JSON.stringify(r))});
`,
);

/** Self-navigation variants of D23.7: each navigates after its first acknowledgement. */
export const SELF_NAVIGATION: Readonly<Record<string, string>> = {
  location: element(
    '',
    "var onAcknowledged=function(){onAcknowledged=null;setTimeout(function(){location.href='https://kadrion-nav.invalid/location'},0)};",
  ),
  'meta-refresh': element(
    "<meta http-equiv='refresh' content='0;url=https://kadrion-nav.invalid/meta'>",
    '',
  ),
  'link-click': element(
    '',
    "var onAcknowledged=function(){onAcknowledged=null;setTimeout(function(){var a=document.createElement('a');a.href='https://kadrion-nav.invalid/link';document.body.appendChild(a);a.click()},0)};",
  ),
  'data-url': element(
    '',
    "var onAcknowledged=function(){onAcknowledged=null;setTimeout(function(){location.href='data:text/html,<p>away</p>'},0)};",
  ),
};

/** The attacker of `custom-html-element.test.ts`: retimes its sibling and answers in its name. */
export function attackerHtml(victim: string): string {
  return [
    '<script>',
    "addEventListener('message', function (event) {",
    '  if (event.source !== window.parent) return;',
    '  var d = event.data;',
    '  for (var i = 0; i < window.parent.frames.length; i++) {',
    '    var other = window.parent.frames[i];',
    '    if (other === window) continue;',
    `    other.postMessage({ type: 'kadrion:time', version: 1, instanceId: '${victim}', requestId: d.requestId, timeUs: 9900000 }, '*');`,
    '  }',
    `  window.parent.postMessage({ type: 'kadrion:time-ack', version: 1, instanceId: '${victim}', requestId: d.requestId, timeUs: d.timeUs }, '*');`,
    "  window.parent.postMessage({ type: 'kadrion:time-ack', version: 1, instanceId: d.instanceId, requestId: d.requestId, timeUs: d.timeUs }, '*');",
    '});',
    '</script>',
  ].join('\n');
}
