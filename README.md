# SharePoint Video Downloader

A local-first Chrome/Edge extension for saving videos from your signed-in SharePoint browser session. A small optional helper handles DASH streams with yt-dlp and FFmpeg.

**Early release (0.2.0).** Validated end to end on macOS with Chrome: a private SharePoint DASH recording downloaded and merged into a 1080p MP4 with AAC audio. Other tenants and browsers still need validation. It is not published in the Chrome Web Store.

## Why an extension and a helper?

The extension works across desktop operating systems. When SharePoint supplies a usable original-file URL, Chrome can download it without a separate app. For segmented streams, this version uses a local helper to download and combine audio/video reliably. There is no desktop dashboard or Java runtime.

| Component | Support |
| --- | --- |
| Extension | Chrome / Edge Manifest V3; cross-platform design, not yet validated on every OS |
| Streaming helper | macOS and Linux installer; requires Python 3, yt-dlp, FFmpeg |
| Windows helper | Not packaged yet |
| Firefox / Safari | Not supported yet |

## Install on macOS

1. Clone or download this repository into a permanent folder.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory.
3. Open your SharePoint video and click the extension. **Download video** tries an original-file URL first; when no URL is available, it uses the helper. **Download stream with helper** explicitly selects streaming.

For streaming, install dependencies:

```sh
brew install python yt-dlp ffmpeg
```

Copy your extension ID from its Chrome extensions card or the popup’s **Local helper setup**, then run:

```sh
python3 native/install.py YOUR_EXTENSION_ID
```

For Edge, append `--browser edge`. The installer registers a host for that extension ID only. No administrator access is required. Reload the video and choose **Download stream with helper**.

Streaming downloads are saved to `~/Downloads/SharePoint Videos`. Browser downloads use Chrome’s Save dialog. The completed popup shows the exact folder and filename; click either the folder path or **Show in Finder** to reveal the file.

Keep Chrome running until completion. You can close and reopen the popup while downloading. The toolbar badge shows progress, and the final result remains available after the helper exits. The helper handles one streaming job at a time. **Cancel download** stops the transfer; retry can resume partial files.

Choose **Enable completion notifications** in the popup once to allow notifications. Completion notifications can open the saved file’s folder. Delivery also depends on Chrome and your operating system’s notification settings.

## Automatic recovery

- Expired signed video links are detected before downloading where their expiry is available.
- A rejected stream link triggers one automatic SharePoint refresh and retry. Playback position is restored where the player permits it. No DevTools or manual network inspection is required.
- If a browser download fails, the extension automatically attempts the local streaming helper. Cancelling a Save dialog or download does not trigger a retry.
- Other failures produce a clear retry message. Permission restrictions and sign-in requirements cannot be repaired automatically.
- Progress stays monotonic across audio and video transfers, then shows a separate combining stage. Terminal success/error messages are preserved after normal helper exit.

## Updating an unpacked installation

Update the repository files, rerun the helper installer with your extension ID, and click **Reload** on the extension at `chrome://extensions`. This is required because an already-running Chrome service worker keeps its old code until the extension reloads.

## Linux

Install Python 3, yt-dlp and FFmpeg using your package manager, load the extension, and run the same helper installer. Native-host registration targets Google Chrome or Microsoft Edge, not Chromium-specific package layouts.

## Privacy and permissions

- Runs only when you click Download on the active SharePoint tab; no background browsing monitoring.
- Uses `activeTab` and `scripting` to inspect the current video page; `downloads` to save files; `nativeMessaging` for the optional local helper; `storage.session` for job status; optional `notifications` for completion alerts. The helper also keeps a local `last-status.json` with the latest status and completed file path, never the source URL.
- No analytics, project backend, cookie export, password collection, or persistent signed-URL storage.
- SharePoint metadata and media requests go to Microsoft’s servers. The helper receives the single selected stream URL and never opens a local HTTP server.
- The helper writes the signed URL into a private temporary file for yt-dlp, removes it after completion, and suppresses raw tool output that could contain credentials. Partial media files may remain after failure.
- Never post signed URLs, access tokens, browser exports, or private recordings in issues.

## Limitations and troubleshooting

- Access to a video does not guarantee download access. This tool does not implement DRM decryption or change SharePoint permissions.
- Microsoft’s player metadata (`g_fileInfo`) is an undocumented integration point and can change.
- Browser download failures fall back to the streaming helper; stream authorization errors refresh the page and retry once. If the retry still fails, check your SharePoint sign-in and helper dependencies. Some tenant policies or authentication flows are unsupported.
- Microsoft has announced changes to pre-authenticated download URLs beginning April 1, 2027. An explicit Entra/OAuth integration may become necessary; this prototype does not implement it.
- Overall progress allocates stages to audio/video transfers; the status text also shows the current track’s percentage. Completion is reported only after a nonempty output file exists. Unavailable fragments fail the job rather than silently yielding a partial recording.

## Uninstall

Remove the extension in Chrome. Remove native-host registration with:

```sh
python3 native/install.py YOUR_EXTENSION_ID --uninstall
```

Add `--browser edge` if applicable. This preserves helper files and downloaded videos. The helper files live in `~/Library/Application Support/SharePoint Video Downloader` on macOS and `~/.local/share/sharepoint-video-downloader` on Linux.

## Development

No build step or JavaScript dependencies are required. Load `extension/` directly and reload it after edits.

```sh
npm test
```

Tests cover URL restrictions, filename sanitization, native-message framing, expired-link retry limits, cancellation, Chrome download tracking, progress continuity, terminal-status recovery, completion notifications, and file reveal restrictions. Automated mocks do not prove compatibility with every live SharePoint tenant.

## Acknowledgment and license

Inspired by the architecture of [Sherif-Moheep/SharePointVideoDownloader](https://github.com/Sherif-Moheep/SharePointVideoDownloader), which is GPL-3.0 licensed. This repository is a fresh implementation; it does not copy or bundle that project's source, assets, or Windows binaries. Licensed under MIT.

Technical references: [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads), [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Microsoft file downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0), and [the announced authentication migration](https://devblogs.microsoft.com/microsoft365dev/pre-authenticated-tempauth-urls-are-retiring-move-to-microsoft-entra-id-tokens-before-april-1-2027/).
