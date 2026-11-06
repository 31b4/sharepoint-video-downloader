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
