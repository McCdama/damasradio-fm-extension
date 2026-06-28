const MAX_LOG_LINES = 100;

let isPlaying = false;
let isBuffering = false;
let startedAt = null;
let timerHandle = null;
let showLog = false;
let logLines = [];

const playBtn = document.getElementById('playBtn');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const iconLoading = document.getElementById('iconLoading');
const infoValue = document.getElementById('infoValue');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const liveTimer = document.getElementById('liveTimer');
const volumeSlider = document.getElementById('volumeSlider');
const volValue = document.getElementById('volValue');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const logPanel = document.getElementById('logPanel');
const logToggle = document.getElementById('logToggle');
const clearLog = document.getElementById('clearLog');

/* Log */
function log(msg, type) {
  const time = new Date().toISOString().substr(11, 8);
  const line = '[' + time + '] ' + msg;
  logLines.push({ line, type: type || 'info' });
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (showLog) renderLog();
}

function renderLog() {
  logPanel.innerHTML = logLines.map(l =>
    '<div class="log-line ' + (l.type || '') + '">' + l.line + '</div>'
  ).join('');
  logPanel.scrollTop = logPanel.scrollHeight;
}

/* Timer */
function startTimer() {
  stopTimer();
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

/* UI state */
function setUIState(state) {
  if (state === 'playing') {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    statusDot.className = 'status-dot live';
    statusText.textContent = 'Live';
    infoValue.className = 'info-value live';
    infoValue.innerHTML = '<span class="live-dot"></span>On Air';

  } else if (state === 'buffering') {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'block';
    playBtn.classList.add('loading');
    statusDot.className = 'status-dot loading';
    statusText.textContent = 'Connecting...';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Loading...';

  } else if (state === 'stopped') {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    statusDot.className = 'status-dot';
    statusText.textContent = 'Ready to play';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Stopped';
    stopTimer();

  } else if (state === 'error') {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'none';
    playBtn.classList.remove('loading');
    statusDot.className = 'status-dot error';
    infoValue.className = 'info-value';
    infoValue.textContent = 'Error - click to retry';
    stopTimer();
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
    isPlaying = res.isPlaying;
    isBuffering = res.isBuffering;
    startedAt = res.startedAt;

    volumeSlider.value = Math.round(res.volume * 100);
    volValue.textContent = volumeSlider.value + '%';

    if (res.isPlaying) {
      setUIState('playing');
      startTimer();
    } else if (res.isBuffering) {
      setUIState('buffering');
    } else if (res.error) {
      statusText.textContent = res.error;
      setUIState('error');
    } else {
      setUIState('stopped');
    }
  });
}

/* Listen for background push updates */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    const s = msg.state;
    log('state update: playing=' + s.isPlaying + ' buffering=' + s.isBuffering + ' error=' + s.error, 'event');
    isPlaying = s.isPlaying;
    isBuffering = s.isBuffering;
    startedAt = s.startedAt;

    if (s.isPlaying) {
      setUIState('playing');
      startTimer();
    } else if (s.isBuffering) {
      setUIState('buffering');
    } else if (s.error) {
      statusText.textContent = 'Error: ' + s.error;
      setUIState('error');
    } else {
      setUIState('stopped');
    }
  }

  if (msg.type === 'LOG') {
    log('[bg] ' + msg.msg, 'event');
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
          log('already playing in another tab', 'error');
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

/* Volume */
volumeSlider.addEventListener('input', () => {
  const v = volumeSlider.value;
  volValue.textContent = v + '%';
  chrome.runtime.sendMessage({ type: 'VOLUME', value: v / 100 });
});

/* Settings */
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('visible');
});

logToggle.addEventListener('click', () => {
  showLog = !showLog;
  logToggle.classList.toggle('on', showLog);
  logPanel.classList.toggle('visible', showLog);
  if (showLog) renderLog();
});

clearLog.addEventListener('click', () => {
  logLines = [];
  logPanel.innerHTML = '';
  log('log cleared');
});

playBtn.addEventListener('click', togglePlay);

/* Init */
syncState();