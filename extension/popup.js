import {currentView} from './core.js';
const $=selector=>document.querySelector(selector);
const active=new Set(['reading','refreshing','connecting','downloading','merging','cancelling']);
const labels={idle:'Ready to download',reading:'Finding video',refreshing:'Refreshing video link',connecting:'Connecting',downloading:'Downloading',merging:'Finishing your video',complete:'Download complete',error:'Needs attention',cancelled:'Download cancelled',cancelling:'Cancelling'};
$('#extension-id').textContent=chrome.runtime.id;
const platform=await chrome.runtime.getPlatformInfo();
$('#reveal').textContent=platform.os==='mac'?'Show in Finder':'Show in folder';
let context=null,job=null,savedVideo=null;
function render() {
  if(!context)return;
  const view=currentView(job,context.sourceKey,context.title);
  const running=active.has(job?.state);
  const other=job&&job.sourceKey!==context.sourceKey;
  document.body.dataset.state=view.state;
  $('#state-label').textContent=context.supported?(labels[view.state] || 'Ready to download'):'Open a SharePoint video';
  $('#status').textContent=!context.supported?'Select the SharePoint video tab, then reopen this popup.':other&&running?'Another video is downloading. Wait for it to finish or cancel it below.':view.status;
  $('#title').hidden=false;$('#title').textContent=view.title;
  $('#progress').hidden=!active.has(view.state);
  if(Number.isFinite(view.progress))$('#progress').value=view.progress;else $('#progress').removeAttribute('value');
  $('#percent').textContent=Number.isFinite(view.progress)&&active.has(view.state)?Math.floor(view.progress)+'%':'';
  $('#download').disabled=running||!context.supported;
  $('#download').textContent=view.state==='error'||view.state==='cancelled'?'↻ Retry this video':view.state==='complete'?'↓ Download this video again':'↓ Download this video';
  $('#cancel').hidden=!running||job.state==='cancelling';
  $('#cancel').textContent=other?'Cancel the running download':'Cancel download';
  $('#other-job').hidden=!other||!running;
  $('#other-title').textContent=job?.title || '';
  $('#other-status').textContent=(job?.status || '')+(Number.isFinite(job?.progress)?' · '+Math.floor(job.progress)+'%':'');
  $('#destination').hidden=!savedVideo?.path;
  $('#saved-title').textContent=savedVideo?.title || savedVideo?.path?.split(/[\\/]/).pop() || '';
  $('#folder-link').textContent=savedVideo?.folder || savedVideo?.path?.replace(/[\\/][^\\/]+$/,'') || '';
  $('#file-name').textContent=savedVideo?.path?.split(/[\\/]/).pop() || '';
}
async function request(message) {
  $('#feedback').hidden=true;
  const response=await chrome.runtime.sendMessage(message);
  if(response?.error)throw new Error(response.error);
  return response;
}
function failed(error){$('#feedback').textContent=error.message;$('#feedback').hidden=false;}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='session')return;
  if(changes.job)job=changes.job.newValue;
  if(changes.savedVideo)savedVideo=changes.savedVideo.newValue;
  render();
});
$('#download').disabled=true;
$('#status').textContent='Checking the current video…';
try {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  context=await request({action:'context',tabId:tab.id});
  context.tabId=tab.id;job=context.job;savedVideo=context.savedVideo;render();
} catch(error){failed(error);}
$('#download').addEventListener('click',async()=>{
  try {
    $('#download').disabled=true;
    await request({action:'download',tabId:context.tabId});
  } catch(error){failed(error);render();}
});
for(const id of ['reveal','folder-link'])$('#'+id).addEventListener('click',()=>request({action:'reveal'}).catch(failed));
$('#cancel').addEventListener('click',()=>request({action:'cancel'}).catch(failed));
$('#notifications').hidden=await chrome.permissions.contains({permissions:['notifications']});
$('#notifications').addEventListener('click',async()=>{
  try {if(await chrome.permissions.request({permissions:['notifications']}))$('#notifications').hidden=true;}catch(error){failed(error);}
});
