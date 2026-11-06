import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedUrl, filename} from '../extension/core.js';
test('only supported HTTPS destinations are accepted', () => {
  assert.equal(allowedUrl('https://tenant.sharepoint.com/video'), true);
  for (const url of ['http://tenant.sharepoint.com/a','https://sharepoint.com.evil.test/a','file:///etc/passwd','https://localhost/a','https://a:b@tenant.sharepoint.com/a']) {
    assert.equal(allowedUrl(url), false, url);
  }
});
test('filenames cannot escape the downloads folder', () => {
  assert.equal(filename('../../video'), '_.._video.mp4');
  assert.equal(filename('Workshop.mp4'), 'Workshop.mp4');
  assert.equal(filename(''), 'SharePoint video.mp4');
});
