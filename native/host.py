#!/usr/bin/env python3
"""Local Chrome native-messaging host. No web server, telemetry, or saved tokens."""
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

MAX_MESSAGE = 128 * 1024


def read_exact(stream, count):
    value = bytearray()
    while len(value) < count:
        chunk = stream.read(count - len(value))
        if not chunk:
            raise ValueError('Incomplete browser message')
        value.extend(chunk)
    return bytes(value)


def read_message(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError('Invalid message header')
    length = struct.unpack('=I', header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError('Browser message too large')
    return json.loads(read_exact(stream, length))


def send(message):
    payload = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()


def valid_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        return (parsed.scheme == 'https' and not parsed.username and not parsed.password
                and parsed.port in (None, 443)
                and any(host.endswith('.' + domain) for domain in
                        ('sharepoint.com', 'svc.ms', 'microsoftstream.com')))
    except (ValueError, TypeError, AttributeError):
        return False


def safe_title(value):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(value))
    name = re.sub(r'\.(mp4|mkv|webm|mov|m4v)$', '', name, flags=re.I)
    # yt-dlp interprets percent signs in its output template.
    return name.strip('. ')[:150].replace('%', '%%') or 'SharePoint video'


def executable(name):
    for directory in ('/opt/homebrew/bin', '/usr/local/bin'):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    candidate = shutil.which(name)
    if not candidate:
        raise ValueError(f'Install {name} before using the streaming helper.')
    return candidate


def download(message):
    if not isinstance(message, dict) or message.get('action') != 'download' or not valid_url(message.get('url')):
        raise ValueError('Unsupported download request')
    ytdlp, ffmpeg = executable('yt-dlp'), executable('ffmpeg')
    output = Path.home() / 'Downloads' / 'SharePoint Videos'
    output.mkdir(parents=True, exist_ok=True)
    title = safe_title(message.get('title', 'SharePoint video'))
    # Use a private temporary batch file so signed URLs do not appear in process arguments.
    with tempfile.TemporaryDirectory(prefix='sharepoint-download-') as temp:
        batch = Path(temp) / 'input.txt'
        fd = os.open(batch, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            url = message['url']
            if '\n' in url or '\r' in url:
                raise ValueError('Invalid URL')
            stream.write(url + '\n')
        command = [ytdlp, '--ignore-config', '--no-playlist', '--no-overwrites', '--newline',
                   '--no-warnings', '--ffmpeg-location', ffmpeg, '--concurrent-fragments', '4',
                   '--merge-output-format', 'mp4', '--remux-video', 'mp4',
                   '--progress-template', 'download:PROGRESS:%(progress._percent_str)s',
                   '--print', 'after_move:FILE:%(filepath)s', '--progress',
                   '--output', str(output / (title + '.%(ext)s')), '--batch-file', str(batch)]
        send({'status': 'Downloading video…', 'progress': 0})
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        completed = None
        try:
            for line in process.stdout:
                if line.startswith('PROGRESS:'):
                    match = re.search(r'([\d.]+)%', line)
                    if match:
                        send({'status': 'Downloading video and audio…', 'progress': float(match[1])})
                elif line.startswith('FILE:'):
                    completed = Path(line[5:].strip())
                elif '[Merger]' in line or '[VideoRemuxer]' in line:
                    send({'status': 'Combining audio and video…'})
            if process.wait() != 0:
                raise ValueError('Download failed. Reload the SharePoint video and retry. Its link may have expired or access may be restricted.')
            if not completed or not completed.is_file() or completed.stat().st_size == 0:
                raise ValueError('The download finished without a video file.')
            send({'status': 'Download complete', 'progress': 100, 'path': str(completed)})
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    try:
        message = read_message(sys.stdin.buffer)
        if message is not None:
            download(message)
    except (ValueError, OSError, json.JSONDecodeError):
        # Never include exception details: upstream messages can contain signed URLs.
        send({'status': 'Download failed. Check helper dependencies, reload the video, and retry.'})


if __name__ == '__main__':
    main()
