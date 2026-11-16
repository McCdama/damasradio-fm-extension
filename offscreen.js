const STREAM_URL = 'https://stream.damasradio.fm/radio';

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1500;
const RETRY_MAX_DELAY_MS = 20000;

/* Some stalls never fire a 'waiting'/'stalled' DOM event - the stream just
   silently stops advancing. This watchdog polls audio.currentTime and forces
   a reconnect if it's frozen for too long while we believe playback is active. */
const STALL_WATCHDOG_INTERVAL_MS = 5000;
const STALL_THRESHOLD_MS = 20000;

let audio = null;
let stopping = false;
let retryCount = 0;
let retryTimer = null;
let currentVolume = 0.8;

let stallWatchdogTimer = null;
let lastCurrentTime = 0;
let lastProgressAt = 0;

/* Network-aware retries: pause retries while offline instead of burning
   through MAX_RETRIES, and pick back up immediately when 'online' fires. */
let isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

function send(event, detail, level) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_EVENT', event, detail, level }).catch(() => { });
}

function log(msg, level) {
    send('LOG', msg, level);
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
    consoleFn('[offscreen]', msg);
}

function clearRetryTimer() {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}

/* Named handlers so they can be reliably removed before releasing the audio
   element (otherwise clearing src during a stop fires a spurious 'error'). */
function onPlaying() {
    log('event: playing');
    retryCount = 0;
    send('PLAYING');
}

function onWaiting() {
    log('event: waiting');
    send('BUFFERING');
}

function onStalled() {
    log('event: stalled');
    send('STALLED');
}

function onAudioError() {
    if (stopping) {
        log('ignoring audio error event during intentional stop');
        return;
    }
    const code = audio?.error?.code;
    log('event: error code=' + code, 'error');
    scheduleRetry(friendlyMediaError(code), reconnect);
}

function onEnded() {
    if (stopping) return;
    log('event: ended (live stream closed by server)', 'warn');
    scheduleRetry('Stream ended', reconnect);
}

function scheduleRetry(reason, action) {
    if (stopping) return;
    if (isOffline) {
        log('offline - deferring retry until network returns: ' + reason, 'warn');
        send('RECONNECTING', 'Waiting for network...');
        return; // the 'online' listener below re-kicks playback once connectivity is back
    }
    retryCount++;
    if (retryCount > MAX_RETRIES) {
        handleFatalFailure(reason + ' - giving up after ' + MAX_RETRIES + ' attempts');
        return;
    }
    // Exponential backoff with a little jitter.
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1), RETRY_MAX_DELAY_MS)
        + Math.floor(Math.random() * 500);
    log('retry ' + retryCount + '/' + MAX_RETRIES + ' in ' + delay + 'ms: ' + reason, 'warn');
    send('RECONNECTING', 'Reconnecting (' + retryCount + '/' + MAX_RETRIES + ')...');
    clearRetryTimer();
    retryTimer = setTimeout(() => {
        if (stopping) return;
        action();
    }, delay);
}

function handleFatalFailure(message) {
    send('ERROR', message, 'error');
    teardown();
}

function friendlyMediaError(code) {
    switch (code) {
        case 1: return 'Playback was aborted';
        case 2: return 'Network error while loading the stream';
        case 3: return 'Audio decoding error';
        case 4: return 'Stream format not supported';
        default: return 'Unknown playback error';
    }
}

function startStallWatchdog() {
    stopStallWatchdog();
    lastCurrentTime = 0;
    lastProgressAt = Date.now();
    stallWatchdogTimer = setInterval(() => {
        if (!audio || stopping || audio.paused) return;

        if (audio.currentTime !== lastCurrentTime) {
            lastCurrentTime = audio.currentTime;
            lastProgressAt = Date.now();
            return;
        }

        const stuckForMs = Date.now() - lastProgressAt;
        if (stuckForMs > STALL_THRESHOLD_MS) {
            log('watchdog: audio time frozen for ' + Math.round(stuckForMs / 1000) + 's - forcing reconnect', 'warn');
            lastProgressAt = Date.now(); // don't re-fire every tick while reconnect is in flight
            scheduleRetry('Stream froze', reconnect);
        }
    }, STALL_WATCHDOG_INTERVAL_MS);
}

function stopStallWatchdog() {
    if (stallWatchdogTimer) {
        clearInterval(stallWatchdogTimer);
        stallWatchdogTimer = null;
    }
}

function teardown() {
    clearRetryTimer();
    stopStallWatchdog();

    if (audio) {
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('waiting', onWaiting);
        audio.removeEventListener('stalled', onStalled);
        audio.removeEventListener('error', onAudioError);
        audio.removeEventListener('ended', onEnded);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio = null;
        log('audio element released');
    }
}

function startPlayback(volume) {
    stopping = false;
    retryCount = 0;
    currentVolume = volume ?? 0.8;
    connect();
}

function reconnect() {
    if (audio) currentVolume = audio.volume;
    connect();
}

function connect() {
    teardown();

    log('creating audio element');
    audio = new Audio();
    audio.volume = currentVolume;

    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('stalled', onStalled);
    audio.addEventListener('error', onAudioError);
    audio.addEventListener('ended', onEnded);

    // Cache-buster so a reconnect never reuses a dead connection.
    audio.src = STREAM_URL + '?t=' + Date.now();
    log('loading source: ' + audio.src);

    audio.play()
        .then(() => log('play() resolved'))
        .catch(err => {
            if (stopping) return;
            log('play() rejected: ' + err.message, 'error');
            scheduleRetry('Could not start playback', reconnect);
        });

    startStallWatchdog();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    log('received: ' + msg.type);

    switch (msg.type) {

        case 'OFFSCREEN_PLAY':
            startPlayback(msg.volume);
            return false;

        case 'OFFSCREEN_STOP':
            log('stopping (user requested)');
            stopping = true;
            teardown();
            return false;

        case 'OFFSCREEN_VOLUME':
            currentVolume = msg.value;
            if (audio) {
                audio.volume = msg.value;
                log('volume set to ' + msg.value);
            }
            return false;

        case 'OFFSCREEN_STATUS_QUERY':
            sendResponse({ playing: !!(audio && !audio.paused && !audio.ended) });
            return false;
    }
});

self.addEventListener('error', (e) => {
    log('uncaught error: ' + (e.message || e), 'error');
});
self.addEventListener('unhandledrejection', (e) => {
    log('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason), 'error');
});

if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => {
        isOffline = true;
        log('network went offline - pausing reconnect attempts', 'warn');
        clearRetryTimer();
        if (!stopping) send('RECONNECTING', 'Waiting for network...');
    });

    window.addEventListener('online', () => {
        if (!isOffline) return;
        isOffline = false;
        log('network back online');
        if (!stopping && audio) {
            clearRetryTimer();
            retryCount = 0;
            reconnect();
        }
    });
}

log('offscreen.js loaded');