export function allowedUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password &&
      ['sharepoint.com', 'svc.ms', 'microsoftstream.com'].some(d => u.hostname.endsWith('.' + d));
  } catch { return false; }
}
export function filename(value) {
  const name = String(value || 'SharePoint video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 150) || 'SharePoint video';
  return /\.(mp4|mkv|webm|mov|m4v)$/i.test(name) ? name : name + '.mp4';
}
