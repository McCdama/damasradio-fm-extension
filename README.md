# Radio Damascus Chrome Extension

Unofficial Chrome extension for listening to Radio Damascus live stream.

> This is an unofficial, open-source project and is not affiliated with
> or endorsed by Radio Damascus or General Authority for Radio and Television(GART) or any other syrian offical institution.
> The stream and all related trademarks belong to their respective owners.

## Setup

1. Clone this repo
2. Add your own icons to `icons/` folder:
   - `icon16.png`
   - `icon48.png`  
   - `icon128.png`
   - `logo.svg`
3. Open `chrome://extensions`
4. Enable **Developer mode**
5. Click **Load unpacked** and select the folder

If you already have the extension loaded, click the reload icon (ↆ) on its
card in `chrome://extensions` after pulling changes - Chrome does not
auto-reload unpacked extensions from disk.

## Maintenance

Three small, dependency-free scripts under `scripts/` - worth running after
a change, before reloading the extension in Chrome to test by hand:

- `node scripts/check-manifest.js` cross-references `manifest.json`'s
  declared `permissions` against the `chrome.*` APIs actually called in
  `background.js`/`offscreen.js`/`popup.js`. A heuristic, not a real static
  analyzer, but it catches the two easy mistakes: a permission nothing uses
  any more, or an API call with no matching permission declared.
- `node scripts/check-version.js` checks that `manifest.json`'s version
  matches the top heading under this README's Changelog section. Exists
  because a hardcoded version string drifting out of sync already happened
  once by hand (see 3.3 below) - this catches the manifest/changelog half
  of that same mistake.
- `node scripts/smoke-test.js` runs `background.js`'s message handling and
  state machine (play/stop, sleep timer, the DNR health check, auto-stop on
  window close, the context menu) against a mocked `chrome.*` API - no
  browser needed. Not a substitute for testing in real Chrome (it can't
  touch `offscreen.js`, the actual stream, or the popup's DOM), but it
  formalizes the manual checks that were being run by hand while building
  this out, into something repeatable.

## Stream

The stream URL points to the official Radio Damascus broadcast server.
All audio content belongs to Radio Damascus.

## Changelog

### 3.7

- **Fixed:** playback stopped working because the station moved off its old
  HLS stream (`radiodamascus.ortas.live/.../playlist.m3u8`) to a plain audio
  stream at `https://stream.damasradio.fm/radio`. The extension now plays
  that URL directly through the `<audio>` element.
- **Removed:** the hls.js dependency (`hls.min.js`), which plain audio
  streams don't need. One less file to download during setup.
- **Removed:** now-playing ID3 metadata. That came from the HLS segments,
  which the new stream doesn't use.
- **Changed:** reconnects now rebuild the audio connection from scratch
  (with a cache-busting query string), and a stream the server closes
  (`ended`) triggers a reconnect instead of a silent stop.

### 3.6

One targeted fix, reported after real Chrome testing finally happened (the
first real-Chrome test pass since 3.1) - and it was a good one to catch:

- **Fixed:** dragging a tab (especially detaching one into a new window)
  could hang the entire browser while the radio was playing. Cause: the
  toolbar badge's "live" indicator blinked at 1Hz via a `setInterval`
  calling `chrome.action.setBadgeBackgroundColor()` once a second for the
  whole session. That's a recurring extension-to-browser-UI IPC call, and a
  tab-detach drag runs a mostly-exclusive native drag loop on the same UI
  thread Chrome uses to repaint the toolbar - the two colliding could hang
  the browser for the duration of the drag. The badge is now a static color
  while live, set once with no ongoing timer - same visual meaning, zero
  recurring IPC. Confirmed via the reporter: only reproduced while playing,
  and disabling the extension made it go away, which matched this being the
  only recurring background timer in the extension's own code.

### 3.5

Ten more, mostly safety nets and small polish this round - the codebase has
grown a lot over 3.2-3.5 without a real-Chrome test pass yet, so this batch
leans toward things that are cheap to verify rather than more surface area.

- **Added:** `scripts/smoke-test.js` - an automated regression test for
  `background.js`'s state machine (22 assertions across 5 scenarios: play/
  stop/metadata lifecycle, sleep timer, the DNR health check, auto-stop on
  window close, the context menu), run against a mocked `chrome.*` API.
- **Added:** `scripts/check-version.js` - catches manifest.json/README
  changelog version drift specifically (see Maintenance below).
- **Added:** a visible in-popup warning banner if the `declarativeNetRequest`
  header rule is ever found disabled (3.4 added the health check itself,
  but it only logged - a real occurrence of this would otherwise look like
  an unexplained, unfixable network error to anyone not reading the debug
  log).
- **Added:** a mute button next to the volume slider, remembering the
  pre-mute level so unmuting restores it exactly.
- **Added:** a "Keyboard shortcut" row in Settings linking straight to
  `chrome://extensions/shortcuts`, since the default shortcut is otherwise
  not discoverable or remappable from inside the extension itself.
- **Added:** a "Total listening time" stat in Settings, accumulated across
  sessions.
- **Improved:** the now-playing marquee text gets a `title` attribute, so a
  long, ellipsis-truncated song title is readable on hover.
- **Improved:** "Copy diagnostics" now falls back to the older
  `execCommand('copy')` approach if `navigator.clipboard.writeText` throws,
  instead of silently failing on Chrome versions/contexts where that can
  happen even on a genuine user gesture.

### 3.4

Ten more small improvements, focused on diagnosability and a couple of
genuinely useful extras.

- **Added:** the toolbar icon's tooltip now reflects live status - hover it
  to see "Live", "Connecting...", "Reconnecting...", "Error", or "Stopped"
  (plus the current track title when the stream provides one) without
  opening the popup.
- **Added:** right-click the toolbar icon for a one-click Play/Stop, no
  popup needed.
- **Added:** now-playing metadata. If the stream sends ID3 timed-metadata
  frames for the current track (many, but not all, live HLS streams do),
  the title now shows under "On Air" in the popup. This is best-effort and
  silent if the stream doesn't send any - verified against a synthetic ID3
  tag locally, but not confirmed against the live stream itself.
- **Added:** offline-aware reconnects. The offscreen document now listens
  for the browser's online/offline events and pauses retry attempts while
  genuinely offline instead of burning through the retry budget and landing
  on a permanent error a few seconds after the network drops - it resumes
  immediately once connectivity is back.
- **Added:** a startup health check confirming the `declarativeNetRequest`
  rule that sets the stream's Referer/Origin headers is actually enabled.
  If it's ever silently disabled (a Chrome policy, a corrupted ruleset), an
  unambiguous error now lands in the log instead of a generic, confusing
  network failure with no clue why.
- **Added:** a "Copy diagnostics" button in Settings - bundles the version,
  a state snapshot, and the last 50 log entries into one block of text on
  the clipboard, for reporting an issue without screenshotting the log
  panel.
- **Added:** `scripts/check-manifest.js`, a small permission-hygiene check
  (see Maintenance below).

### 3.3

Small-feature and polish pass, on top of the 3.2 stability work.

- **Added:** sleep timer (Off / 15 / 30 / 45 / 60 min) in Settings - stops
  playback automatically via a `chrome.alarms` one-shot, with a live
  countdown shown in the popup.
- **Added:** a play/pause keyboard shortcut (`Ctrl+Shift+Y` / `⌘+Shift+Y` on
  Mac, remappable in `chrome://extensions/shortcuts`) that works without
  opening the popup.
- **Added:** "Resume on browser launch" toggle in Settings - if playback was
  intentionally left running, the stream can restart automatically the next
  time Chrome starts (tied to an actual cold launch, not to routine
  service-worker recycling, so it never fights a manual stop).
- **Added:** a desktop notification when playback ultimately gives up after
  exhausting reconnect attempts - useful since this is meant to be listened
  to in the background, not watched in the popup.
- **Added:** dark mode support in the popup, following the OS/browser color
  scheme automatically (`prefers-color-scheme`) - no manual toggle to keep
  in sync.
- **Improved:** accessibility - the play, settings, and toggle controls now
  have proper `aria-label`/`role="switch"` semantics for screen readers, and
  the volume slider is labeled.
- **Fixed:** the version number shown in Settings is now read live from
  `manifest.json` instead of being a separately hand-typed string that could
  (and did) drift out of sync with the actual version.

### 3.2

Root-cause pass on two reports: the browser getting sluggish after a few
minutes of playback, and the stream still being audible after closing
Chrome entirely.

- **Fixed:** audio no longer keeps playing after Chrome is closed. The
  offscreen document (and its `<audio>` element) has no relationship to any
  browser window, so it happily played on after every window closed -
  which, combined with Chrome's "continue running background apps" setting,
  could keep Chrome itself running headless just to host it. The background
  worker now listens for the last window closing and stops playback the
  moment that happens.
- **Fixed:** a race in offscreen-document creation. Two near-simultaneous
  `PLAY` requests (e.g. a quick double click, or a click landing while a
  resync was still in flight) could both see "no document yet" and both call
  `chrome.offscreen.createDocument()` - the loser threw and left the UI
  stuck on "buffering". Creation is now serialized behind a single in-flight
  promise.
- **Fixed:** repeated `MEDIA_ERROR` recovery no longer loops indefinitely.
  Calling `hls.recoverMediaError()` over and over without a clean recovery
  in between is a known way for hls.js's internal buffer/fragment state to
  accumulate cruft over a long session. After two soft recoveries in a row
  fail, the player is torn down and rebuilt from scratch instead.
- **Added:** a stall watchdog. Some live-edge gaps in the stream never fire
  a `waiting`/`stalled` DOM event - playback just silently stops advancing.
  The offscreen document now polls `audio.currentTime` and forces a recovery
  if it's been frozen for 20+ seconds while supposedly playing.
- **Improved:** reconnect backoff is now exponential with jitter (capped at
  20s) instead of a flat linear ramp, so retries spread out instead of
  hammering the origin in lockstep.
- **Improved:** low-latency HLS mode is now off. The stream is a regular
  live playlist (no `#EXT-X-PART` tags), so `lowLatencyMode` was paying for
  internal timers/heuristics the stream never uses.
- **Improved:** live-playlist reloads (`LEVEL_LOADED`) are now logged once
  up front and then every 10th reload instead of every single one - on an
  hours-long session that's a meaningful cut in background↔offscreen
  message traffic for no loss of useful signal.
- **Added:** a rolling diagnostic log (last 200 entries, tagged with a
  level: info/warn/error) kept in `chrome.storage.local` on the background
  side. The popup pulls this history in on open, so the log panel shows what
  happened even for events that fired while the popup was closed - which is
  exactly when a lag spike or an unexpected stop tends to happen.
- **Added:** a one-minute watchdog alarm that cross-checks "we think we're
  playing" against what the offscreen document actually reports, and logs a
  warning on mismatch - diagnostic signal for tracking down any future
  "went quiet"/"got slow" reports without having to reproduce them live.
- **Added:** global `error`/`unhandledrejection` handlers in both the
  background worker and the offscreen document, so a bug that used to fail
  silently now at least leaves a trace in the log.

### 3.1

Fixes and stability work after reports of the extension lagging during long
listening sessions and throwing spurious errors on stop:

- **Fixed:** clicking Stop no longer surfaces a fake playback error. The
  offscreen player used to fire a real `error` event on the `<audio>`
  element while releasing it (clearing `src` + calling `load()`), and that
  event was still wired up to report failures back to the popup. Stopping
  is now tracked explicitly and listeners are detached before teardown.
- **Fixed:** the "lags after a few minutes" issue - the toolbar icon was
  redrawn on three canvases 20 times per second for as long as the stream
  played, to produce a pulsing dot. That's been replaced with a 1Hz badge
  color pulse (native, no canvas work), cutting that overhead by ~20x.
- **Improved:** HLS parsing now runs on a worker thread (`enableWorker:
  true`) instead of blocking the offscreen document's main thread, which
  also helps long sessions stay smooth.
- **Added:** automatic reconnect with backoff. Transient network or media
  errors from the stream no longer kill playback outright - the extension
  retries a few times (with a visible "Reconnecting..." status) before
  giving up and showing an error.
- **Added:** friendlier error messages instead of raw `code=2 ...` output.
- **Added:** playback state now survives the background service worker
  being recycled (uses `chrome.storage.session`), and the last volume is
  remembered across browser restarts (`chrome.storage.local`).
- **Improved:** the volume slider is now debounced instead of sending a
  message on every pixel of drag.

## Disclaimer

This project is for personal use only. The developer makes no claim over
any audio content, logos, or trademarks belonging to Radio Damascus.

## License

MIT - source code only. Does not cover stream content or station assets.
