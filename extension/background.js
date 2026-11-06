import {allowedUrl, filename, expiresSoon, sourceKey} from './core.js';
const HOST = 'io.github.sharepoint_video_downloader';
const ACTIVE = new Set(['reading','refreshing','connecting','downloading','merging','cancelling']);
let savedVideo = null;
let job = null, port = null, busy = false, cancelled = false;
let writes = Promise.resolve();
const ready = chrome.storage.session.get(['job','savedVideo']).then(data => {job = data.job || null;savedVideo = data.savedVideo || (job?.state==='complete'?job:null);});

function update(patch) {
  job = {...job, ...patch, updatedAt:Date.now()};
  const snapshot = {...job};
  writes = writes.catch(()=>{}).then(async () => {
    if(snapshot.state==='complete'&&snapshot.path)savedVideo=snapshot;
    await chrome.storage.session.set({job:snapshot,savedVideo});
    const badge = snapshot.state === 'complete' ? '✓' : snapshot.state === 'error' ? '!' :
      ACTIVE.has(snapshot.state) ? (Number.isFinite(snapshot.progress) ? Math.floor(snapshot.progress)+'%' : '…') : '';
    await chrome.action.setBadgeText({text:badge});
    await chrome.action.setBadgeBackgroundColor({color:snapshot.state === 'error' ? '#ab3d39' : '#087f6c'});
  });
  return writes;
}
async function notify() {
  if (!await chrome.permissions.contains({permissions:['notifications']})) return;
  try {
    await chrome.notifications.create('sharepoint-download', {type:'basic', iconUrl:'icon128.png',
      title:job.state === 'complete' ? 'Your video is ready' : 'Video download needs attention',
      message:job.state === 'complete' ? 'Saved to '+job.folder : job.status,
      ...(job.state === 'complete' ? {buttons:[{title:'Show in folder'}]} : {})});
  } catch { /* OS notification settings must never fail a download. */ }
}

async function inspectPage() {
  const info = window.g_fileInfo || {};
  let transform = info['.transformUrl'] || info['.providerCdnTransformUrl'];
  const title = document.title;
  if (transform) {
    try {
      const manifest = new URL(transform, location.href);
      manifest.pathname = manifest.pathname.replace(/\/transform\/[^/]*$/, '/transform/videomanifest');
      manifest.searchParams.set('part','index');
      manifest.searchParams.set('format','dash');
      transform = manifest.href;
    } catch {transform = null;}
  }
  const video = document.querySelector('video');
  if (!transform && /^https:/.test(video?.currentSrc || '')) transform = video.currentSrc;
  return {title,manifest:transform};
}
async function inspect(tabId) {
  const result = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectPage});
  return result[0]?.result;
}
function checkCancelled() {if(cancelled) throw new Error('Download cancelled.');}
async function refresh(tabId) {
  await update({state:'refreshing',status:'Refreshing the expired video link automatically…',progress:null});
  let playback;
  try {
    const result = await chrome.scripting.executeScript({target:{tabId},func:()=>{
      const video=document.querySelector('video');
      return video ? {time:video.currentTime,paused:video.paused} : null;
    }});
    playback=result[0]?.result;
  } catch { /* A not-yet-ready player can still be refreshed. */ }
  await chrome.tabs.reload(tabId);
  const deadline = Date.now()+45000;
  while(Date.now()<deadline) {
    checkCancelled();
    await new Promise(resolve=>setTimeout(resolve,750));
    const tab=await chrome.tabs.get(tabId);
    if(tab.status !== 'complete') continue;
    const media=await inspect(tabId).catch(()=>null);
    if(!media?.manifest) continue;
    if(media.manifest && expiresSoon(media.manifest)) continue;
    if(playback) await chrome.scripting.executeScript({target:{tabId},args:[playback],func:previous=>{
      const video=document.querySelector('video');
      if(!video) return;
      const restore=()=>{video.currentTime=previous.time; if(!previous.paused) video.play().catch(()=>{});};
      if(video.readyState) restore(); else video.addEventListener('loadedmetadata',restore,{once:true});
    }}).catch(()=>{});
    return media;
  }
  throw new Error('SharePoint did not provide a fresh video link. Sign in on the video tab and try again.');
}
function nativeRequest(message) {
  return new Promise((resolve,reject)=>{
    let response;
    const connection=chrome.runtime.connectNative(HOST);
    const timer=setTimeout(()=>{connection.disconnect();reject(new Error('The local helper did not respond.'));},10000);
    connection.onMessage.addListener(value=>{response=value;clearTimeout(timer);resolve(value);connection.disconnect();});
    connection.onDisconnect.addListener(()=>{const error=chrome.runtime.lastError;clearTimeout(timer);if(!response)reject(new Error(error ? 'Local helper unavailable. See Local helper setup below.' : 'Helper closed without a response.'));});
    connection.postMessage(message);
  });
}
async function reveal() {
  await ready;
  if(!savedVideo?.path) throw new Error('Finish a download before opening its location.');
  const result=await nativeRequest({action:'reveal',path:savedVideo.path});
  if(result.state==='error') throw new Error(result.status);
}
function stream(media) {
  return new Promise((resolve,reject)=>{
    let terminal;
    const connection=chrome.runtime.connectNative(HOST);
    port=connection;
    connection.onMessage.addListener(message=>{
      if(message.state==='complete'||message.state==='error'||message.state==='cancelled') {
        terminal=message;
      } else {
        update({state:message.state || 'downloading',status:String(message.status || 'Downloading…').slice(0,300),progress:message.progress ?? null});
      }
    });
    connection.onDisconnect.addListener(()=>{
      const error=chrome.runtime.lastError;
      if(port===connection)port=null;
      if(terminal)resolve(terminal);
      else reject(new Error(error ? 'The local helper stopped unexpectedly. Check setup and retry.' : 'The helper ended without confirming the saved file.'));
    });
    connection.postMessage({action:'download',url:media.manifest,title:filename(media.title),jobId:job.id,sourceKey:job.sourceKey});
  });
}
async function run(tabId) {
  await ready;
  if(busy)throw new Error('A download is already running.');
  busy=true;cancelled=false;
  try {
  const tab=await chrome.tabs.get(tabId);
  if(!allowedUrl(tab.url)||!new URL(tab.url).hostname.endsWith('.sharepoint.com')) throw new Error('Open the SharePoint video in this tab first.');
    if(chrome.notifications)await chrome.notifications.clear('sharepoint-download').catch(()=>{});
    job={id:crypto.randomUUID(),tabId,sourceKey:await sourceKey(tab.url),title:tab.title || 'SharePoint video',state:'reading',status:'Finding your video…',progress:null};
    await update({});
    let media=await inspect(tabId);
    checkCancelled();
    let refreshed=false;
    if(!media?.manifest || expiresSoon(media.manifest)) {
      media=await refresh(tabId);refreshed=true;
    }
    checkCancelled();
    await update({title:media?.title || job.title});
    while(true) {
      checkCancelled();
      if(!allowedUrl(media?.manifest))throw new Error('No supported video stream found. Make sure this video plays in SharePoint.');
      await update({state:'connecting',status:'Connecting to your local downloader…',progress:null});
      const result=await stream(media);
      if(result.state==='error'&&result.code==='AUTH_EXPIRED'&&!refreshed&&!cancelled) {
        media=await refresh(tabId);refreshed=true;continue;
      }
      await update({...result,progress:result.state==='complete'?100:null});
      if(result.state==='complete'||result.state==='error')await notify();
      break;
    }
  } catch(error) {
    await update({state:cancelled?'cancelled':'error',status:cancelled?'Download cancelled. Partial files can be resumed on retry.':error.message,progress:null});
    if(!cancelled)await notify();
  } finally {busy=false;}
}
async function status() {
  await ready;
  if(!busy) {
    try {
      const saved=await nativeRequest({action:'status'});
      // Recover the previous helper result after extension reload or popup closure.
      if(['complete','error','cancelled','downloading','merging'].includes(saved.state)&&(!job?.updatedAt||saved.updatedAt>job.updatedAt))await update({...saved,sourceKey:saved.sourceKey || null,id:saved.jobId || null,title:saved.title || saved.path?.split(/[\\/]/).pop() || 'Previous download'});
    } catch { /* A missing optional helper must not hide a browser-only result. */ }
  }
  return job;
}
let notificationHandlersRegistered=false;
function registerNotificationHandlers() {
  if(notificationHandlersRegistered || !chrome.notifications)return;
  const open=id=>{if(id==='sharepoint-download')reveal().catch(()=>{});};
  chrome.notifications.onClicked.addListener(open);
  chrome.notifications.onButtonClicked.addListener(open);
  notificationHandlersRegistered=true;
}
registerNotificationHandlers();
chrome.permissions.onAdded?.addListener(registerNotificationHandlers);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  (async()=>{
    await ready;
    if(message.action==='download') {
      if(busy)return {error:'A download is already running.'};
      run(message.tabId).catch(error=>update({state:'error',status:error.message}));
      return {ok:true};
    }
    if(message.action==='status')return {job:await status(),savedVideo};
    if(message.action==='context') {
      const tab=await chrome.tabs.get(message.tabId);
      return {sourceKey:await sourceKey(tab.url),title:tab.title || 'SharePoint video',supported:allowedUrl(tab.url)&&new URL(tab.url).hostname.endsWith('.sharepoint.com'),job:await status(),savedVideo};
    }
    if(message.action==='reveal'){await reveal();return {ok:true};}
    if(message.action==='cancel') {
      cancelled=true;
      if(port) {await update({state:'cancelling',status:'Cancelling download…'});port.postMessage({action:'cancel'});}
      return {ok:true};
    }
    return {error:'Unsupported action.'};
  })().then(reply).catch(error=>reply({error:error.message}));
  return true;
});
