# LyricsZen for YouTube Music™

A distraction-free, full-screen, typography-focused lyrics and karaoke view for [music.youtube.com](https://music.youtube.com). **LyricsZen** provides a clean, cinematic overlay that shows the current song's synchronized lyrics while YouTube Music's native player continues playing underneath, completely untouched.

## Install (unpacked, for testing/development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the extension folder (containing `manifest.json`).
4. Open [music.youtube.com](https://music.youtube.com) and play a song.

## Usage

- Click the floating **♪ LyricsZen** launcher in the bottom-right corner,
- Click the extension icon in the toolbar and press **Open LyricsZen**, or
- Press **Ctrl+Shift+L** (**Cmd+Shift+L** on macOS).
- Press the same shortcut again, click the **×** in the top right, or press **Esc** to exit.
- Click the **gear icon** (top right, next to exit) to customize: font family, font size, accent color, and visualizer.
- Exiting restores YouTube Music exactly as it was — nothing is deleted or permanently modified.

## Architecture

```
youtube-music-lyrics/
├── manifest.json              # MV3 manifest
├── src/
│   ├── background.js          # Relays the keyboard shortcut to the content script
│   ├── content.js             # Wires everything together; owns on/off lifecycle
│   ├── lyrics/
│   │   ├── lyrics-provider.js # Lyrics source (LRCLIB — see below)
│   │   ├── lyrics-engine.js   # Fetch orchestration + per-song caching
│   │   └── lyrics-sync.js     # Maps playback time -> active lyric line
│   ├── youtube-music/
│   │   ├── player.js          # Thin wrapper around YTM's existing <video> element
│   │   └── navigation.js      # SPA route/song-change detection (event-driven)
│   └── ui/
│       ├── lyrics-overlay.js  # Builds/controls the full-screen UI + settings panel (Shadow DOM)
│       └── lyrics.css         # Overlay styling (scoped to the Shadow DOM)
├── popup/
│   ├── popup.html / .css / .js
└── icons/
```

Each `src/` file attaches its exports to a single shared `window.YTMLyrics` namespace object (e.g. `window.YTMLyrics.Player`) instead of using ES module `import`/`export`, since MV3 content scripts listed in the manifest are loaded as plain, non-module scripts. Files are loaded in dependency order via the `content_scripts.js` array in `manifest.json`.

### Design choices worth knowing about

- **No second player.** The extension never creates its own audio/video element. `player.js` finds YouTube Music's existing `<video>` element and only reads its state (`currentTime`, `duration`, `paused`) and calls `play()` / `pause()` / sets `currentTime` on it directly.
- **Overlay, not DOM surgery.** Lyrics Mode is a single `position: fixed`, full-viewport `<div>` (with its own Shadow DOM) appended to `<html>` and removed on exit. It visually covers YouTube Music's header/sidebar/artwork/etc. rather than hiding or restructuring YTM's own elements — this makes on/off fully reversible and avoids breaking if YTM's internal markup changes elsewhere on the page. The one non-Shadow-DOM change made to the host page is a single inert `<style>` rule (`html.ytm-lyrics-mode-active { overflow: hidden }`) that only takes effect while a marker class is present, and is removed in effect the instant that class is removed.
- **No polling, no runaway observers.** Song and playback state come from native `<video>` events (`play`, `pause`, `timeupdate`, `durationchange`, `loadedmetadata`). SPA navigation (back/forward, song changes via the queue, etc.) is detected via YouTube's own `yt-navigate-finish` document event — no `setInterval`, no unscoped `MutationObserver`.
- **Listener lifecycle.** `Player` only attaches listeners to the `<video>` element while Lyrics Mode is active (`ensureAttached()` on activate, `detach()` on deactivate), so the extension has effectively zero footprint on the page when the feature is off.

### Lyrics Engine & Multi-Source Fallback Pipeline

LyricsZen uses a prioritized multi-tier pipeline configured to find the best available lyrics with clear precedence:

1. **YouTube-Provided Time-Synced Lyrics (1st Priority)**:
   - Inspects YouTube Music's active page for timed lyrics line elements (`ytmusic-timed-lyrics-line-renderer`, `[data-start-time]`, `.lyrics-line`).
   - Scans Polymer/Lit web component data structures for `timedLyricsData` / `timedLyricsRenderer`.
   - Checks HTML5 `<video>` `textTracks` for embedded timed captions / subtitle cues.
   - Triggers YouTube Music's "Lyrics" tab in the background if unselected to check if YouTube provides timed lyrics for the track.
   - **If YouTube provides time-synced lyrics, they are selected immediately.**
2. **External Time-Synced Sources — LRCLIB (2nd Priority)**:
   - If YouTube time-synced lyrics are not available, queries [LRCLIB](https://lrclib.net) across 4 search strategies:
     - Exact metadata match (`GET /api/get?track_name=...&artist_name=...&duration=...`)
     - Field search (`GET /api/search?track_name=...&artist_name=...`)
     - Full-text query (`GET /api/search?q=title+artist`)
     - Title-only query (`GET /api/search?q=title`)
   - **If any tier yields synchronized LRC lyrics (`syncedLyrics`), they are selected immediately.**
3. **Static / Plain Lyrics Wherever Available (3rd Priority)**:
   - If no source provides time-synced lyrics, LyricsZen displays static plain lyrics from the first available provider:
     - **YouTube Music Static Card**: Extracted from YouTube's native lyrics card and cleansed of footer credits (`Source: LyricFind`, `Musixmatch`, `Writer(s):`).
     - **LRCLIB Static Text**: Plain lyrics returned from LRCLIB searches.
     - **Lyrics.ovh Open API**: Keyless REST API (`/v1/{artist}/{title}`) covering millions of tracks.
     - **YouTube Video Description Shelf**: Parses artist-provided lyrics blocks (`Lyrics: ...`) from the description.
4. **Graceful Degradation**:
   - If no source has lyrics, renders a clean "Lyrics unavailable for this song" message without crashing or interrupting playback.

### Display settings

The gear icon in Lyrics Mode opens a small panel (`lyrics-overlay.js`) with:

- **Font** — Serif (default), Sans, Rounded, Mono.
- **Text size** — 16–36px, adjustable via − / + (default 22px).
- **Color** — White (default), Warm, Yellow, Blue, Green, Pink.

Settings are applied as CSS custom properties (`--ytm-lyrics-font-family`, `--ytm-lyrics-font-size`, `--ytm-lyrics-color-rgb`) on the overlay root and persisted via `chrome.storage.local` (requires the `storage` permission, already included), so they carry over between sessions and songs.

## Known limitations

- **Match quality depends on LRCLIB's catalog.** Very obscure tracks, remixes, or live versions may not have an entry; the UI falls back to "Lyrics unavailable" in that case rather than guessing.
- **DOM selectors can drift.** `player.js` reads the song title/artist from `ytmusic-player-bar .title` / `.byline`. YouTube Music doesn't publish a stable API for this; if Google changes that markup, metadata parsing (not playback) may need a selector update.
- **Single-tab scope.** Lyrics Mode is per-tab. Playing music in multiple `music.youtube.com` tabs means each tab manages its own overlay independently.
- **Keyboard shortcut can be remapped/conflict.** Chrome lets the user or other extensions reassign `Ctrl/Cmd+Shift+L` in `chrome://extensions/shortcuts`; the in-app popup button always works regardless.

## Testing performed

This build was validated with static and logic-level checks in a sandboxed environment without a Chrome browser or network access, specifically:

- `manifest.json` parses as valid JSON and every path it references exists.
- Every JavaScript file passes `node --check` (syntax validation).
- Cross-file consistency: every method called on `player`/`overlay`/`sync`/`engine` in `content.js` exists on the corresponding class; every UI event emitted by the overlay (`exit`, `togglePlay`, `seekToTime`, `seekProgress`) has a matching handler in `content.js`; the `YTM_LYRICS_*` message types sent by the popup/background match what `content.js` listens for.
- `lyrics-sync.js`'s active-line cursor logic (forward playback, backward seeks, forward jumps, reset) was unit-tested against a synthetic timeline in Node.
- `lyrics-engine.js`'s caching, status classification (`synced`/`plain`/`unavailable`), and error handling were unit-tested against fake providers (including one that throws) in Node.
- `player.js`'s metadata parsing (title/artist/video ID extraction and trimming), attach/detach idempotency, play/pause pass-through, and `seekTo` clamping were unit-tested against a hand-built fake `<video>`/DOM in Node.

**What was *not* tested:** actual runtime behavior inside Chrome against the live `music.youtube.com` page, or live network calls to LRCLIB — this sandbox has no browser and no network access. The Shadow DOM overlay UI and settings panel in particular rely on real `innerHTML` parsing, `attachShadow`, `chrome.storage`, and CSS rendering that couldn't be exercised outside a real browser, so they received careful manual code review but not automated execution.

**Please run through this checklist yourself after loading the extension**, and let me know if anything doesn't hold up so it can be fixed:

1. Popup opens and shows the correct state for the current tab.
2. Lyrics Mode activates on a playing song.
3. YouTube Music playback continues uninterrupted.
4. Play/pause stays synchronized in both directions (overlay button ↔ YTM's own controls).
5. Progress bar and elapsed/total time stay synchronized.
6. Lyrics fetch and display correctly for a well-known song (synced, scrolling, highlighting); try an obscure/live track to confirm the "unavailable" fallback also looks right.
7. Gear icon opens the settings panel; font, size, and color changes apply immediately to the lyric lines.
8. Reload the page (or reopen Lyrics Mode) and confirm the last-chosen font/size/color persisted.
9. Changing songs (including via the queue) updates the overlay without a page refresh.
10. Refreshing the page while Lyrics Mode is on behaves sensibly (overlay does not persist across a hard refresh by design — it's a runtime UI, not a page mode you're "in" persistently; reactivate via the shortcut or popup).
11. Browser back/forward navigation doesn't break metadata sync.
12. Exiting fully restores YouTube Music, with no leftover DOM nodes, styles, or console errors.
13. No duplicate overlays if you toggle rapidly.
14. No extension-related console errors during normal use.
