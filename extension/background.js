import {allowedUrl, filename, expiresSoon} from './core.js';
const HOST = 'io.github.sharepoint_video_downloader';
const ACTIVE = new Set(['reading','refreshing','connecting','downloading','merging','cancelling']);
let job = null, port = null, busy = false, cancelled = false;
let writes = Promise.resolve();
const ready = chrome.storage.session.get('job').then(data => {job = data.job || null;});

function update(patch) {
  job = {...job, ...patch, updatedAt:Date.now()};
  const snapshot = {...job};
  writes = writes.catch(()=>{}).then(async () => {
    await chrome.storage.session.set({job:snapshot});
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
  let direct = info['@microsoft.graph.downloadUrl'] || info['.downloadUrl'];
  const title = document.title;
  if (transform) {
    try {
      const manifest = new URL(transform, location.href);
      const docid = manifest.searchParams.get('docid');
      if (docid) {
        const item = new URL(docid);
        if (item.origin === location.origin) {
          item.search = '';
          const response = await fetch(item, {credentials:'same-origin',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)}).catch(()=>null);
          if (response?.ok) {
            const metadata = await response.json();
            direct ||= metadata['@microsoft.graph.downloadUrl'] || metadata['@content.downloadUrl'];
          }
        }
      }
      manifest.pathname = manifest.pathname.replace(/\/transform\/[^/]*$/, '/transform/videomanifest');
      manifest.searchParams.set('part','index');
      manifest.searchParams.set('format','dash');
      transform = manifest.href;
    } catch {transform = null;}
  }
  const video = document.querySelector('video');
  if (!direct && /^https:/.test(video?.currentSrc || '')) direct = video.currentSrc;
  return {title,direct,manifest:transform};
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
    if(!media?.manifest && !media?.direct) continue;
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
  if(job?.state !== 'complete') throw new Error('Finish a download before opening its location.');
  if(job.downloadId !== undefined) {await chrome.downloads.show(job.downloadId);return;}
  const result=await nativeRequest({action:'reveal',path:job.path});
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
    connection.postMessage({action:'download',url:media.manifest,title:filename(media.title),jobId:job.id});
  });
}
async function run(tabId,mode) {
  await ready;
  if(busy)throw new Error('A download is already running.');
  busy=true;cancelled=false;
  try {
  const tab=await chrome.tabs.get(tabId);
  if(!allowedUrl(tab.url)||!new URL(tab.url).hostname.endsWith('.sharepoint.com')) throw new Error('Open the SharePoint video in this tab first.');
    if(chrome.notifications)await chrome.notifications.clear('sharepoint-download').catch(()=>{});
    job={id:crypto.randomUUID(),tabId,title:tab.title || 'SharePoint video',state:'reading',status:'Finding your video…',progress:null};
    await update({});
    let media=await inspect(tabId);
    checkCancelled();
    let refreshed=false;
    if(!media?.manifest&&!media?.direct || media?.manifest&&expiresSoon(media.manifest)) {
      media=await refresh(tabId);refreshed=true;
    }
    checkCancelled();
    if(mode!=='stream'&&allowedUrl(media?.direct)) {
      const id=await chrome.downloads.download({url:media.direct,filename:filename(media.title),saveAs:true});
      await update({state:'downloading',status:'Downloading through Chrome…',downloadId:id});
      return; // downloads.onChanged owns completion from here.
    }
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
  } finally {if(job?.downloadId===undefined || job.state!=='downloading')busy=false;}
}
async function status() {
  await ready;
  if(!busy) {
    try {
      const saved=await nativeRequest({action:'status'});
      // Recover the previous helper result after extension reload or popup closure.
      if(['complete','error','cancelled','downloading','merging'].includes(saved.state)&&(!job?.updatedAt||saved.updatedAt>job.updatedAt))await update(saved);
    } catch { /* A missing optional helper must not hide a browser-only result. */ }
  }
  return job;
}
chrome.downloads.onChanged.addListener(async delta=>{
  await ready;
  if(delta.id!==job?.downloadId)return;
  if(delta.state?.current==='complete') {
    const [item]=await chrome.downloads.search({id:delta.id});
    await update({state:'complete',status:'Download complete',path:item.filename,folder:item.filename.replace(/[\\/][^\\/]+$/,''),progress:100});
    busy=false;await notify();
  } else if(delta.state?.current==='interrupted') {
    busy=false;
    if(delta.error?.current==='USER_CANCELED'||cancelled) {
      await update({state:'cancelled',status:'Download cancelled.',progress:null});
    } else {
      await run(job.tabId,'stream');
    }
  }
});
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
      run(message.tabId,message.mode).catch(error=>update({state:'error',status:error.message}));
      return {ok:true};
    }
    if(message.action==='status')return {job:await status()};
    if(message.action==='reveal'){await reveal();return {ok:true};}
    if(message.action==='cancel') {
      cancelled=true;
      if(job?.downloadId!==undefined)await chrome.downloads.cancel(job.downloadId);
      else if(port) {await update({state:'cancelling',status:'Cancelling download…'});port.postMessage({action:'cancel'});}
      return {ok:true};
    }
    return {error:'Unsupported action.'};
  })().then(reply).catch(error=>reply({error:error.message}));
  return true;
});
