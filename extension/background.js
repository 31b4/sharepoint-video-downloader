import {allowedUrl, filename} from './core.js';
let port;
let busy = false;
const update = state => chrome.storage.session.set({job: state});

// This function runs only after a user clicks Download on a SharePoint tab.
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
          // Request metadata using the existing SharePoint session.
          item.search = '';
          const response = await fetch(item, {credentials: 'same-origin', headers: {Accept:'application/json'}});
          if (response.ok) {
            const metadata = await response.json();
            direct ||= metadata['@microsoft.graph.downloadUrl'] || metadata['@content.downloadUrl'];
          }
        }
      }
      manifest.pathname = manifest.pathname.replace(/\/transform\/[^/]*$/, '/transform/videomanifest');
      manifest.searchParams.set('part', 'index');
      manifest.searchParams.set('format', 'dash');
      // Preserve every authentication parameter; never truncate at format=dash.
      transform = manifest.href;
    } catch { transform = null; }
  }
  if (!direct) {
    const media = document.querySelector('video');
    if (media && /^https:/.test(media.currentSrc)) direct = media.currentSrc;
  }
  return {title, direct, manifest: transform};
}

async function start(tabId, mode) {
  if (busy) throw new Error('A streaming download is already running.');
  const tab = await chrome.tabs.get(tabId);
  if (!allowedUrl(tab.url) || !new URL(tab.url).hostname.endsWith('.sharepoint.com')) {
    throw new Error('Open the SharePoint video, then click this extension on that tab.');
  }
  const results = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectPage});
  const media = results[0]?.result;
  if (!media) throw new Error('Could not read the video. Reload the page and play it first.');
  if (mode !== 'stream' && media.direct && allowedUrl(media.direct)) {
    await chrome.downloads.download({url:media.direct,filename:filename(media.title),saveAs:true});
    await update({status:'Browser download started. Track it in Chrome Downloads.'});
    return;
  }
  if (!allowedUrl(media.manifest)) throw new Error('No supported stream found. Play the video and try again.');
  busy = true;
  await update({status:'Connecting to local helper…'});
  port = chrome.runtime.connectNative('io.github.sharepoint_video_downloader');
  port.onMessage.addListener(message => {
    const status = String(message.status || 'Working…').slice(0, 300);
    update({status,progress:message.progress,path:message.path});
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    busy = false;
    port = null;
    if (error) update({status:'Helper disconnected. Install the helper using the extension ID below, then retry.'});
  });
  port.postMessage({action:'download',url:media.manifest,title:filename(media.title)});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.action !== 'download') return;
  start(message.tabId, message.mode).then(() => reply({ok:true})).catch(error => {
    update({status:error.message}); reply({ok:false,error:error.message});
  });
  return true;
});
