import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).parents[1] / 'native/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class HostTests(unittest.TestCase):
    def test_framing(self):
        payload = json.dumps({'action': 'download'}).encode()
        self.assertEqual(host.read_message(io.BytesIO(struct.pack('=I', len(payload)) + payload)), {'action': 'download'})
        for invalid in (b'\x01', struct.pack('=I', 9999999), struct.pack('=I', 4) + b'{}'):
            with self.assertRaises(ValueError):
                host.read_message(io.BytesIO(invalid))
    def test_reject_untrusted_urls(self):
        for url in ('https://localhost/a', 'file:///a', 'https://tenant.sharepoint.com.evil/a', 'https://user:pass@tenant.sharepoint.com/a', 'https://tenant.sharepoint.com:8080/a', None):
            self.assertFalse(host.valid_url(url))
        self.assertTrue(host.valid_url('https://tenant.sharepoint.com/a?token=abc'))
    def test_output_template(self):
        self.assertEqual(host.safe_title('../100% Workshop.mp4'), '_100%% Workshop')
    def test_invalid_request_never_launches_process(self):
        with patch.object(host.subprocess, 'Popen') as process:
            with self.assertRaises(ValueError):
                host.download({'action':'download', 'url':'https://localhost/a'})
            process.assert_not_called()

if __name__ == '__main__':
    unittest.main()

class DownloadLifecycleTests(unittest.TestCase):
    def setUp(self):
        host.cancelled.clear()
        host.active_process = None
    def tearDown(self):
        host.cancelled.clear()
        host.active_process = None
    def fake_download(self, lines, exit_code=0):
        import tempfile
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'Downloads' / 'SharePoint Videos'
            output.mkdir(parents=True)
            saved = output / 'Workshop.mp4'
            saved.write_bytes(b'video-fixture')
            process = MagicMock()
            process.stdout = [line.replace('OUTPUT', str(saved)) for line in lines]
            process.wait.return_value = exit_code
            process.poll.return_value = exit_code
            messages = []
            with patch.object(host.Path, 'home', return_value=root), patch.object(host, 'executable', side_effect=lambda name:'/bin/'+name), patch.object(host.subprocess, 'Popen', return_value=process) as launch, patch.object(host, 'send', side_effect=messages.append), patch.object(host, 'validate_video', return_value={'duration': 100}):
                try:
                    host.download({'action':'download','url':'https://tenant.sharepoint.com/manifest?secret=private','title':'Workshop'})
                except host.DownloadError as error:
                    return messages, error.code
                command = launch.call_args.args[0]
                self.assertNotIn('https://tenant.sharepoint.com/manifest?secret=private', command)
                self.assertIn('--abort-on-unavailable-fragments', command)
            return messages, None
    def test_progress_never_restarts_and_completion_contains_location(self):
        messages, error = self.fake_download(['PROGRESS:video|h264|90%\n','PROGRESS:video|h264|100%\n','PROGRESS:audio|none|5%\n','PROGRESS:audio|none|100%\n','[Merger] Merging formats\n','FILE:OUTPUT\n'])
        self.assertIsNone(error)
        values = [message['progress'] for message in messages if 'progress' in message]
        self.assertEqual(values, sorted(values))
        self.assertEqual(messages[-1]['state'], 'complete')
        self.assertTrue(messages[-1]['folder'].endswith('SharePoint Videos'))
        self.assertTrue(messages[-1]['path'].endswith('Workshop.mp4'))
    def test_authentication_failure_is_classified_for_automatic_refresh(self):
        messages, code = self.fake_download(['ERROR: HTTP Error 403: Forbidden\n'], 1)
        self.assertEqual(code, 'AUTH_EXPIRED')
        self.assertFalse(any(m.get('state') == 'complete' for m in messages))
    def test_cancel_never_reports_success(self):
        host.cancelled.set()
        messages, error = self.fake_download(['FILE:OUTPUT\n'])
        self.assertEqual(messages[-1]['state'], 'cancelled')
    def test_reveal_rejects_paths_outside_the_download_directory(self):
        with patch.object(host.subprocess, 'run') as launch:
            with self.assertRaises(ValueError):
                host.reveal('/etc/hosts')
            launch.assert_not_called()
    def test_reveal_selects_the_actual_saved_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            saved = root / 'Downloads/SharePoint Videos/Workshop.mp4'
            saved.parent.mkdir(parents=True)
            saved.write_bytes(b'video')
            with patch.object(host.Path,'home',return_value=root), patch.object(host.sys,'platform','darwin'), patch.object(host.subprocess,'run') as launch, patch.object(host,'send'):
                host.reveal(str(saved))
                self.assertEqual(launch.call_args.args[0],['open','-R',str(saved.resolve())])


class MediaValidationTests(unittest.TestCase):
    def test_json_response_cannot_be_reported_as_a_video(self):
        from types import SimpleNamespace
        result = SimpleNamespace(returncode=1, stdout='{}')
        with patch.object(host, 'executable', return_value='/bin/ffprobe'), patch.object(host.subprocess, 'run', return_value=result):
            with self.assertRaises(host.DownloadError) as error:
                host.validate_video(Path('/example/response.json'))
            self.assertEqual(error.exception.code, 'INVALID_MEDIA')
    def test_valid_video_reports_duration(self):
        from types import SimpleNamespace
        result = SimpleNamespace(returncode=0, stdout=json.dumps({'streams':[{'codec_type':'video'}], 'format':{'duration':'123.4'}}))
        with patch.object(host, 'executable', return_value='/bin/ffprobe'), patch.object(host.subprocess, 'run', return_value=result):
            self.assertEqual(host.validate_video(Path('/example/video.mp4')), {'duration':123.4})
