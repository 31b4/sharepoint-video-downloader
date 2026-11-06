import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedUrl, filename} from '../extension/core.js';
test('only supported HTTPS destinations are accepted', () => {
  assert.equal(allowedUrl('https://tenant.sharepoint.com/video'), true);
  for (const url of ['http://tenant.sharepoint.com/a','https://sharepoint.com.evil.test/a','https://tenant.sharepoint.com:8080/a','file:///etc/passwd','https://localhost/a','https://a:b@tenant.sharepoint.com/a']) {
    assert.equal(allowedUrl(url), false, url);
  }
});
test('filenames cannot escape the downloads folder', () => {
  assert.equal(filename('../../video'), '_.._video.mp4');
  assert.equal(filename('Workshop.mp4'), 'Workshop.mp4');
  assert.equal(filename(''), 'SharePoint video.mp4');
});

test('expired nested SharePoint signatures are detected without changing the URL', async () => {
  const {expiresSoon}=await import('../extension/core.js');
  const now=1700000000000;
  const manifest='https://media.svc.ms/transform/videomanifest?docid='+encodeURIComponent('https://tenant.sharepoint.com/item?P1=1699999999&P4=secret');
  assert.equal(expiresSoon(manifest,now),true);
  assert.equal(expiresSoon('https://media.svc.ms/manifest?P1=1700001000',now),false);
  assert.equal(expiresSoon('not a url',now),false);
});
