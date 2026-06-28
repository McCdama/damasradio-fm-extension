const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const ICON_URL = chrome.runtime.getURL('icons/icon128.png');

/* State */
let state = {
    isPlaying: false,
    isBuffering: false,
    volume: 0.8,
    startedAt: null,
    error: null,
};

let iconTimer = null;
let iconFrame = 0;
let baseIcon128 = null;
let baseIcon16 = null;
let baseIcon48 = null;

function log(msg) {
    console.log('[background]', new Date().toISOString(), msg);
}

/* Icon loading */
async function loadBaseIcons() {
    try {
        const resp = await fetch(ICON_URL);
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);

        baseIcon128 = await renderBase(bmp, 128);
        baseIcon48 = await renderBase(bmp, 48);
        baseIcon16 = await renderBase(bmp, 16);
        log('base icons loaded');
    } catch (err) {
        log('failed to load base icon: ' + err.message);
    }
}

async function renderBase(bmp, size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
}

function drawFrame(size, baseImageData, pulse, dotAlpha) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.putImageData(baseImageData, 0, 0);

    if (pulse) {
        const dotR = Math.max(3, size / 12);
        const dotX = size - dotR - 1;
        const dotY = dotR + 1;

        ctx.beginPath();
        ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(137, 21, 57, ' + dotAlpha.toFixed(2) + ')';
        ctx.fill();
    }

    return ctx.getImageData(0, 0, size, size);
}

function setIconAnimated() {
    if (!baseIcon128 || !baseIcon48 || !baseIcon16) return;

    stopIconAnimation();
    iconTimer = setInterval(() => {
        iconFrame++;
        const alpha = 0.4 + 0.6 * Math.abs(Math.sin(iconFrame * 0.08));
        chrome.action.setIcon({
            imageData: {
                128: drawFrame(128, baseIcon128, true, alpha),
                48: drawFrame(48, baseIcon48, true, alpha),
                16: drawFrame(16, baseIcon16, true, alpha),
            }
        }).catch(() => { });
    }, 50);
}

function setIconStatic() {
    stopIconAnimation();
    if (!baseIcon128 || !baseIcon48 || !baseIcon16) return;

    chrome.action.setIcon({
        imageData: {
            128: drawFrame(128, baseIcon128, false),
            48: drawFrame(48, baseIcon48, false),
            16: drawFrame(16, baseIcon16, false),
        }
    }).catch(() => { });
}

function stopIconAnimation() {
    if (iconTimer) {
        clearInterval(iconTimer);
        iconTimer = null;
        iconFrame = 0;
    }
}

/* Offscreen management */
async function ensureOffscreen() {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (!has) {
        log('creating offscreen document');
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'HLS radio stream playback',
        });
        log('offscreen document created');
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
        log('toOffscreen error: ' + err.message)
    );
}

function toPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => { });
}

/* Message handler */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    log('received: ' + msg.type);

    switch (msg.type) {

        case 'GET_STATE':
            sendResponse({ ...state });
            return false;

        case 'PLAY':
            if (state.isPlaying || state.isBuffering) {
                log('already playing - rejecting second instance');
                sendResponse({ ok: false, reason: 'already_playing' });
                return false;
            }
            state.error = null;
            state.isBuffering = true;
            ensureOffscreen().then(() => {
                toOffscreen({ type: 'OFFSCREEN_PLAY', volume: state.volume });
                sendResponse({ ok: true });
            }).catch(err => {
                log('ensureOffscreen failed: ' + err.message);
                state.isBuffering = false;
                sendResponse({ ok: false, reason: err.message });
            });
            return true;

        case 'STOP':
            state.isPlaying = false;
            state.isBuffering = false;
            state.startedAt = null;
            toOffscreen({ type: 'OFFSCREEN_STOP' });
            closeOffscreen();
            setIconStatic();
            sendResponse({ ok: true });
            return false;

        case 'VOLUME':
            state.volume = msg.value;
            toOffscreen({ type: 'OFFSCREEN_VOLUME', value: msg.value });
            sendResponse({ ok: true });
            return false;

        case 'OFFSCREEN_EVENT':
            handleOffscreenEvent(msg.event, msg.detail);
            sendResponse({ ok: true });
            return false;
    }
});

function handleOffscreenEvent(event, detail) {
    log('offscreen event: ' + event + (detail ? ' - ' + detail : ''));

    switch (event) {
        case 'PLAYING':
            state.isPlaying = true;
            state.isBuffering = false;
            state.startedAt = state.startedAt || Date.now();
            state.error = null;
            setIconAnimated();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'BUFFERING':
            state.isBuffering = true;
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'ERROR':
            state.isPlaying = false;
            state.isBuffering = false;
            state.startedAt = null;
            state.error = detail || 'Unknown error';
            setIconStatic();
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            closeOffscreen();
            break;

        case 'STALLED':
            toPopup({ type: 'STATE_UPDATE', state: { ...state } });
            break;

        case 'LOG':
            log('[offscreen] ' + detail);
            toPopup({ type: 'LOG', msg: detail });
            break;
    }
}

/* Init */
loadBaseIcons();