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
import signal
import threading
import time
import tempfile
from urllib.parse import urlsplit

MAX_MESSAGE = 128 * 1024
cancelled = threading.Event()
active_process = None
job_context = {}

class DownloadError(ValueError):
    def __init__(self, message, code='DOWNLOAD_FAILED'):
        super().__init__(message)
        self.code = code

def stop_download():
    cancelled.set()
    process = active_process
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass



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


def send(message, persist=True):
    # Keep only the latest local status, never the source URL.
    message = {**job_context, **message, 'updatedAt': int(time.time() * 1000)}
    status_file = Path(__file__).with_name('last-status.json')
    try:
        if persist:
            temp_status = status_file.with_name(f'.status-{os.getpid()}.tmp')
            fd = os.open(temp_status, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as status_stream:
                json.dump({**message, 'pid': os.getpid()}, status_stream)
            os.replace(temp_status, status_file)
    except OSError:
        pass
    payload = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()


def valid_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        return (not any(ord(c) < 32 for c in value) and parsed.scheme == 'https' and not parsed.username and not parsed.password
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
    global active_process, job_context
    if not isinstance(message, dict) or message.get('action') != 'download' or not valid_url(message.get('url')):
        raise ValueError('Unsupported download request')
    job_context = {'jobId': str(message.get('jobId', ''))[:64], 'sourceKey': message.get('sourceKey') if re.fullmatch('[0-9a-f]{64}', str(message.get('sourceKey', ''))) else None, 'title': str(message.get('title', 'SharePoint video'))[:200]}
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
                   '--no-warnings', '--abort-on-unavailable-fragments', '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--ffmpeg-location', ffmpeg, '--concurrent-fragments', '4',
                   '--merge-output-format', 'mp4', '--remux-video', 'mp4',
                   '--progress-template', 'download:PROGRESS:%(info.format_id)s|%(info.vcodec)s|%(progress._percent_str)s',
                   '--print', 'after_move:FILE:%(filepath)s', '--progress',
                   '--output', str(output / (title + '.%(ext)s')), '--batch-file', str(batch)]
        send({'state': 'downloading', 'status': 'Downloading video…', 'progress': 0})
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors='replace', start_new_session=True)
        active_process = process
        if cancelled.is_set():
            stop_download()
        completed = None
        authentication_failed = False
        current_format = None
        track = 0
        overall = 0
        try:
            for line in process.stdout:
                if 'HTTP Error 401' in line or 'HTTP Error 403' in line:
                    authentication_failed = True
                if line.startswith('PROGRESS:'):
                    values = line[len('PROGRESS:'):].strip().split('|')
                    match = re.search(r'([\d.]+)%', values[-1])
                    if match and len(values) == 3:
                        format_id, codec, _ = values
                        if current_format is not None and format_id != current_format:
                            track += 1
                        current_format = format_id
                        percent = min(100, max(0, float(match[1])))
                        overall = max(overall, min(98, track * 49 + percent * .49))
                        kind = 'audio' if codec == 'none' else 'video'
                        send({'state': 'downloading', 'status': f'Downloading {kind} · {percent:.0f}% of this track', 'progress': overall})
                elif line.startswith('FILE:'):
                    completed = Path(line[5:].strip())
                elif '[Merger]' in line or '[VideoRemuxer]' in line:
                    send({'state': 'merging', 'status': 'Combining audio and video…', 'progress': 99})
            exit_code = process.wait()
            if cancelled.is_set():
                send({'state': 'cancelled', 'status': 'Download cancelled. Partial files can be resumed on retry.'})
                return
            if exit_code != 0:
                if authentication_failed:
                    raise DownloadError('SharePoint rejected the video link. Refreshing may be required.', 'AUTH_EXPIRED')
                raise DownloadError('The download could not finish. Check your connection and retry; partial files will resume.')
            if not completed or not completed.is_file() or completed.stat().st_size == 0:
                raise ValueError('The download finished without a video file.')
            details = validate_video(completed)
            send({**details, 'state': 'complete', 'status': 'Download complete', 'progress': 100, 'path': str(completed), 'folder': str(completed.parent), 'size': completed.stat().st_size})
        finally:
            active_process = None
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def validate_video(path):
    result = subprocess.run([executable('ffprobe'), '-v', 'error', '-select_streams', 'v:0',
                             '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', str(path)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30)
    try:
        metadata = json.loads(result.stdout)
        if result.returncode or not any(stream.get('codec_type') == 'video' for stream in metadata.get('streams', [])):
            raise ValueError('No video stream')
        duration = float(metadata.get('format', {}).get('duration', 0))
        if duration <= 0:
            raise ValueError('Missing video duration')
        return {'duration': duration}
    except (ValueError, TypeError, AttributeError):
        raise DownloadError('The server response was not a playable video. No video was marked complete.', 'INVALID_MEDIA')


def reveal(path):
    if not isinstance(path, str):
        raise ValueError('Missing saved file')
    saved = Path(path).resolve()
    root = (Path.home() / 'Downloads' / 'SharePoint Videos').resolve()
    if not saved.is_relative_to(root) or not saved.is_file():
        raise ValueError('Saved file not found in the download folder')
    command = ['open', '-R', str(saved)] if sys.platform == 'darwin' else ['xdg-open', str(saved.parent)]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    send({'state': 'revealed', 'status': 'Opened the saved file location.'}, persist=False)


def get_status():
    status_file = Path(__file__).with_name('last-status.json')
    if not status_file.exists():
        send({'state': 'idle', 'status': 'Ready to download.'}, persist=False)
        return
    saved = json.loads(status_file.read_text())
    saved.setdefault('updatedAt', int(status_file.stat().st_mtime * 1000))
    if saved.get('status') == 'Download complete' and saved.get('path'):
        saved.update(state='complete', folder=str(Path(saved['path']).parent))
    if saved.get('state') in ('downloading', 'merging'):
        try:
            os.kill(saved.get('pid', -1), 0)
        except (ProcessLookupError, PermissionError):
            saved.update(state='error', status='The previous download was interrupted. Retry to resume it.', progress=None)
    # Preserve the timestamp of the original job for extension result reconciliation.
    payload = json.dumps(saved).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()


def watch_controls():
    try:
        while True:
            message = read_message(sys.stdin.buffer)
            if message is None or message.get('action') == 'cancel':
                stop_download()
                return
    except (ValueError, OSError):
        stop_download()


def main():
    action = None
    try:
        message = read_message(sys.stdin.buffer)
        if not isinstance(message, dict):
            return
        action = message.get('action')
        if action == 'status':
            get_status()
        elif action == 'reveal':
            reveal(message.get('path'))
        elif action == 'download':
            threading.Thread(target=watch_controls, daemon=True).start()
            download(message)
        else:
            raise ValueError('Unsupported action')
    except DownloadError as error:
        send({'state': 'error', 'code': error.code, 'status': str(error)})
    except ValueError as error:
        send({'state': 'error', 'status': str(error) if str(error).startswith(('Install ', 'The download finished')) else 'The saved file or download request is invalid.'}, persist=action == 'download')
    except BrokenPipeError:
        stop_download()
    except (OSError, subprocess.SubprocessError):
        send({'state': 'error', 'status': 'The local helper could not finish. Check dependencies and retry.'}, persist=action == 'download')


if __name__ == '__main__':
    main()
