const MAX_LOG_LINES = 150;
const VOLUME_DEBOUNCE_MS = 120;

let isPlaying = false;
let isBuffering = false;
let startedAt = null;
let timerHandle = null;
let showLog = false;
let logLines = []; // { time: ISOString, level: 'info'|'warn'|'error', source: 'popup'|'background'|'offscreen', msg }
let logLevelFilter = 'all';
let volumeDebounceHandle = null;
let sleepTimerEndsAt = null;
let sleepTimerHandle = null;

const playBtn = document.getElementById('playBtn');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const iconLoading = document.getElementById('iconLoading');
const infoValue = document.getElementById('infoValue');
const nowPlayingEl = document.getElementById('nowPlaying');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const liveTimer = document.getElementById('liveTimer');
const volumeSlider = document.getElementById('volumeSlider');
const volValue = document.getElementById('volValue');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const logToolbar = document.getElementById('logToolbar');
const logLevelFilterEl = document.getElementById('logLevelFilter');
const logCount = document.getElementById('logCount');
const logPanel = document.getElementById('logPanel');
const logToggle = document.getElementById('logToggle');
const clearLog = document.getElementById('clearLog');
const sleepTimerSelect = document.getElementById('sleepTimerSelect');
const sleepTimerRemainingRow = document.getElementById('sleepTimerRemainingRow');
const sleepTimerRemaining = document.getElementById('sleepTimerRemaining');
const resumeToggle = document.getElementById('resumeToggle');
const versionLabel = document.getElementById('versionLabel');
const copyDiagnostics = document.getElementById('copyDiagnostics');
const dnrWarningEl = document.getElementById('dnrWarning');
const muteBtn = document.getElementById('muteBtn');
const shortcutLink = document.getElementById('shortcutLink');
const totalListenLabel = document.getElementById('totalListenLabel');

let volumeBeforeMute = null;

/* Log
   Entries carry a real level (info/warn/error) and a source (popup /
   background / offscreen) instead of a single freeform "type" string, so
   the panel below can render them as proper aligned, color-coded rows and
   filter by severity - the point being that when something actually goes
   wrong, it's easy to spot in amongst routine chatter instead of scrolling
   through a flat wall of undifferentiated text. */
function log(msg, level, source) {
  const entry = { time: new Date().toISOString(), level: level || 'info', source: source || 'popup', msg };
  logLines.push(entry);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (showLog) renderLog();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderLogLine(l) {
  const level = (l.level || 'info').toLowerCase();
  const timeStr = typeof l.time === 'string' ? l.time.substr(11, 8) : '';
  const badge = level === 'error' ? 'ERR' : level === 'warn' ? 'WARN' : 'INFO';
  return '<div class="log-line log-' + level + '">' +
    '<span class="log-time">' + escapeHtml(timeStr) + '</span>' +
    '<span class="log-badge">' + badge + '</span>' +
    '<span class="log-source">' + escapeHtml(l.source || '') + '</span>' +
    '<span class="log-msg">' + escapeHtml(l.msg) + '</span>' +
    '</div>';
}

function renderLog() {
  const filtered = logLevelFilter === 'all'
    ? logLines
    : logLines.filter(l => (l.level || 'info') === logLevelFilter);

  logPanel.innerHTML = filtered.length
    ? filtered.map(renderLogLine).join('')
    : '<div class="log-empty">No ' + (logLevelFilter === 'all' ? '' : logLevelFilter + ' ') + 'log entries yet.</div>';

  logCount.textContent = filtered.length === logLines.length
    ? logLines.length + ' entries'
    : filtered.length + ' / ' + logLines.length;

  logPanel.scrollTop = logPanel.scrollHeight;
}

/* Timer */
function startTimer() {
  if (timerHandle) return; // already ticking - don't stack intervals on repeated 'playing' updates
  timerHandle = setInterval(() => {
    if (!startedAt) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    liveTimer.textContent = (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(sec);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
  liveTimer.textContent = '';
}

function pad(n) { return String(n).padStart(2, '0'); }

/* Sleep timer countdown display */
function applySleepTimer(endsAt) {
  sleepTimerEndsAt = endsAt || null;
  clearInterval(sleepTimerHandle);
  sleepTimerHandle = null;

  if (!sleepTimerEndsAt) {
    sleepTimerRemainingRow.style.display = 'none';
    return;
  }

  sleepTimerRemainingRow.style.display = 'flex';
  const tick = () => {
    const remainingMs = sleepTimerEndsAt - Date.now();
    if (remainingMs <= 0) {
      sleepTimerRemainingRow.style.display = 'none';
      clearInterval(sleepTimerHandle);
      sleepTimerHandle = null;
      return;
    }
    const total = Math.ceil(remainingMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    sleepTimerRemaining.textContent = pad(m) + ':' + pad(s);
  };
  tick();
  sleepTimerHandle = setInterval(tick, 1000);
}

/* Now-playing metadata - only shown when the stream actually sends ID3 tags
   for the current track (see offscreen.js's handleID3Metadata); otherwise
   this stays hidden and the "On Air" label above speaks for itself. */
function updateNowPlaying(text) {
  if (!nowPlayingEl) return;
  if (text) {
    nowPlayingEl.textContent = text;
    nowPlayingEl.title = text; // full text on hover, since long titles get ellipsis-truncated
    nowPlayingEl.style.display = 'block';
  } else {
    nowPlayingEl.style.display = 'none';
  }
}

/* DNR health warning - a standing banner, not tied to play/buffering/error
   state, since "the header rule is disabled" can be true regardless of
   whether playback happens to be running right now. */
function updateDnrWarning(message) {
  if (!dnrWarningEl) return;
  if (message) {
    dnrWarningEl.textContent = message;
    dnrWarningEl.style.display = 'block';
  } else {
    dnrWarningEl.style.display = 'none';
  }
}

function formatListenDuration(ms) {
  const totalMinutes = Math.floor((ms || 0) / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return m + 'm';
  return h + 'h ' + m + 'm';
}

function setMuteButtonState(muted) {
  if (!muteBtn) return;
  muteBtn.setAttribute('aria-pressed', String(!!muted));
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

/* UI state */
function setUIState(state, statusMessage) {
  if (state === 'playing') {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    playBtn.setAttribute('aria-label', 'Pause');
    statusDot.className = 'status-dot live';
    statusText.textContent = 'Live';
    infoValue.className = 'info-value live';
    infoValue.innerHTML = '<span class="live-dot"></span>On Air';

  } else if (state === 'buffering') {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'block';
    playBtn.classList.add('loading');
    playBtn.setAttribute('aria-label', 'Stop');
    statusDot.className = 'status-dot loading';
    statusText.textContent = statusMessage || 'Connecting...';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Loading...';

  } else if (state === 'stopped') {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    playBtn.setAttribute('aria-label', 'Play');
    statusDot.className = 'status-dot';
    statusText.textContent = 'Ready to play';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Stopped';
    stopTimer();
    applySleepTimer(null);

  } else if (state === 'error') {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    playBtn.setAttribute('aria-label', 'Play');
    statusDot.className = 'status-dot error';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Error - click to retry';
    stopTimer();
    applySleepTimer(null);
  }
}

function applyState(s) {
  isPlaying = s.isPlaying;
  isBuffering = s.isBuffering;
  startedAt = s.startedAt;

  if (s.isPlaying) {
    setUIState('playing');
    startTimer();
    applySleepTimer(s.sleepTimerEndsAt);
    updateNowPlaying(s.nowPlaying);
  } else if (s.isBuffering) {
    setUIState('buffering', s.statusMessage);
    updateNowPlaying(null);
  } else if (s.error) {
    statusText.textContent = s.error;
    setUIState('error');
    updateNowPlaying(null);
  } else {
    setUIState('stopped');
    updateNowPlaying(null);
  }
}

/* Sync state from background on popup open */
function syncState() {
  log('popup opened - syncing state from background');
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError) {
      log('GET_STATE error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    log('got state: playing=' + res.isPlaying + ' buffering=' + res.isBuffering + ' startedAt=' + res.startedAt);

    volumeSlider.value = Math.round(res.volume * 100);
    volValue.textContent = volumeSlider.value + '%';
    setMuteButtonState(res.volume === 0);

    const resumeOn = !!res.resumeOnLaunch;
    resumeToggle.classList.toggle('on', resumeOn);
    resumeToggle.setAttribute('aria-checked', String(resumeOn));

    updateDnrWarning(res.dnrWarning);
    if (totalListenLabel) totalListenLabel.textContent = formatListenDuration(res.totalListenMs);

    applyState(res);
  });

  // Pull the background page's rolling diagnostic log too, so the log panel
  // shows what happened even for events that occurred while the popup was
  // closed (e.g. a reconnect, or an auto-stop when Chrome was closed). Its
  // entries are already { time, level, source, msg } - same shape as this
  // file's own log() produces - so they merge in with no reformatting.
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.logs) return;
    logLines = res.logs.concat(logLines).slice(-MAX_LOG_LINES);
    if (showLog) renderLog();
  });
}

/* Listen for background push updates */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    const s = msg.state;
    log('state update: playing=' + s.isPlaying + ' buffering=' + s.isBuffering + ' error=' + s.error,
      s.error ? 'error' : 'info');
    updateDnrWarning(s.dnrWarning);
    applyState(s);
  }

  if (msg.type === 'LOG') {
    log(msg.msg, msg.level || 'info', 'offscreen');
  }
});

/* Play / stop */
function togglePlay() {
  if (isPlaying || isBuffering) {
    log('sending STOP');
    isPlaying = false;
    isBuffering = false;
    setUIState('stopped');
    chrome.runtime.sendMessage({ type: 'STOP' });
  } else {
    log('sending PLAY');
    setUIState('buffering');
    isBuffering = true;
    chrome.runtime.sendMessage({ type: 'PLAY' }, (res) => {
      if (chrome.runtime.lastError) {
        log('PLAY error: ' + chrome.runtime.lastError.message, 'error');
        setUIState('error');
        isBuffering = false;
        return;
      }
      if (!res.ok) {
        if (res.reason === 'already_playing') {
          log('already playing in another tab', 'warn');
          statusText.textContent = 'Already playing in another window';
          syncState();
        } else {
          log('PLAY failed: ' + res.reason, 'error');
          statusText.textContent = 'Failed: ' + res.reason;
          setUIState('error');
          isBuffering = false;
        }
      }
    });
  }
}

/* Volume - debounced so dragging the slider doesn't flood runtime messages */
volumeSlider.addEventListener('input', () => {
  const v = volumeSlider.value;
  volValue.textContent = v + '%';
  setMuteButtonState(Number(v) === 0);
  if (Number(v) > 0) volumeBeforeMute = null; // manual unmute via the slider itself
  clearTimeout(volumeDebounceHandle);
  volumeDebounceHandle = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'VOLUME', value: v / 100 });
  }, VOLUME_DEBOUNCE_MS);
});

/* Mute - remembers the pre-mute level so unmuting restores it exactly,
   rather than snapping to some fixed default. */
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    const current = Number(volumeSlider.value);
    let next;
    if (current > 0) {
      volumeBeforeMute = current;
      next = 0;
    } else {
      next = volumeBeforeMute != null && volumeBeforeMute > 0 ? volumeBeforeMute : 80;
      volumeBeforeMute = null;
    }
    volumeSlider.value = next;
    volValue.textContent = next + '%';
    setMuteButtonState(next === 0);
    log((next === 0 ? 'muted' : 'unmuted') + ' (volume ' + next + '%)');
    chrome.runtime.sendMessage({ type: 'VOLUME', value: next / 100 });
  });
}

/* Keyboard shortcut settings live in a Chrome-owned page this extension
   can't embed - link out to it instead of trying to reimplement a shortcut
   picker. chrome.tabs.create() doesn't require the "tabs" permission. */
if (shortcutLink) {
  shortcutLink.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(err =>
      log('could not open shortcuts page: ' + err.message, 'error')
    );
  });
}

/* Sleep timer */
sleepTimerSelect.addEventListener('change', () => {
  const minutes = Number(sleepTimerSelect.value);
  log('sleep timer set to ' + (minutes || 'off'));
  chrome.runtime.sendMessage({ type: 'SET_SLEEP_TIMER', minutes }, (res) => {
    if (chrome.runtime.lastError) {
      log('SET_SLEEP_TIMER error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (res) applySleepTimer(res.sleepTimerEndsAt);
  });
});

/* Resume on browser launch */
resumeToggle.addEventListener('click', () => {
  const newVal = resumeToggle.getAttribute('aria-checked') !== 'true';
  resumeToggle.classList.toggle('on', newVal);
  resumeToggle.setAttribute('aria-checked', String(newVal));
  log('resume-on-launch set to ' + newVal);
  chrome.runtime.sendMessage({ type: 'SET_RESUME_ON_LAUNCH', value: newVal });
});

/* Settings */
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('visible');
});

logToggle.addEventListener('click', () => {
  showLog = !showLog;
  logToggle.classList.toggle('on', showLog);
  logToggle.setAttribute('aria-checked', String(showLog));
  logToolbar.classList.toggle('visible', showLog);
  logPanel.classList.toggle('visible', showLog);
  if (showLog) renderLog();
});

logLevelFilterEl.addEventListener('change', () => {
  logLevelFilter = logLevelFilterEl.value;
  renderLog();
});

clearLog.addEventListener('click', () => {
  logLines = [];
  renderLog();
  log('log cleared');
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }).catch(() => { });
});

/* Copy diagnostics - a bug report is a lot more useful with the recent log
   attached than with "it stopped working, no idea why". Bundles the last 50
   entries plus a quick state snapshot into one block of text on the
   clipboard, so it's a one-click thing rather than screenshots of the log
   panel. */
if (copyDiagnostics) {
  copyDiagnostics.addEventListener('click', async () => {
    const lines = logLines.slice(-50).map(l =>
      '[' + String(l.time || '').substr(11, 8) + '] ' + (l.level || 'info').toUpperCase() +
      ' (' + (l.source || '') + ') ' + l.msg
    );
    const report = [
      'Radio Damascus diagnostics',
      'Version: ' + chrome.runtime.getManifest().version,
      'Captured: ' + new Date().toISOString(),
      'Playing: ' + isPlaying + ', Buffering: ' + isBuffering,
      '',
      '--- recent log (' + lines.length + ' entries) ---',
      ...lines,
    ].join('\n');

    const original = copyDiagnostics.textContent;
    try {
      await copyTextToClipboard(report);
      copyDiagnostics.textContent = 'Copied!';
    } catch (err) {
      log('copy diagnostics failed: ' + err.message, 'error');
      copyDiagnostics.textContent = 'Failed';
    }
    setTimeout(() => { copyDiagnostics.textContent = original; }, 1500);
  });
}

/* navigator.clipboard.writeText can throw in some extension-popup contexts
   even on a user gesture (permissions-policy quirks vary by Chrome version).
   Falls back to the old execCommand('copy') trick via a throwaway textarea
   rather than leaving "Copy diagnostics" silently broken on those setups. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      log('navigator.clipboard.writeText failed, falling back: ' + err.message, 'warn');
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand(copy) returned false');
  } finally {
    document.body.removeChild(textarea);
  }
}

playBtn.addEventListener('click', togglePlay);

/* Init */
if (versionLabel) versionLabel.textContent = chrome.runtime.getManifest().version;

syncState();
