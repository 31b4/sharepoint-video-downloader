export function allowedUrl(value) {
  try {
    const u = new URL(value);
    return !/[\x00-\x1f]/.test(value) && (u.port === '' || u.port === '443') && u.protocol === 'https:' && !u.username && !u.password &&
      ['sharepoint.com', 'svc.ms', 'microsoftstream.com'].some(d => u.hostname.endsWith('.' + d));
  } catch { return false; }
}
export function filename(value) {
  const name = String(value || 'SharePoint video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 150) || 'SharePoint video';
  return /\.(mp4|mkv|webm|mov|m4v)$/i.test(name) ? name : name + '.mp4';
}
export function expiresSoon(value, now = Date.now()) {
  try {
    const manifest = new URL(value);
    const docid = manifest.searchParams.get('docid');
    const target = docid ? new URL(docid) : manifest;
    const expiry = Number(target.searchParams.get('P1'));
    return expiry > 0 && expiry * 1000 < now + 60000;
  } catch {return false;}
}
