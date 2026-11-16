const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

/* Badge colors used for the "live" indicator.
   Replaces the old per-frame OffscreenCanvas icon animation (redrew three
   full-size canvases 20x/second forever while playing - the original cause
   of the extension slowing down after a few minutes of playback). 3.2-3.5
   then used a 1Hz blink instead (alternating LIVE_COLOR/LIVE_COLOR_DIM via
   setInterval) - much cheaper than the canvas animation, but still a
   recurring chrome.action.*() IPC call into the browser UI process once a
   second for the whole session. That turned out to be enough to hang the
   browser if one landed while dragging a tab: detaching a tab into a new
   window runs a mostly-exclusive native drag loop on the same UI thread
   Chrome uses to repaint the toolbar badge, and the two collided. 3.6 drops
   the blink entirely - a static badge color set once when going live, no
   ongoing timer, same "something's happening" signal at zero ongoing cost. */
const LIVE_COLOR = '#891539';
const BUFFERING_COLOR = '#e09020';

const MAX_LOG_ENTRIES = 200;
const WATCHDOG_ALARM = 'radio-watchdog';
const WATCHDOG_PERIOD_MINUTES = 1;
const SLEEP_ALARM = 'radio-sleep-timer';
const CONTEXT_MENU_ID = 'radio-toggle-play';

/* State */
let state = {
    isPlaying: false,
    isBuffering: false,
    volume: 0.8,
    startedAt: null,
    error: null,
    statusMessage: null,
    sleepTimerEndsAt: null,
    resumeOnLaunch: false,
    nowPlaying: null, // song/show title parsed from the stream's ID3 metadata, when it sends any
    dnrWarning: null, // set if checkDeclarativeNetRequestHealth() finds the header rule disabled
};

/* Total time spent playing, all-time. Purely a "for fun / for interest" stat
   shown in Settings - accumulated on every stop/error rather than tracked
   live, so it costs nothing while actually playing. */
let totalListenMs = 0;

/* In-flight offscreen-document creation promise. chrome.offscreen only
   allows a single document at a time and throws if createDocument() is
   called twice concurrently. Two near-simultaneous PLAY messages (e.g. a
   popup click while a resync is still resolving, or a keyboard shortcut
   fired right after a click) used to both see hasDocument() === false and
   both call createDocument(), and the loser would throw and leave state
   stuck on "buffering". This promise makes the second caller wait for the
   first instead of racing it. */
let creatingOffscreen = null;

/* Rolling diagnostic log, kept in memory and mirrored to chrome.storage.local
   so the popup can show recent history even if it wasn't open when
   something went wrong (e.g. a lag spike or a background auto-stop), and so
   logs survive the service worker being recycled. */
let logBuffer = [];
let logPersistHandle = null;

/* Routine info-level chatter (a message arriving, a state field flipping)
   used to go through console.log() on every call, which is exactly the kind
   of thing that turns the service worker's DevTools console into a wall of
   text on a long listening session. It's still recorded in full into
   logBuffer (and from there into the popup's log panel) either way - this
   only changes what Chrome's own console shows by default. console.debug()
   is filtered out of DevTools unless "Verbose" is enabled, so routine info
   stays out of the way while warn/error still show up unprompted. */
function log(msg, level) {
    level = level || 'info';
    const time = new Date().toISOString();
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
    consoleFn('[background]', time, msg);
    logBuffer.push({ time, level, source: 'background', msg });
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    schedulePersistLogs();
}

function schedulePersistLogs() {
    if (logPersistHandle) return;
    logPersistHandle = setTimeout(() => {
        logPersistHandle = null;
        chrome.storage.local.set({ logBuffer }).catch(() => { });
    }, 500);
}

function flushLogsNow() {
    if (logPersistHandle) {
        clearTimeout(logPersistHandle);
        logPersistHandle = null;
    }
    chrome.storage.local.set({ logBuffer }).catch(() => { });
}

/* Persistence
   chrome.storage.session survives MV3 service-worker restarts (which happen
   after ~30s idle) but not browser restarts - good for "don't lose track of
   what's currently playing while the worker gets recycled".
   chrome.storage.local survives browser restarts - good for user prefs like
   the last volume and the "resume on launch" toggle, and for the diagnostic
   log buffer. */
async function loadPersistedState() {
    try {
        const [{ state: savedState } = {}, { volume, logBuffer: savedLogs, resumeOnLaunch, totalListenMs: savedListenMs } = {}] = await Promise.all([
            chrome.storage.session.get('state'),
            chrome.storage.local.get(['volume', 'logBuffer', 'resumeOnLaunch', 'totalListenMs']),
        ]);
        if (savedState) state = { ...state, ...savedState };
        if (typeof volume === 'number') state.volume = volume;
        if (Array.isArray(savedLogs)) logBuffer = savedLogs;
        if (typeof resumeOnLaunch === 'boolean') state.resumeOnLaunch = resumeOnLaunch;
        if (typeof savedListenMs === 'number') totalListenMs = savedListenMs;
    } catch (err) {
        log('loadPersistedState failed: ' + err.message, 'error');
    }
}

function persistState() {
    chrome.storage.session.set({ state }).catch(() => { });
}

function persistVolume(volume) {
    chrome.storage.local.set({ volume }).catch(() => { });
}

function persistResumeOnLaunch(value) {
    chrome.storage.local.set({ resumeOnLaunch: value }).catch(() => { });
}

/* Folds the just-finished session's duration into the all-time total. Must
   be called while state.startedAt still reflects that session - i.e. before
   whatever's ending it sets startedAt back to null. */
function accumulateListenTime() {
    if (!state.startedAt) return;
    const elapsed = Date.now() - state.startedAt;
    if (elapsed > 0) {
        totalListenMs += elapsed;
        chrome.storage.local.set({ totalListenMs }).catch(() => { });
    }
}

/* Badge (live indicator) - static color, no blink. See the comment on
   LIVE_COLOR above for why the old 1Hz blink was removed in 3.6. */
function setBadgeLive() {
    chrome.action.setBadgeText({ text: ' ' }).catch(() => { });
    chrome.action.setBadgeBackgroundColor({ color: LIVE_COLOR }).catch(() => { });
}

function setBadgeBuffering() {
    chrome.action.setBadgeText({ text: ' ' }).catch(() => { });
    chrome.action.setBadgeBackgroundColor({ color: BUFFERING_COLOR }).catch(() => { });
}

function clearBadge() {
    chrome.action.setBadgeText({ text: '' }).catch(() => { });
}

/* Toolbar tooltip + context menu label.
   The badge dot only says "something is happening" - it's a color, not a
   sentence. Hovering the toolbar icon (or right-clicking it) now tells you
   what's actually going on without opening the popup: live vs. connecting
   vs. reconnecting vs. stopped vs. error, plus the current track when the
   stream provides one. */
function updateActionTitle() {
    let title = 'Radio Damascus';
    if (state.isPlaying) {
        title += ' - Live';
        if (state.nowPlaying) title += ' - ' + state.nowPlaying;
    } else if (state.isBuffering) {
        title += ' - ' + (state.statusMessage || 'Connecting...');
    } else if (state.error) {
        title += ' - Error';
    } else {
        title += ' - Stopped';
    }
    chrome.action.setTitle({ title }).catch(() => { });
}

function updateContextMenuLabel() {
    const title = (state.isPlaying || state.isBuffering) ? 'Stop' : 'Play';
    chrome.contextMenus.update(CONTEXT_MENU_ID, { title }).catch(() => { });
}

function syncIndicators() {
    updateActionTitle();
    updateContextMenuLabel();
}

/* Right-click the toolbar icon to play/stop without opening the popup at
   all. create() is called on every install/update; if it's called again on
   a plain reload the "already exists" error is expected and harmless, so
   it's swallowed via the callback's lastError rather than left to reject
   noisily. */
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: 'Play', contexts: ['action'] }, () => {
        void chrome.runtime.lastError; // ignore "duplicate id" on reload/update
    });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    log('context menu: toggle-play');
    if (state.isPlaying || state.isBuffering) {
        stopPlayback('context_menu');
    } else {
        await requestPlay();
    }
});

/* Sanity-check the one thing this whole extension depends on working: the
   declarativeNetRequest rule that rewrites the Referer/Origin headers on
   stream requests (see rules.json). If it's ever disabled - a Chrome policy,
   a corrupted ruleset, a future manifest mistake - playback fails with a
   generic network error that gives no hint why. This just puts an
   unambiguous line in the log the moment that's the case. */
async function checkDeclarativeNetRequestHealth() {
    try {
        const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
        if (!enabled.includes('ruleset_1')) {
            const message = 'A required header rule is disabled - playback will likely fail. ' +
                'Try reinstalling the extension, or check chrome://extensions for a policy blocking it.';
            log('declarativeNetRequest ruleset_1 is NOT enabled - stream requests will be missing ' +
                'the Referer/Origin headers they need, and playback will likely fail with a network error', 'error');
            // Surfaced to the popup as a standing banner (not just a log line) since this
            // failure mode would otherwise look like an unexplained, unfixable network error.
            state.dnrWarning = message;
            persistState();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
        } else {
            log('declarativeNetRequest ruleset_1 confirmed enabled');
            if (state.dnrWarning) {
                state.dnrWarning = null;
                persistState();
                toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            }
        }
    } catch (err) {
        log('could not check declarativeNetRequest ruleset state: ' + err.message, 'warn');
    }
}

/* Offscreen management */
async function ensureOffscreen() {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (has) return;

    if (creatingOffscreen) {
        log('offscreen creation already in flight - waiting on it instead of racing');
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = (async () => {
        log('creating offscreen document');
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'HLS radio stream playback',
        });
        log('offscreen document created');
    })();

    try {
        await creatingOffscreen;
    } finally {
        creatingOffscreen = null;
    }
}

async function closeOffscreen() {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (has) {
        await chrome.offscreen.closeDocument().catch(() => { });
        log('offscreen document closed');
    }
}

function toOffscreen(msg) {
    chrome.runtime.sendMessage(msg).catch(err =>
        log('toOffscreen error: ' + err.message, 'warn')
    );
}

function toPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => { });
}

function resetPlaybackState() {
    state.isPlaying = false;
    state.isBuffering = false;
    state.startedAt = null;
    state.statusMessage = null;
    state.nowPlaying = null;
    clearBadge();
    syncIndicators();
    persistState();
}

/* Single place that starts playback: used by the popup's PLAY message and by
   the keyboard-shortcut and resume-on-launch paths, so all three share the
   same "already playing?" guard and the same offscreen-creation race guard
   instead of three slightly different copies of this logic. */
async function requestPlay() {
    if (state.isPlaying || state.isBuffering) {
        log('already playing - ignoring play request');
        return { ok: false, reason: 'already_playing' };
    }
    state.error = null;
    state.statusMessage = null;
    state.isBuffering = true;
    state.nowPlaying = null;
    persistState();
    try {
        await ensureOffscreen();
        toOffscreen({ type: 'OFFSCREEN_PLAY', volume: state.volume });
        setBadgeBuffering();
        syncIndicators();
        return { ok: true };
    } catch (err) {
        log('ensureOffscreen failed: ' + err.message, 'error');
        state.isBuffering = false;
        persistState();
        syncIndicators();
        return { ok: false, reason: err.message };
    }
}

/* Single place that fully stops playback: used by the user-initiated STOP
   message and by the auto-stop safeguards below (all windows closed, sleep
   timer, keyboard shortcut), so every path tears down state/offscreen/badge
   identically. */
function stopPlayback(reason) {
    log('stopping playback (' + (reason || 'user_requested') + ')');
    accumulateListenTime();
    state.isPlaying = false;
    state.isBuffering = false;
    state.startedAt = null;
    state.statusMessage = null;
    state.sleepTimerEndsAt = null;
    state.nowPlaying = null;
    chrome.alarms.clear(SLEEP_ALARM).catch(() => { });
    persistState();
    toOffscreen({ type: 'OFFSCREEN_STOP' });
    closeOffscreen();
    clearBadge();
    syncIndicators();
    toPopup({ type: 'STATE_UPDATE', state: { ...state } });
}

function notifyError(message) {
    chrome.notifications.create('radio-error-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Radio Damascus stopped',
        message: message || 'Playback stopped unexpectedly.',
        priority: 1,
    }).catch(err => log('notifyError failed: ' + err.message, 'warn'));
}

/* Auto-stop when the browser is closed.
   The offscreen document's audio element has nothing to do with any browser
   window, so it happily keeps playing after every window is closed - and if
   the user has Chrome's "continue running background apps" setting on,
   Chrome itself keeps running headless in the background purely to host it.
   That's the "I can still hear the radio after closing Chrome" report:
   closing all windows should mean closing the app, not leaving a silent
   background player running. */
chrome.windows.onRemoved.addListener(async () => {
    try {
        const remaining = await chrome.windows.getAll();
        if (remaining.length === 0 && (state.isPlaying || state.isBuffering)) {
            log('last browser window closed while playing - auto-stopping', 'warn');
            stopPlayback('all_windows_closed');
        }
    } catch (err) {
        log('windows.onRemoved handler failed: ' + err.message, 'error');
    }
});

/* Resume on browser launch - opt-in via the popup's settings panel. Deliberately
   tied to chrome.runtime.onStartup (fires once, only on an actual cold browser
   launch) rather than to the general resyncOnStartup() below, which also runs
   on every routine MV3 service-worker recycle - wiring this to that instead
   would restart playback every ~30s idle cycle even after the user manually
   stopped it. */
chrome.runtime.onStartup.addListener(async () => {
    try {
        const { resumeOnLaunch } = await chrome.storage.local.get('resumeOnLaunch');
        if (resumeOnLaunch) {
            log('resume-on-launch enabled - starting playback');
            await requestPlay();
        }
    } catch (err) {
        log('onStartup resume check failed: ' + err.message, 'error');
    }
});

/* Keyboard shortcut: play/pause without opening the popup. */
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-play') return;
    log('keyboard shortcut: toggle-play');
    if (state.isPlaying || state.isBuffering) {
        stopPlayback('keyboard_shortcut');
    } else {
        await requestPlay();
    }
});

/* On service-worker (re)start: reconcile our remembered state with reality.
   If the worker was recycled mid-playback, `state` above starts from
   defaults again but the offscreen document (and its audio) may still be
   alive. Ask it directly instead of guessing. */
async function resyncOnStartup() {
    await loadPersistedState();

    if (!state.isPlaying && !state.isBuffering) {
        clearBadge();
        syncIndicators();
        return;
    }

    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (!has) {
        log('resync: no offscreen document, but state said playing - resetting');
        resetPlaybackState();
        return;
    }

    try {
        const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATUS_QUERY' });
        if (res && res.playing) {
            log('resync: offscreen confirms still playing');
            setBadgeLive();
            syncIndicators();
        } else {
            log('resync: offscreen not actually playing - resetting');
            resetPlaybackState();
        }
    } catch (err) {
        log('resync: status query failed (' + err.message + ') - resetting', 'warn');
        resetPlaybackState();
    }
}

/* Watchdog: every minute, if we believe we're playing, double-check with the
   offscreen document. This exists purely for diagnostics - it doesn't force
   a reset on its own (a false positive mid-reconnect would be worse than
   the problem it's solving), but it logs a loud warning the moment reality
   and remembered state disagree, which is exactly the kind of signal that
   was missing when tracking down "lags after a few minutes" reports. */
chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
        runWatchdog();
    } else if (alarm.name === SLEEP_ALARM) {
        log('sleep timer elapsed - stopping playback', 'warn');
        stopPlayback('sleep_timer');
    }
});

async function runWatchdog() {
    if (!state.isPlaying && !state.isBuffering) return;

    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (!has) {
        log('watchdog: state says playing/buffering but no offscreen document exists - resetting', 'warn');
        resetPlaybackState();
        return;
    }

    try {
        const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATUS_QUERY' });
        if (state.isPlaying && (!res || !res.playing)) {
            log('watchdog: state says playing but offscreen reports not playing - flagging for attention', 'warn');
        }
    } catch (err) {
        log('watchdog: status query failed: ' + err.message, 'warn');
    }
}

/* Message handler */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    log('received: ' + msg.type);

    switch (msg.type) {

        case 'GET_STATE':
            sendResponse({ ...state, totalListenMs });
            return false;

        case 'GET_LOGS':
            sendResponse({ logs: logBuffer });
            return false;

        case 'CLEAR_LOGS':
            logBuffer = [];
            flushLogsNow();
            sendResponse({ ok: true });
            return false;

        case 'PLAY':
            requestPlay().then(sendResponse);
            return true;

        case 'STOP':
            stopPlayback('user_requested');
            sendResponse({ ok: true });
            return false;

        case 'VOLUME': {
            const value = Number(msg.value);
            state.volume = value;
            persistVolume(value);
            toOffscreen({ type: 'OFFSCREEN_VOLUME', value });
            sendResponse({ ok: true });
            return false;
        }

        case 'SET_SLEEP_TIMER': {
            const minutes = Number(msg.minutes) || 0;
            if (minutes > 0) {
                chrome.alarms.create(SLEEP_ALARM, { delayInMinutes: minutes });
                state.sleepTimerEndsAt = Date.now() + minutes * 60000;
                log('sleep timer set for ' + minutes + ' minute(s)');
            } else {
                chrome.alarms.clear(SLEEP_ALARM).catch(() => { });
                state.sleepTimerEndsAt = null;
                log('sleep timer cleared');
            }
            persistState();
            sendResponse({ ok: true, sleepTimerEndsAt: state.sleepTimerEndsAt });
            return false;
        }

        case 'SET_RESUME_ON_LAUNCH':
            state.resumeOnLaunch = !!msg.value;
            persistResumeOnLaunch(state.resumeOnLaunch);
            log('resume-on-launch set to ' + state.resumeOnLaunch);
            sendResponse({ ok: true });
            return false;

        case 'OFFSCREEN_EVENT':
            handleOffscreenEvent(msg.event, msg.detail, msg.level);
            sendResponse({ ok: true });
            return false;
    }
});

function handleOffscreenEvent(event, detail, level) {
    log('offscreen event: ' + event + (detail ? ' - ' + detail : ''));

    switch (event) {
        case 'PLAYING':
            state.isPlaying = true;
            state.isBuffering = false;
            state.startedAt = state.startedAt || Date.now();
            state.error = null;
            state.statusMessage = null;
            setBadgeLive();
            syncIndicators();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            persistState();
            break;

        case 'BUFFERING':
            state.isBuffering = true;
            state.statusMessage = null;
            setBadgeBuffering();
            syncIndicators();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'RECONNECTING':
            state.isBuffering = true;
            state.error = null;
            state.statusMessage = detail || 'Reconnecting...';
            setBadgeBuffering();
            syncIndicators();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'ERROR':
            accumulateListenTime();
            state.isPlaying = false;
            state.isBuffering = false;
            state.startedAt = null;
            state.statusMessage = null;
            state.sleepTimerEndsAt = null;
            state.nowPlaying = null;
            state.error = detail || 'Unknown error';
            chrome.alarms.clear(SLEEP_ALARM).catch(() => { });
            clearBadge();
            syncIndicators();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            persistState();
            closeOffscreen();
            notifyError(state.error);
            break;

        case 'STALLED':
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'METADATA':
            // Best-effort: only some HLS streams embed ID3 timed metadata (song/show
            // title). If this stream doesn't, this event simply never fires and the
            // popup keeps showing the plain "On Air" label - nothing else depends on it.
            if (detail && detail !== state.nowPlaying) {
                state.nowPlaying = detail;
                syncIndicators();
                toPopup({ type: 'STATE_UPDATE', state: { ...state } });
                persistState();
            }
            break;

        case 'LOG':
            log('[offscreen] ' + detail, level || 'info');
            toPopup({ type: 'LOG', msg: detail, level: level || 'info' });
            break;
    }
}

/* Diagnostics: surface otherwise-silent failures instead of losing them when
   the service worker gets torn down. */
self.addEventListener('error', (e) => {
    log('uncaught error: ' + (e.message || e), 'error');
});
self.addEventListener('unhandledrejection', (e) => {
    log('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason), 'error');
});
chrome.runtime.onSuspend.addListener(() => {
    log('service worker suspending', 'warn');
    flushLogsNow();
});

/* Init */
resyncOnStartup();
checkDeclarativeNetRequestHealth();
