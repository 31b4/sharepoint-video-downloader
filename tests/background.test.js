import test from 'node:test';
import assert from 'node:assert/strict';

test('native-host exit preserves terminal results and allows another job', async () => {
  let handler, onMessage, onDisconnect;
  const updates = [];
  const port = {
    onMessage:{addListener(fn){onMessage=fn;}},
    onDisconnect:{addListener(fn){onDisconnect=fn;}},
    postMessage(){}
  };
  globalThis.chrome = {
    runtime:{id:'test-extension',onMessage:{addListener(fn){handler=fn;}},connectNative:()=>port},
    tabs:{get:async()=>({url:'https://example.sharepoint.com/video'})},
    scripting:{executeScript:async()=>[{result:{title:'Workshop',manifest:'https://media.svc.ms/transform/videomanifest'}}]},
    storage:{session:{set:async data=>{updates.push(data.job);}}}
  };
  await import('../extension/background.js');
  await new Promise(resolve=>handler({action:'download',tabId:1,mode:'stream'},{id:'test-extension'},resolve));
  onMessage({state:'complete',status:'Download complete',progress:100,path:'/example/Workshop.mp4'});
  chrome.runtime.lastError = {message:'Native host has exited.'};
  onDisconnect();
  assert.equal(updates.at(-1).status,'Download complete');
  delete chrome.runtime.lastError;
  await new Promise(resolve=>handler({action:'download',tabId:1,mode:'stream'},{id:'test-extension'},resolve));
  onMessage({state:'error',status:'Download failed. Reload the video.'});
  chrome.runtime.lastError = {message:'Native host has exited.'};
  onDisconnect();
  assert.equal(updates.at(-1).status,'Download failed. Reload the video.');
  delete globalThis.chrome;
});
