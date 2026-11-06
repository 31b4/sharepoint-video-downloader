#!/usr/bin/env python3
"""Register a user-local native host for one specific unpacked extension."""
import argparse
import json
from pathlib import Path
import re
import shlex
import shutil
import sys

NAME = 'io.github.sharepoint_video_downloader'
parser = argparse.ArgumentParser()
parser.add_argument('extension_id', help='ID shown at chrome://extensions')
parser.add_argument('--browser', choices=['chrome', 'edge'], default='chrome')
parser.add_argument('--uninstall', action='store_true')
args = parser.parse_args()
if not re.fullmatch('[a-p]{32}', args.extension_id):
    parser.error('The extension ID must contain 32 letters a–p.')
if sys.platform == 'darwin':
    vendor = 'Google/Chrome' if args.browser == 'chrome' else 'Microsoft Edge'
    registry = Path.home() / 'Library/Application Support' / vendor / 'NativeMessagingHosts'
    root = Path.home() / 'Library/Application Support/SharePoint Video Downloader'
elif sys.platform.startswith('linux'):
    vendor = 'google-chrome' if args.browser == 'chrome' else 'microsoft-edge'
    registry = Path.home() / '.config' / vendor / 'NativeMessagingHosts'
    root = Path.home() / '.local/share/sharepoint-video-downloader'
else:
    parser.error('The helper installer currently supports macOS and Linux. Windows packaging is planned.')
manifest = registry / (NAME + '.json')
if args.uninstall:
    manifest.unlink(missing_ok=True)
    print('Browser connection removed. Downloads and helper files were kept.')
    raise SystemExit
root.mkdir(parents=True, exist_ok=True)
registry.mkdir(parents=True, exist_ok=True)
host = root / 'host.py'
shutil.copyfile(Path(__file__).with_name('host.py'), host)
host.chmod(0o600)
launcher = root / 'launch.sh'
launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(host)) + ' "$@"\n')
launcher.chmod(0o700)
manifest.write_text(json.dumps({'name': NAME, 'description': 'Local SharePoint video streaming downloader',
                                'path': str(launcher), 'type': 'stdio',
                                'allowed_origins': [f'chrome-extension://{args.extension_id}/']}, indent=2))
manifest.chmod(0o600)
print('Helper installed. Open the video and choose Download stream with helper.')
