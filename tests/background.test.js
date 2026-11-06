import test from 'node:test';
import assert from 'node:assert/strict';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await tick();}throw new Error('Expected background state was not reached');}
let sequence=0;
async function setup(options={}) {
  let handler, downloadChanged, clicked;
  const updates=[], ports=[], notifications=[], reloads=[], badges=[];
  let stored=options.stored || null;
  const fresh={title:'Workshop',manifest:'https://media.svc.ms/transform/videomanifest'};
  globalThis.chrome={
    runtime:{id:'test-extension',onMessage:{addListener(fn){handler=fn;}},connectNative(){
      let message,disconnect;
      const connection={sent:[],onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},postMessage(value){this.sent.push(value);},disconnect(){disconnect?.();},emit(value){message(value);},end(){chrome.runtime.lastError={message:'Host exited'};disconnect();delete chrome.runtime.lastError;}};
      ports.push(connection);return connection;
    }},
    tabs:{get:async()=>({url:'https://example.sharepoint.com/video',status:'complete',title:'Workshop'}),reload:async id=>{reloads.push(id);}},
    scripting:{executeScript:async spec=>[{result:spec.func.name==='inspectPage'?(options.media?.()||fresh):null}]},
    storage:{session:{get:async()=>({job:stored}),set:async data=>{stored=data.job;updates.push({...stored});}}},
    action:{setBadgeText:async value=>badges.push(value.text),setBadgeBackgroundColor:async()=>{}},
    permissions:{contains:async()=>true},
    notifications:{create:async(id,value)=>notifications.push(value),clear:async()=>{},onClicked:{addListener(fn){clicked=fn;}},onButtonClicked:{addListener(){}}},
    downloads:{onChanged:{addListener(fn){downloadChanged=fn;}},download:async()=>42,search:async()=>[{filename:'/Downloads/Workshop.mp4'}],show:async()=>{},cancel:async()=>{}}
  };
  if(options.noNotifications){delete chrome.notifications;chrome.permissions.contains=async()=>false;}
  await import('../extension/background.js?test='+sequence++);
  async function request(message){return new Promise(resolve=>handler(message,{id:'test-extension'},resolve));}
  return {updates,ports,notifications,reloads,badges,request,changed:delta=>downloadChanged(delta),click:()=>clicked('sharepoint-download')};
}

test('terminal success survives native exit and exposes the exact save location',async()=>{
  const f=await setup();await f.request({action:'download',tabId:1,mode:'stream'});
  await until(()=>f.ports[0]?.sent.length);
  f.ports[0].emit({state:'complete',status:'Download complete',path:'/Downloads/video.mp4',folder:'/Downloads',progress:100});f.ports[0].end();
  await until(()=>f.notifications.length);
  assert.equal(f.updates.at(-1).state,'complete');assert.equal(f.updates.at(-1).path,'/Downloads/video.mp4');
  assert.equal(f.notifications[0].buttons[0].title,'Show in folder');assert.equal(f.badges.at(-1),'✓');
});
test('authorization failure automatically refreshes and retries only once',async()=>{
  const f=await setup();await f.request({action:'download',tabId:7,mode:'stream'});await until(()=>f.ports[0]?.sent.length);
  f.ports[0].emit({state:'error',code:'AUTH_EXPIRED',status:'Expired'});f.ports[0].end();
  await new Promise(resolve=>setTimeout(resolve,800));await until(()=>f.ports[1]?.sent.length);
  assert.deepEqual(f.reloads,[7]);
  f.ports[1].emit({state:'error',code:'AUTH_EXPIRED',status:'SharePoint denied access'});f.ports[1].end();
  await until(()=>f.updates.at(-1)?.state==='error');assert.equal(f.ports.length,2);assert.equal(f.updates.at(-1).status,'SharePoint denied access');
});
test('duplicate clicks cannot start two downloads; cancel reaches the helper',async()=>{
  const f=await setup();await f.request({action:'download',tabId:1,mode:'stream'});await until(()=>f.ports[0]?.sent.length);
  assert.match((await f.request({action:'download',tabId:1})).error,/already/);
  await f.request({action:'cancel'});assert.equal(f.ports[0].sent.at(-1).action,'cancel');
  f.ports[0].emit({state:'cancelled',status:'Cancelled'});f.ports[0].end();await until(()=>f.updates.at(-1)?.state==='cancelled');
});
test('popup recovers a helper completion after extension reload',async()=>{
  const f=await setup();const response=f.request({action:'status'});await until(()=>f.ports[0]?.sent.length);
  f.ports[0].emit({state:'complete',status:'Download complete',path:'/Downloads/old.mp4',folder:'/Downloads',updatedAt:Date.now()});
  assert.equal((await response).job.path,'/Downloads/old.mp4');
});
test('downloads work when optional notification APIs are unavailable',async()=>{
  const f=await setup({noNotifications:true});await f.request({action:'download',tabId:1,mode:'stream'});await until(()=>f.ports[0]?.sent.length);
  f.ports[0].emit({state:'complete',status:'Download complete',path:'/Downloads/video.mp4',folder:'/Downloads'});f.ports[0].end();
  await until(()=>f.updates.at(-1)?.state==='complete');assert.equal(f.notifications.length,0);
});

test('an unverified metadata URL never opens Chrome Save As or downloads JSON',async()=>{
  const f=await setup({media:()=>({title:'New meeting',direct:'https://tenant.sharepoint.com/metadata.json',manifest:'https://media.svc.ms/transform/videomanifest'})});
  let browserDownloads=0;chrome.downloads.download=async()=>{browserDownloads++;};
  await f.request({action:'download',tabId:1});await until(()=>f.ports[0]?.sent.length);
  assert.equal(browserDownloads,0);assert.equal(f.ports[0].sent[0].url,'https://media.svc.ms/transform/videomanifest');
  f.ports[0].emit({state:'complete',status:'Download complete',path:'/Downloads/new.mp4',folder:'/Downloads'});f.ports[0].end();
  await until(()=>f.updates.at(-1)?.state==='complete');
});
test('context identifies the selected meeting separately from a previous download',async()=>{
  const {sourceKey,currentView}=await import('../extension/core.js');
  const previous={state:'complete',title:'Old meeting',path:'/Downloads/old.mp4',sourceKey:await sourceKey('https://example.sharepoint.com/old'),updatedAt:Date.now()};
  const f=await setup({stored:previous});
  const pending=f.request({action:'context',tabId:2});await until(()=>f.ports[0]?.sent.length);
  f.ports[0].emit({state:'idle'});
  const context=await pending;
  assert.equal(context.title,'Workshop');assert.notEqual(context.sourceKey,previous.sourceKey);
  assert.equal(currentView(context.job,context.sourceKey,context.title).state,'idle');
  assert.equal(context.savedVideo.title,'Old meeting');
});
