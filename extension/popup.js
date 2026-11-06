const status = document.querySelector('#status');
const progress = document.querySelector('#progress');
document.querySelector('#extension-id').textContent = chrome.runtime.id;
function render(job) {
  if (!job) return;
  status.textContent = job.status + (job.path ? '\n' + job.path : '');
  progress.hidden = !Number.isFinite(job.progress);
  if (!progress.hidden) progress.value = job.progress;
}
render((await chrome.storage.session.get('job')).job);
chrome.storage.onChanged.addListener((changes, area) => {if(area==='session') render(changes.job?.newValue);});
for (const [id, mode] of [['download','auto'],['stream','stream']]) {
  document.getElementById(id).addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      status.textContent = 'Reading this video…';
      const response = await chrome.runtime.sendMessage({action:'download',tabId:tab.id,mode});
      if (response?.error) status.textContent = response.error;
    } catch {status.textContent = 'Could not start the download. Reload the extension and try again.';}
  });
}
