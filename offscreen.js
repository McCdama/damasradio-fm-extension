const STREAM_URL = 'https://radiodamascus.ortas.live/RDimshq/RDimshqAudioLive/playlist.m3u8';

let hls = null;
let audio = null;

function send(event, detail) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_EVENT', event, detail }).catch(() => { });
}

function log(msg) {
    send('LOG', msg);
    console.log('[offscreen]', msg);
}

function destroy() {
    if (hls) {
        hls.destroy();
        hls = null;
        log('hls instance destroyed');
    }
    if (audio) {
        audio.pause();
        audio.src = '';
        audio.load();
        audio = null;
        log('audio element released');
    }
}

chrome.runtime.onMessage.addListener((msg) => {
    log('received: ' + msg.type);

    switch (msg.type) {

        case 'OFFSCREEN_PLAY':
            destroy();

            if (typeof Hls === 'undefined') {
                log('ERROR: hls.js not found');
                send('ERROR', 'hls.js not loaded');
                return;
            }

            if (!Hls.isSupported()) {
                log('ERROR: HLS not supported in this context');
                send('ERROR', 'HLS not supported');
                return;
            }

            log('creating Audio element');
            audio = new Audio();
            audio.volume = msg.volume ?? 0.8;

            audio.addEventListener('playing', () => {
                log('event: playing');
                send('PLAYING');
            });

            audio.addEventListener('waiting', () => {
                log('event: waiting');
                send('BUFFERING');
            });

            audio.addEventListener('stalled', () => {
                log('event: stalled');
                send('STALLED');
            });

            audio.addEventListener('error', () => {
                const code = audio?.error?.code;
                const msg2 = audio?.error?.message || 'unknown';
                log('event: error code=' + code + ' msg=' + msg2);
                send('ERROR', 'code=' + code + ' ' + msg2);
            });

            log('creating Hls instance');
            hls = new Hls({
                enableWorker: false,
                lowLatencyMode: true,
                backBufferLength: 10,
                maxBufferLength: 20,
                maxMaxBufferLength: 30,
                maxBufferSize: 20 * 1000 * 1000,
            });

            hls.on(Hls.Events.ERROR, (_, data) => {
                log('hls error type=' + data.type + ' fatal=' + data.fatal + ' details=' + data.details);
                if (data.fatal) {
                    send('ERROR', data.type + ' - ' + data.details);
                    destroy();
                }
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                log('manifest parsed, calling play()');
                audio.play()
                    .then(() => log('play() resolved'))
                    .catch(err => {
                        log('play() rejected: ' + err.message);
                        send('ERROR', err.message);
                    });
            });

            hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
                log('level loaded, duration=' + data.details.totalduration);
            });

            log('loading source: ' + STREAM_URL);
            hls.loadSource(STREAM_URL);
            hls.attachMedia(audio);
            break;

        case 'OFFSCREEN_STOP':
            log('stopping');
            destroy();
            break;

        case 'OFFSCREEN_VOLUME':
            if (audio) {
                audio.volume = msg.value;
                log('volume set to ' + msg.value);
            }
            break;
    }
});

log('offscreen.js loaded, hls.js present=' + (typeof Hls !== 'undefined'));