const $=selector=>document.querySelector(selector);
const active=new Set(['reading','refreshing','connecting','downloading','merging','cancelling']);
const labels={reading:'Finding video',refreshing:'Refreshing video link',connecting:'Connecting',downloading:'Downloading',merging:'Finishing your video',complete:'Download complete',error:'Needs attention',cancelled:'Download cancelled',cancelling:'Cancelling'};
$('#extension-id').textContent=chrome.runtime.id;
let platform=await chrome.runtime.getPlatformInfo();
$('#reveal').textContent=platform.os==='mac'?'Show in Finder':'Show in folder';
function render(job) {
  if(!job)return;
  document.body.dataset.state=job.state || 'idle';
  $('#state-label').textContent=labels[job.state] || 'Ready to download';
  $('#status').textContent=job.status || 'Ready to download.';
  $('#title').hidden=!job.title;$('#title').textContent=job.title || '';
  $('#progress').hidden=!active.has(job.state);
  if(Number.isFinite(job.progress))$('#progress').value=job.progress;else $('#progress').removeAttribute('value');
  $('#percent').textContent=Number.isFinite(job.progress)&&active.has(job.state)?Math.floor(job.progress)+'%':'';
  $('#download').disabled=active.has(job.state);
  $('#download').textContent=job.state==='error'||job.state==='cancelled'?'↻ Retry download':'↓ Download video';
  $('#stream').hidden=active.has(job.state);
  $('#cancel').hidden=!active.has(job.state)||job.state==='cancelling';
  $('#destination').hidden=job.state!=='complete'||!job.path;
  $('#folder-link').textContent=job.folder || job.path?.replace(/[\\/][^\\/]+$/,'') || '';
  $('#file-name').textContent=job.path?.split(/[\\/]/).pop() || '';
}
async function request(message) {
  $('#feedback').hidden=true;
  const response=await chrome.runtime.sendMessage(message);
  if(response?.error)throw new Error(response.error);
  return response;
}
function failed(error){$('#feedback').textContent=error.message;$('#feedback').hidden=false;}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.job)render(changes.job.newValue);});
render((await chrome.storage.session.get('job')).job);
request({action:'status'}).then(response=>render(response.job)).catch(()=>{});
for(const [id,mode] of [['download','auto'],['stream','stream']]) {
  $('#'+id).addEventListener('click',async()=>{
    try {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      await request({action:'download',tabId:tab.id,mode});
    } catch(error){failed(error);}
  });
}
for(const id of ['reveal','folder-link'])$('#'+id).addEventListener('click',()=>request({action:'reveal'}).catch(failed));
$('#cancel').addEventListener('click',()=>request({action:'cancel'}).catch(failed));
$('#notifications').hidden=await chrome.permissions.contains({permissions:['notifications']});
$('#notifications').addEventListener('click',async()=>{
  try {if(await chrome.permissions.request({permissions:['notifications']}))$('#notifications').hidden=true;}catch(error){failed(error);}
});
