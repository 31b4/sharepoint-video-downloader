# SharePoint Video Downloader

A local-first Chrome/Edge extension for saving videos from your signed-in SharePoint browser session. A small optional helper handles DASH streams with yt-dlp and FFmpeg.

**Early prototype (0.1.0).** Automated checks pass; real SharePoint tenants and browsers still need end-to-end validation. It is not published in the Chrome Web Store.

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

Downloads are saved to `~/Downloads/SharePoint Videos`. Keep Chrome running until completion. The popup can be closed and reopened to inspect progress. The helper currently handles one streaming job at a time and does not provide a cancel button; interrupted partial downloads may remain and yt-dlp can resume them.

## Linux

Install Python 3, yt-dlp and FFmpeg using your package manager, load the extension, and run the same helper installer. Native-host registration targets Google Chrome or Microsoft Edge, not Chromium-specific package layouts.

## Privacy and permissions

- Runs only when you click Download on the active SharePoint tab; no background browsing monitoring.
- Uses `activeTab` and `scripting` to inspect the current video page; `downloads` to save files; `nativeMessaging` for the optional local helper; `storage.session` for job status.
- No analytics, project backend, cookie export, password collection, or persistent signed-URL storage.
- SharePoint metadata and media requests go to Microsoft’s servers. The helper receives the single selected stream URL and never opens a local HTTP server.
- The helper writes the signed URL into a private temporary file for yt-dlp, removes it after completion, and suppresses raw tool output that could contain credentials. Partial media files may remain after failure.
- Never post signed URLs, access tokens, browser exports, or private recordings in issues.

## Limitations and troubleshooting

- Access to a video does not guarantee download access. This tool does not implement DRM decryption or change SharePoint permissions.
- Microsoft’s player metadata (`g_fileInfo`) is an undocumented integration point and can change.
- If the browser download fails, try the streaming button. If streaming fails, reload the video to obtain a fresh link and check that yt-dlp/FFmpeg are installed. Some tenant policies or authentication flows are unsupported.
- Microsoft has announced changes to pre-authenticated download URLs beginning April 1, 2027. An explicit Entra/OAuth integration may become necessary; this prototype does not implement it.
- Streaming percentage refers to the current audio/video transfer and can reset between tracks. Completion is reported only after a nonempty output file exists.

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

Tests cover URL restrictions, filename sanitization, native-message framing, and rejection before process launch. They do not prove compatibility with a live SharePoint tenant.

## Acknowledgment and license

Inspired by the architecture of [Sherif-Moheep/SharePointVideoDownloader](https://github.com/Sherif-Moheep/SharePointVideoDownloader), which is GPL-3.0 licensed. This repository is a fresh implementation; it does not copy or bundle that project's source, assets, or Windows binaries. Licensed under MIT.

Technical references: [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads), [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Microsoft file downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0), and [the announced authentication migration](https://devblogs.microsoft.com/microsoft365dev/pre-authenticated-tempauth-urls-are-retiring-move-to-microsoft-entra-id-tokens-before-april-1-2027/).
