/* ==========================================================================
   1. СИСТЕМА АУДИТА И ЛОГИРОВАНИЯ
   ========================================================================== */
window.P2PAuditLog = {
    logs: [],
    add(category, message, extra = null) {
        const time = new Date().toTimeString().split(' ')[0] + '.' + String(Date.now() % 1000).padStart(3, '0');
        const extraStr = extra ? (typeof extra === 'object' ? JSON.stringify(extra) : String(extra)) : '';
        this.logs.push({ time, category, message, extra: extraStr });
        if (this.logs.length > 700) this.logs.shift();

        const logTerminal = document.getElementById('logTerminal');
        if (logTerminal) {
            const row = document.createElement('div');
            row.className = 'log-line';
            row.innerHTML = `
                <span class="log-time">[${time}]</span>
                <span class="log-tag log-tag-${category}">${category}</span>
                <span>${escapeHtml(message)} ${extraStr ? `<span style="color:#9ca3af;">${escapeHtml(extraStr)}</span>` : ''}</span>
            `;
            logTerminal.appendChild(row);
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
    },
    exportText() {
        return this.logs.map(l => `[${l.time}] [${l.category}] ${l.message} ${l.extra}`).join('\n');
    },
    clear() {
        this.logs = [];
        const logTerminal = document.getElementById('logTerminal');
        if (logTerminal) logTerminal.innerHTML = '';
    }
};

const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
console.log = (...args) => { origConsoleLog(...args); window.P2PAuditLog.add('SYS', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); };
console.warn = (...args) => { origConsoleWarn(...args); window.P2PAuditLog.add('WARN', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); };
console.error = (...args) => { origConsoleError(...args); window.P2PAuditLog.add('ERR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); };

document.getElementById('btnOpenLogs').onclick = () => document.getElementById('logModal').classList.remove('p2p-hidden');
document.getElementById('btnCloseLogs').onclick = () => document.getElementById('logModal').classList.add('p2p-hidden');
document.getElementById('btnClearLogs').onclick = () => window.P2PAuditLog.clear();
document.getElementById('btnCopyLogs').onclick = () => {
    navigator.clipboard.writeText(window.P2PAuditLog.exportText()).then(() => showToast("Все логи скопированы", 'content_copy'));
};

/* ==========================================================================
   2. СИНТЕЗАТОР ЗВУКОВЫХ ЭФФЕКТОВ (WEB AUDIO API)
   ========================================================================== */
class SoundSynthesizer {
    constructor() {
        this.ctx = null;
        this.enabled = true;
        this.volume = 0.5;
    }

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    playTone(freq, duration, type = 'sine', gainVal = 0.3) {
        if (!this.enabled) return;
        this.init();
        if (!this.ctx) return;

        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(gainVal * this.volume, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) { }
    }

    join() {
        this.playTone(523.25, 0.12, 'sine', 0.25);
        setTimeout(() => this.playTone(659.25, 0.15, 'sine', 0.25), 90);
        setTimeout(() => this.playTone(783.99, 0.25, 'sine', 0.3), 180);
    }

    leave() {
        this.playTone(659.25, 0.12, 'sine', 0.2);
        setTimeout(() => this.playTone(440.0, 0.2, 'sine', 0.2), 100);
    }

    chat() {
        this.playTone(880, 0.08, 'triangle', 0.2);
        setTimeout(() => this.playTone(1174.66, 0.12, 'sine', 0.25), 50);
    }

    hand() {
        this.playTone(1046.5, 0.3, 'sine', 0.35);
    }

    reaction() {
        this.playTone(587.33, 0.1, 'sine', 0.15);
    }

    click() {
        this.playTone(400, 0.04, 'square', 0.05);
    }

    kick() {
        this.playTone(300, 0.2, 'sawtooth', 0.3);
        setTimeout(() => this.playTone(200, 0.3, 'sawtooth', 0.3), 130);
    }
}
const soundFx = new SoundSynthesizer();

/* ==========================================================================
   3. VAD (ДЕТЕКТОР РЕЧИ)
   ========================================================================== */
class LocalVoiceDetector {
    constructor() {
        this.ctx = null;
        this.source = null;
        this.analyser = null;
        this.animFrame = null;
        this.isSpeaking = false;
        this.silenceTimer = null;
    }

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    start(stream) {
        this.stop();
        if (!stream || stream.getAudioTracks().length === 0) return;
        this.init();
        if (!this.ctx) return;

        try {
            this.source = this.ctx.createMediaStreamSource(stream);
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.4;
            this.source.connect(this.analyser);

            const data = new Uint8Array(this.analyser.frequencyBinCount);

            const loop = () => {
                if (!isMicOn) {
                    if (this.isSpeaking) this._setSpeaking(false);
                    this.animFrame = requestAnimationFrame(loop);
                    return;
                }

                this.analyser.getByteFrequencyData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const avg = sum / data.length;

                if (avg > 14) {
                    if (!this.isSpeaking) this._setSpeaking(true);
                    if (this.silenceTimer) clearTimeout(this.silenceTimer);
                    this.silenceTimer = setTimeout(() => this._setSpeaking(false), 350);
                }
                this.animFrame = requestAnimationFrame(loop);
            };
            loop();
        } catch (e) {
            window.P2PAuditLog.add('WARN', `Ошибка VAD: ${e.message}`);
        }
    }

    _setSpeaking(state) {
        this.isSpeaking = state;
        const localTile = document.getElementById('tile-cam-local');
        if (localTile) localTile.classList.toggle('speaking', state);
        net.broadcast({ type: 'VAD_ACTIVITY', peerId: net.peer?.id, isSpeaking: state });
    }

    stop() {
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        if (this.source) {
            try { this.source.disconnect(); } catch (e) { }
            this.source = null;
        }
        this._setSpeaking(false);
    }
}
const localVAD = new LocalVoiceDetector();

function unlockAudioEngine() {
    soundFx.init();
    localVAD.init();
    document.querySelectorAll('video').forEach(v => {
        if (v.id !== 'localVideo' && v.id !== 'previewVideo') {
            v.muted = false;
            v.play().catch(() => { });
        }
    });
}
window.addEventListener('click', unlockAudioEngine, { once: true });
window.addEventListener('touchstart', unlockAudioEngine, { once: true });

/* ==========================================================================
   4. ИНИЦИАЛИЗАЦИЯ И МЕДИА
   ========================================================================== */
const net = new P2PNet({ appPrefix: 'dropconf', mode: 'mesh', debug: true });

let myName = "User";
let isCamOn = true;
let isMicOn = true;
let isScreenSharing = false;
let isHandRaised = false;
let currentFacingMode = 'user';
let currentVideoDeviceId = null;
let currentAudioDeviceId = null;
let screenStream = null;
let showChatToasts = true;
let isMirrored = true;
let pinnedTileId = null;

const participantVolumes = new Map();

// UI ЭЛЕМЕНТЫ
const toast = document.getElementById('toast');
const toastText = document.getElementById('toastText');
const toastIcon = document.getElementById('toastIcon');
const netBadge = document.getElementById('netBadge');
const netBadgeText = document.getElementById('netBadgeText');
const lobbyScreen = document.getElementById('lobbyScreen');
const conferenceScreen = document.getElementById('conferenceScreen');
const previewVideo = document.getElementById('previewVideo');
const previewAvatar = document.getElementById('previewAvatar');
const previewTile = document.getElementById('previewTile');
const inputUserName = document.getElementById('inputUserName');
const inputRoomCode = document.getElementById('inputRoomCode');
const localVideo = document.getElementById('localVideo');
const tileCamLocal = document.getElementById('tile-cam-local');
const myAvatar = document.getElementById('myAvatar');
const myTagName = document.getElementById('myTagName');
const myTagMic = document.getElementById('myTagMic');
const myHandBadge = document.getElementById('myHandBadge');
const myHostCrown = document.getElementById('myHostCrown');
const videoGrid = document.getElementById('videoGrid');
const meetLiveTime = document.getElementById('meetLiveTime');
const meetRoomCodePill = document.getElementById('meetRoomCodePill');
const meetRoomCodeText = document.getElementById('meetRoomCodeText');

const btnMicToggle = document.getElementById('btnMicToggle');
const btnCamToggle = document.getElementById('btnCamToggle');
const btnFlipCam = document.getElementById('btnFlipCam');
const btnScreenShare = document.getElementById('btnScreenShare');
const btnHandRaise = document.getElementById('btnHandRaise');
const btnReactionToggle = document.getElementById('btnReactionToggle');
const reactionBar = document.getElementById('reactionBar');
const btnCloseReactions = document.getElementById('btnCloseReactions');
const btnChatToggle = document.getElementById('btnChatToggle');
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const inputChatMessage = document.getElementById('inputChatMessage');
const chatToastContainer = document.getElementById('chatToastContainer');
const chatUnreadDot = document.getElementById('chatUnreadDot');

// МОБИЛЬНЫЙ BOTTOM SHEET
const btnMoreMobile = document.getElementById('btnMoreMobile');
const mobileSheetBackdrop = document.getElementById('mobileSheetBackdrop');
const sheetBtnHand = document.getElementById('sheetBtnHand');
const sheetBtnScreen = document.getElementById('sheetBtnScreen');
const sheetBtnFlip = document.getElementById('sheetBtnFlip');
const sheetBtnAudit = document.getElementById('sheetBtnAudit');
const sheetBtnChat = document.getElementById('sheetBtnChat');
const sheetBtnInvite = document.getElementById('sheetBtnInvite');
const sheetBtnSettings = document.getElementById('sheetBtnSettings');
const sheetChatBadge = document.getElementById('sheetChatBadge');

function showToast(msg, icon = 'info') {
    toastText.textContent = msg;
    toastIcon.textContent = icon;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2600);
}

setInterval(() => {
    const d = new Date();
    if (meetLiveTime) meetLiveTime.textContent = d.toTimeString().split(' ')[0].substring(0, 5);
}, 1000);

function updateGridCount() {
    const count = videoGrid.children.length;
    videoGrid.classList.remove('count-1', 'count-2', 'count-3', 'count-4', 'count-many');

    if (pinnedTileId) {
        videoGrid.classList.add('has-stage');
    } else {
        videoGrid.classList.remove('has-stage');
        if (count <= 1) videoGrid.classList.add('count-1');
        else if (count === 2) videoGrid.classList.add('count-2');
        else if (count <= 4) videoGrid.classList.add('count-4');
        else videoGrid.classList.add('count-many');
    }
}

function updateMirrorState() {
    const shouldMirror = isMirrored && (currentFacingMode === 'user');
    if (previewTile) previewTile.classList.toggle('mirrored', shouldMirror);
    if (tileCamLocal) tileCamLocal.classList.toggle('mirrored', shouldMirror);
}

async function getSafeUserMedia(facingMode = 'user', audioId = null, videoId = null) {
    const useProcessing = document.getElementById('chkNoiseSuppression')?.checked ?? true;
    const audioConstraints = {
        echoCancellation: useProcessing,
        noiseSuppression: useProcessing,
        autoGainControl: useProcessing,
        ...(audioId ? { deviceId: { exact: audioId } } : {})
    };

    if (videoId) {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: videoId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: audioConstraints
            });
        } catch (e) {
            window.P2PAuditLog.add('WARN', `Точный deviceId ${videoId} недоступен`);
        }
    }

    try {
        return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: audioConstraints
        });
    } catch (e) {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: audioConstraints });
    }
}

async function initPreview() {
    try {
        const stream = await getSafeUserMedia(currentFacingMode);
        net.localStream = stream;
        previewVideo.srcObject = stream;
        localVideo.srcObject = stream;
        previewVideo.muted = true;
        localVideo.muted = true;

        await previewVideo.play().catch(() => { });
        await localVideo.play().catch(() => { });

        localVAD.start(stream);
        updateMirrorState();
        window.P2PAuditLog.add('MEDIA', 'Медиа-поток инициализирован');
    } catch (e) {
        window.P2PAuditLog.add('ERR', `Ошибка оборудования: ${e.message}`);
        isCamOn = false; isMicOn = false;
        previewAvatar.style.display = 'flex';
        myAvatar.style.display = 'flex';
        btnCamToggle.classList.add('off');
        btnMicToggle.classList.add('off');
    }
}

async function flipCamera() {
    soundFx.click();
    const nextMode = (currentFacingMode === 'user') ? 'environment' : 'user';
    showToast("Смена камеры...", 'flip_camera_ios');

    try {
        const newStream = await getSafeUserMedia(nextMode, currentAudioDeviceId, null);
        const newVideoTrack = newStream.getVideoTracks()[0];
        const oldVideoTrack = net.localStream ? net.localStream.getVideoTracks()[0] : null;

        currentFacingMode = nextMode;
        updateMirrorState();

        if (net.localStream) {
            if (oldVideoTrack) {
                net.localStream.removeTrack(oldVideoTrack);
                oldVideoTrack.stop();
            }
            net.localStream.addTrack(newVideoTrack);
        } else {
            net.localStream = newStream;
        }

        localVideo.srcObject = net.localStream;
        previewVideo.srcObject = net.localStream;
        localVideo.play().catch(() => { });
        previewVideo.play().catch(() => { });

        newVideoTrack.enabled = isCamOn;
        await net.replaceTrack(newVideoTrack, 'video');
        net.broadcast({ type: 'CAM_STATUS', isCamOn: isCamOn });

        showToast(currentFacingMode === 'user' ? "Фронтальная камера" : "Основная камера", 'flip_camera_ios');
    } catch (err) {
        window.P2PAuditLog.add('ERR', `Ошибка смены камеры: ${err.message}`);
        showToast("Ошибка смены камеры", 'error');
    }
}
btnFlipCam.onclick = flipCamera;
sheetBtnFlip.onclick = () => { flipCamera(); closeMobileSheet(); };
document.getElementById('btnFlipCamPreview').onclick = flipCamera;

function toggleCamera() {
    soundFx.click();
    if (!net.localStream) return;
    const videoTrack = net.localStream.getVideoTracks()[0];

    if (isCamOn) {
        if (videoTrack) videoTrack.enabled = false;
        isCamOn = false;
        myAvatar.style.display = 'flex';
        previewAvatar.style.display = 'flex';
        btnCamToggle.classList.add('off');
        btnCamToggle.innerHTML = '<span class="material-symbols-outlined">videocam_off</span>';
        net.broadcast({ type: 'CAM_STATUS', isCamOn: false });
    } else {
        if (videoTrack) videoTrack.enabled = true;
        isCamOn = true;
        myAvatar.style.display = 'none';
        previewAvatar.style.display = 'none';
        btnCamToggle.classList.remove('off');
        btnCamToggle.innerHTML = '<span class="material-symbols-outlined">videocam</span>';
        net.broadcast({ type: 'CAM_STATUS', isCamOn: true });
    }
}

function toggleMicrophone() {
    soundFx.click();
    if (!net.localStream) return;
    const audioTrack = net.localStream.getAudioTracks()[0];

    if (isMicOn) {
        if (audioTrack) audioTrack.enabled = false;
        isMicOn = false;
        myTagMic.textContent = 'mic_off';
        myTagMic.style.color = 'var(--google-red)';
        btnMicToggle.classList.add('off');
        btnMicToggle.innerHTML = '<span class="material-symbols-outlined">mic_off</span>';
        document.getElementById('btnTogglePreviewMic').innerHTML = '<span class="material-symbols-outlined">mic_off</span> Off';
        net.broadcast({ type: 'MIC_STATUS', isMicOn: false });
    } else {
        if (audioTrack) audioTrack.enabled = true;
        isMicOn = true;
        myTagMic.textContent = 'mic';
        myTagMic.style.color = 'var(--google-green)';
        btnMicToggle.classList.remove('off');
        btnMicToggle.innerHTML = '<span class="material-symbols-outlined">mic</span>';
        document.getElementById('btnTogglePreviewMic').innerHTML = '<span class="material-symbols-outlined">mic</span> Mic';
        net.broadcast({ type: 'MIC_STATUS', isMicOn: true });
    }
}
btnCamToggle.onclick = toggleCamera;
btnMicToggle.onclick = toggleMicrophone;
document.getElementById('btnTogglePreviewCam').onclick = toggleCamera;
document.getElementById('btnTogglePreviewMic').onclick = toggleMicrophone;

/* ==========================================================================
   5. ВИДЕОКАРТОЧКИ УЧАСТНИКОВ, PINNING И МЕНЮ
   ========================================================================== */
function addOrUpdateCamTile(peerId, stream, participantName, initialMicState = true, initialCamState = true) {
    const tileId = `tile-cam-${peerId}`;
    let tile = document.getElementById(tileId);

    if (!tile) {
        window.P2PAuditLog.add('MEDIA', `Создание видео-карточки [${peerId}] (${participantName || 'Guest'})`);
        tile = document.createElement('div');
        tile.className = 'video-tile';
        tile.id = tileId;
        tile.dataset.peer = peerId;
        tile.innerHTML = `
            <video id="video-cam-${peerId}" autoplay playsinline></video>
            <div id="avatar-cam-${peerId}" class="tile-avatar" style="display:none;">
                <span class="material-symbols-outlined">person</span>
            </div>

            <div class="tile-hover-controls">
                <button class="tile-ctrl-btn" title="Закрепить" onclick="togglePinTile('${tileId}')">
                    <span class="material-symbols-outlined">keep</span>
                </button>
                <button class="tile-ctrl-btn" title="На весь экран" onclick="toggleNativeFullscreen('${tileId}')">
                    <span class="material-symbols-outlined">fullscreen</span>
                </button>
                <button class="tile-ctrl-btn" title="Дополнительно" onclick="toggleTileMenu('${peerId}', '${tileId}', event)">
                    <span class="material-symbols-outlined">more_vert</span>
                </button>
            </div>

            <div class="tile-overlay">
                <div class="tile-top-actions">
                    <div class="hand-badge p2p-hidden" id="hand-${peerId}">✋ Рука</div>
                </div>
                <div class="tile-tag">
                    <span id="mic-cam-${peerId}" class="material-symbols-outlined mic-icon">mic</span>
                    <span id="name-cam-${peerId}">${escapeHtml(participantName || 'Участник')}</span>
                    <span id="crown-cam-${peerId}" class="material-symbols-outlined host-crown p2p-hidden" title="Организатор">crown</span>
                </div>
            </div>
        `;
        videoGrid.appendChild(tile);
    }

    const videoEl = document.getElementById(`video-cam-${peerId}`);
    if (videoEl && stream) {
        videoEl.srcObject = stream;
        videoEl.muted = false;
        const currentVol = participantVolumes.get(peerId) ?? 1.0;
        videoEl.volume = currentVol;
        videoEl.play().catch(() => { });
    }

    const micIcon = document.getElementById(`mic-cam-${peerId}`);
    if (micIcon) {
        micIcon.textContent = initialMicState ? 'mic' : 'mic_off';
        micIcon.style.color = initialMicState ? 'var(--google-green)' : 'var(--google-red)';
    }

    const avatarEl = document.getElementById(`avatar-cam-${peerId}`);
    if (avatarEl && videoEl) {
        videoEl.style.display = initialCamState ? 'block' : 'none';
        avatarEl.style.display = initialCamState ? 'none' : 'flex';
    }

    if (net.hostId === peerId) {
        const crown = document.getElementById(`crown-cam-${peerId}`);
        if (crown) crown.classList.remove('p2p-hidden');
    }

    updateGridCount();
    refreshAdminParticipantsList();
}

/* ==========================================================================
   ДЕМОНСТРАЦИЯ ЭКРАНА В СТИЛЕ DISCORD (БЕЗ АВТО-STAGE)
   ========================================================================== */
const activeScreenStreams = new Map();

function addOrUpdateScreenTile(peerId, stream, titleName, isLocal = false) {
    const tileId = `tile-screen-${peerId}`;
    let tile = document.getElementById(tileId);

    activeScreenStreams.set(peerId, stream);

    if (!tile) {
        tile = document.createElement('div');
        tile.className = 'video-tile screen-tile'; // БЕЗ is-stage по умолчанию!
        tile.id = tileId;
        tile.dataset.peer = peerId;
        tile.innerHTML = `
            <video id="video-screen-${peerId}" autoplay playsinline ${isLocal ? 'muted' : ''}></video>

            ${!isLocal ? `
            <div class="stream-discord-card" id="streamCard-${peerId}">
                <div class="stream-discord-icon">
                    <span class="material-symbols-outlined" style="font-size:24px;">desktop_windows</span>
                </div>
                <div class="stream-discord-title">Трансляция экрана</div>
                <div class="stream-discord-desc">${escapeHtml(titleName)} делится экраном</div>
                <button class="studio-btn-primary" onclick="joinScreenStream('${peerId}')" style="margin-top:4px; padding:6px 12px; font-size:12px;">
                    <span class="material-symbols-outlined" style="font-size:16px;">play_arrow</span> Смотреть стрим
                </button>
            </div>
            ` : ''}

            <div class="tile-hover-controls">
                <button class="tile-ctrl-btn" title="Закрепить" onclick="togglePinTile('${tileId}')">
                    <span class="material-symbols-outlined">keep</span>
                </button>
                <button class="tile-ctrl-btn" title="На весь экран" onclick="toggleNativeFullscreen('${tileId}')">
                    <span class="material-symbols-outlined">fullscreen</span>
                </button>
                ${!isLocal ? `
                <button class="tile-ctrl-btn" title="Дополнительно" onclick="toggleTileMenu('${peerId}', '${tileId}', event, true)">
                    <span class="material-symbols-outlined">more_vert</span>
                </button>
                ` : ''}
            </div>

            <div class="tile-overlay">
                <div></div>
                <div class="tile-tag">
                    <span class="material-symbols-outlined" style="font-size:14px; color:var(--google-blue);">screen_share</span>
                    <span>${escapeHtml(titleName || 'Экран')}</span>
                </div>
            </div>
        `;
        videoGrid.appendChild(tile);
    }

    const videoEl = document.getElementById(`video-screen-${peerId}`);
    if (videoEl && stream && isLocal) {
        videoEl.srcObject = stream;
        videoEl.play().catch(() => { });
    }

    updateGridCount();
}

window.joinScreenStream = function (peerId) {
    soundFx.click();
    const stream = activeScreenStreams.get(peerId);
    const videoEl = document.getElementById(`video-screen-${peerId}`);
    const card = document.getElementById(`streamCard-${peerId}`);

    if (videoEl && stream) {
        videoEl.srcObject = stream;
        videoEl.muted = false;
        videoEl.play().catch(() => { });
    }
    if (card) card.remove();
    showToast("Вы подключились к стриму", 'play_arrow');
};

/* ==========================================================================
   КОНТЕКСТНОЕ МЕНЮ КАРТОЧКИ И ЗАКРЕПЛЕНИЕ (PIN)
   ========================================================================== */
let activeContextMenu = null;

window.toggleTileMenu = function (peerId, tileId, event, isScreen = false) {
    event.stopPropagation();
    soundFx.click();

    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }

    const tile = document.getElementById(tileId);
    if (!tile) return;

    const menu = document.createElement('div');
    menu.className = 'tile-context-menu';
    const curVol = Math.round((participantVolumes.get(peerId) ?? 1.0) * 100);

    menu.innerHTML = `
        <div class="tile-volume-box">
            <div class="tile-volume-label">
                <span>ГРОМКОСТЬ</span>
                <span id="volLabel-${peerId}">${curVol}%</span>
            </div>
            <input type="range" class="studio-range" min="0" max="1" step="0.05" value="${(curVol / 100)}" 
                   oninput="setPeerVolume('${peerId}', this.value)">
        </div>
        <button class="tile-menu-item" onclick="togglePinTile('${tileId}')">
            <span class="material-symbols-outlined">keep</span>
            <span>${tile.classList.contains('is-stage') ? 'Открепить' : 'Закрепить'}</span>
        </button>
        <button class="tile-menu-item" onclick="toggleNativeFullscreen('${tileId}')">
            <span class="material-symbols-outlined">fullscreen</span>
            <span>Во весь экран</span>
        </button>
        ${net.isHost ? `
            ${isScreen ? `
                <button class="tile-menu-item danger" onclick="adminStopScreenShare('${peerId}')">
                    <span class="material-symbols-outlined">cancel_presentation</span>
                    <span>Остановить показ</span>
                </button>
            ` : `
                <button class="tile-menu-item danger" onclick="kickParticipant('${peerId}')">
                    <span class="material-symbols-outlined">person_remove</span>
                    <span>Исключить</span>
                </button>
            `}
        ` : ''}
    `;

    tile.appendChild(menu);
    activeContextMenu = menu;

    const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            activeContextMenu = null;
            window.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => window.addEventListener('click', closeHandler), 10);
};

window.setPeerVolume = function (peerId, val) {
    const num = parseFloat(val);
    participantVolumes.set(peerId, num);
    const videoCam = document.getElementById(`video-cam-${peerId}`);
    const videoScreen = document.getElementById(`video-screen-${peerId}`);
    if (videoCam) videoCam.volume = num;
    if (videoScreen) videoScreen.volume = num;

    const label = document.getElementById(`volLabel-${peerId}`);
    if (label) label.textContent = `${Math.round(num * 100)}%`;
};

window.togglePinTile = function (tileId) {
    soundFx.click();
    const tile = document.getElementById(tileId);
    if (!tile) return;

    if (pinnedTileId === tileId) {
        pinnedTileId = null;
        tile.classList.remove('is-stage');
    } else {
        document.querySelectorAll('.video-tile').forEach(t => t.classList.remove('is-stage'));
        pinnedTileId = tileId;
        tile.classList.add('is-stage');
    }
    if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
    updateGridCount();
};

window.adminStopScreenShare = function (peerId) {
    if (!net.isHost) return;
    net.send({ type: 'FORCE_STOP_SCREEN' }, peerId);
    removeTile(`tile-screen-${peerId}`);
    showToast("Демонстрация остановлена", 'cancel_presentation');
};

function removeTile(tileId) {
    const tile = document.getElementById(tileId);
    if (tile) {
        if (pinnedTileId === tileId) pinnedTileId = null;
        tile.remove();
    }
    updateGridCount();
    refreshAdminParticipantsList();
}

window.toggleNativeFullscreen = function (tileId) {
    const tile = document.getElementById(tileId);
    if (tile) tile.classList.toggle('pseudo-fullscreen');
    if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
};

/* ==========================================================================
   6. РУКА И ДЕМОНСТРАЦИЯ ЭКРАНА
   ========================================================================== */
function toggleHandRaise() {
    isHandRaised = !isHandRaised;
    btnHandRaise.classList.toggle('active-yellow', isHandRaised);
    sheetBtnHand.classList.toggle('active', isHandRaised);
    myHandBadge.classList.toggle('p2p-hidden', !isHandRaised);

    if (isHandRaised) {
        soundFx.hand();
        showToast("Вы подняли руку", 'back_hand');
    }

    net.broadcast({
        type: 'HAND_RAISE',
        peerId: net.peer?.id,
        isRaised: isHandRaised,
        name: myName
    });
}
btnHandRaise.onclick = toggleHandRaise;
sheetBtnHand.onclick = () => { toggleHandRaise(); closeMobileSheet(); };

async function toggleScreenShare() {
    soundFx.click();
    if (!net.allowScreenShare && !net.isHost) {
        return showToast("Администратор отключил показ экрана", 'block');
    }

    if (isScreenSharing) {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        isScreenSharing = false;
        btnScreenShare.classList.remove('active');
        sheetBtnScreen.classList.remove('active');
        removeTile('tile-screen-local');
        net.stopScreenShare();
    } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            return showToast("Демонстрация не поддерживается", 'error');
        }
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isScreenSharing = true;
            btnScreenShare.classList.add('active');
            sheetBtnScreen.classList.add('active');
            addOrUpdateScreenTile('local', screenStream, `${myName} (Экран)`, true);
            net.startScreenShare(screenStream, myName);
            screenStream.getVideoTracks()[0].onended = () => toggleScreenShare();
        } catch (err) {
            if (err.name !== 'NotAllowedError') showToast("Ошибка экрана", 'error');
        }
    }
}
btnScreenShare.onclick = toggleScreenShare;
sheetBtnScreen.onclick = () => { toggleScreenShare(); closeMobileSheet(); };

/* ==========================================================================
   7. МОБИЛЬНЫЙ BOTTOM SHEET
   ========================================================================== */
function openMobileSheet() {
    soundFx.click();
    mobileSheetBackdrop.classList.remove('p2p-hidden');
}

function closeMobileSheet() {
    mobileSheetBackdrop.classList.add('p2p-hidden');
}

btnMoreMobile.onclick = openMobileSheet;
mobileSheetBackdrop.onclick = (e) => {
    if (e.target === mobileSheetBackdrop) closeMobileSheet();
};

sheetBtnChat.onclick = () => { closeMobileSheet(); toggleChatPanel(); };
sheetBtnInvite.onclick = () => { closeMobileSheet(); document.getElementById('btnInviteInfo').click(); };
sheetBtnSettings.onclick = () => { closeMobileSheet(); document.getElementById('btnSettingsOpen').click(); };
sheetBtnAudit.onclick = () => { closeMobileSheet(); document.getElementById('btnOpenLogs').click(); };

/* ==========================================================================
   8. ЧАТ И РЕАКЦИИ
   ========================================================================== */
function toggleChatPanel() {
    soundFx.click();
    const isHidden = chatPanel.classList.toggle('p2p-hidden');
    btnChatToggle.classList.toggle('active', !isHidden);
    if (!isHidden) {
        chatUnreadDot.classList.add('p2p-hidden');
        sheetChatBadge.classList.add('p2p-hidden');
        setTimeout(() => inputChatMessage.focus(), 100);
    }
}
btnChatToggle.onclick = toggleChatPanel;
document.getElementById('btnCloseChat').onclick = toggleChatPanel;
document.getElementById('btnSendChat').onclick = sendChatMessage;
inputChatMessage.onkeydown = (e) => { if (e.key === 'Enter') sendChatMessage(); };

function sendChatMessage() {
    const text = inputChatMessage.value.trim();
    if (!text) return;
    soundFx.chat();
    appendChatMessage("Вы", text, true);
    net.broadcast({ type: 'CHAT_MSG', name: myName, text });
    inputChatMessage.value = '';
}

function appendChatMessage(sender, text, isMe) {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isMe ? 'me' : 'other'}`;
    msgEl.innerHTML = `
        <div class="chat-msg-author">${escapeHtml(sender)}</div>
        <div class="chat-msg-bubble">${escapeHtml(text)}</div>
    `;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!isMe && chatPanel.classList.contains('p2p-hidden')) {
        chatUnreadDot.classList.remove('p2p-hidden');
        sheetChatBadge.classList.remove('p2p-hidden');
        if (showChatToasts) {
            spawnChatToastOverlay(sender, text);
        }
    }
}

function spawnChatToastOverlay(sender, text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-overlay-bubble';
    bubble.innerHTML = `
        <div class="chat-overlay-author">${escapeHtml(sender)}</div>
        <div class="chat-overlay-text">${escapeHtml(text)}</div>
    `;
    bubble.onclick = () => {
        toggleChatPanel();
        bubble.remove();
    };
    chatToastContainer.appendChild(bubble);
    setTimeout(() => bubble.remove(), 5000);
}

btnReactionToggle.onclick = () => {
    soundFx.click();
    reactionBar.classList.toggle('p2p-hidden');
};
btnCloseReactions.onclick = () => reactionBar.classList.add('p2p-hidden');

document.querySelectorAll('.reaction-item-btn').forEach(btn => {
    btn.onclick = () => {
        const emoji = btn.dataset.emoji;
        soundFx.reaction();
        spawnFloatingReaction(emoji);
        net.broadcast({ type: 'REACTION', emoji });
    };
});

function spawnFloatingReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'p2p-float-item';
    el.textContent = emoji;
    el.style.left = (Math.random() * 60 + 20) + '%';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
}

/* ==========================================================================
   9. НАСТРОЙКИ, АДМИНИСТРИРОВАНИЕ И МОДАЛКИ
   ========================================================================== */
const settingsModal = document.getElementById('settingsModal');
const selectVideoInput = document.getElementById('selectVideoInput');
const selectAudioInput = document.getElementById('selectAudioInput');
const selectAudioOutput = document.getElementById('selectAudioOutput');
const chkSoundFx = document.getElementById('chkSoundFx');
const chkChatToasts = document.getElementById('chkChatToasts');
const chkMirrorVideo = document.getElementById('chkMirrorVideo');
const rangeSoundVolume = document.getElementById('rangeSoundVolume');
const chkLockRoom = document.getElementById('chkLockRoom');
const chkAllowScreenShare = document.getElementById('chkAllowScreenShare');
const adminParticipantsList = document.getElementById('adminParticipantsList');

document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
    };
});

document.getElementById('btnSettingsOpen').onclick = async () => {
    soundFx.click();
    const devices = await navigator.mediaDevices.enumerateDevices();
    selectVideoInput.innerHTML = '';
    selectAudioInput.innerHTML = '';
    selectAudioOutput.innerHTML = '';

    let camIdx = 1, micIdx = 1;
    devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.text = d.label || (d.kind === 'videoinput' ? `Камера ${camIdx++}` : `Микрофон ${micIdx++}`);

        if (d.kind === 'videoinput') {
            if (d.deviceId === currentVideoDeviceId) opt.selected = true;
            selectVideoInput.appendChild(opt);
        } else if (d.kind === 'audioinput') {
            if (d.deviceId === currentAudioDeviceId) opt.selected = true;
            selectAudioInput.appendChild(opt);
        } else if (d.kind === 'audiooutput') {
            selectAudioOutput.appendChild(opt);
        }
    });

    updateAdminSettingsUI();
    settingsModal.classList.remove('p2p-hidden');
};

function updateAdminSettingsUI() {
    const isAdmin = net.isHost;
    document.getElementById('adminStatusText').textContent = isAdmin
        ? '👑 Вы являетесь администратором комнаты'
        : `Участник (Хост: ${escapeHtml(net.hostName || 'Host')})`;
    document.getElementById('adminControlsBlock').style.opacity = isAdmin ? '1' : '0.5';
    document.getElementById('adminControlsBlock').style.pointerEvents = isAdmin ? 'auto' : 'none';

    chkLockRoom.checked = net.isLocked;
    chkAllowScreenShare.checked = net.allowScreenShare;
    refreshAdminParticipantsList();
}

function refreshAdminParticipantsList() {
    adminParticipantsList.innerHTML = '';
    const myRow = document.createElement('div');
    myRow.className = 'participant-row';
    myRow.innerHTML = `<span><strong>${escapeHtml(myName)}</strong> (Вы ${net.isHost ? '👑' : ''})</span>`;
    adminParticipantsList.appendChild(myRow);

    net.peers.forEach((record, peerId) => {
        const row = document.createElement('div');
        row.className = 'participant-row';
        row.innerHTML = `
            <span>${escapeHtml(record.name || 'Участник')} ${net.hostId === peerId ? '👑' : ''}</span>
            <div class="participant-row-actions">
                ${net.isHost ? `<button class="admin-kick-btn" onclick="kickParticipant('${peerId}')">Исключить</button>` : ''}
            </div>
        `;
        adminParticipantsList.appendChild(row);
    });
}

window.kickParticipant = function (peerId) {
    if (!net.isHost) return;
    if (confirm("Исключить участника из встречи?")) {
        net.kickPeer(peerId);
        showToast("Участник исключен", 'person_remove');
        refreshAdminParticipantsList();
    }
};

chkLockRoom.onchange = () => {
    if (!net.isHost) return;
    net.setRoomLocked(chkLockRoom.checked);
    showToast(net.isLocked ? "Комната заблокирована" : "Комната открыта", 'lock');
};

chkAllowScreenShare.onchange = () => {
    if (!net.isHost) return;
    net.setScreenShareAllowed(chkAllowScreenShare.checked);
    showToast(net.allowScreenShare ? "Показ экрана разрешен" : "Показ экрана запрещен", 'present_to_all');
};

document.getElementById('btnCloseSettings').onclick = () => settingsModal.classList.add('p2p-hidden');

document.getElementById('btnSaveSettings').onclick = async () => {
    soundFx.enabled = chkSoundFx.checked;
    soundFx.volume = parseFloat(rangeSoundVolume.value);
    showChatToasts = chkChatToasts.checked;
    isMirrored = chkMirrorVideo.checked;
    updateMirrorState();

    const audioId = selectAudioInput.value;
    const videoId = selectVideoInput.value;
    settingsModal.classList.add('p2p-hidden');

    try {
        const newStream = await getSafeUserMedia(currentFacingMode, audioId, videoId);
        currentAudioDeviceId = audioId;
        currentVideoDeviceId = videoId;

        const newVTrack = newStream.getVideoTracks()[0];
        const newATrack = newStream.getAudioTracks()[0];

        if (net.localStream) {
            const oldV = net.localStream.getVideoTracks()[0];
            const oldA = net.localStream.getAudioTracks()[0];
            if (oldV) { net.localStream.removeTrack(oldV); oldV.stop(); }
            if (oldA) { net.localStream.removeTrack(oldA); oldA.stop(); }
            if (newVTrack) net.localStream.addTrack(newVTrack);
            if (newATrack) net.localStream.addTrack(newATrack);
        } else {
            net.localStream = newStream;
        }

        localVideo.srcObject = net.localStream;
        previewVideo.srcObject = net.localStream;

        if (newVTrack) {
            newVTrack.enabled = isCamOn;
            await net.replaceTrack(newVTrack, 'video');
        }
        if (newATrack) {
            newATrack.enabled = isMicOn;
            await net.replaceTrack(newATrack, 'audio');
            localVAD.start(net.localStream);
        }
        showToast("Настройки применены", 'check_circle');
    } catch (e) {
        showToast("Ошибка сохранения устройств", 'error');
    }
};

/* ==========================================================================
   10. ПОДКЛЮЧЕНИЕ К КОМНАТЕ
   ========================================================================== */
document.getElementById('btnCreateRoom').onclick = async () => {
    unlockAudioEngine();
    prepareJoin();
    try {
        const code = await net.createRoom(null, myName, isMicOn, isCamOn);
        setRoomStatus(code);
        myHostCrown.classList.remove('p2p-hidden');
        soundFx.join();
        showToast("Комната создана: " + code, 'check_circle');
    } catch (err) {
        alert("Ошибка создания: " + err.message);
        leaveConference();
    }
};

document.getElementById('btnJoinRoom').onclick = () => {
    unlockAudioEngine();
    const code = inputRoomCode.value.trim();
    if (code.length < 3) return showToast("Введите код", 'warning');
    prepareJoin();
    net.joinRoom(code, { name: myName, isMicOn, isCamOn }).then(() => {
        setRoomStatus(code);
        soundFx.join();
        showToast("Вы подключились", 'check_circle');
    }).catch(err => {
        alert("Не удалось войти: " + err.message);
        leaveConference();
    });
};

function prepareJoin() {
    myName = inputUserName.value.trim() || ("User-" + Math.floor(Math.random() * 900 + 100));
    myTagName.textContent = myName + " (Вы)";
    lobbyScreen.classList.add('p2p-hidden');
    conferenceScreen.classList.remove('p2p-hidden');
    updateMirrorState();
    updateGridCount();
}

function setRoomStatus(code) {
    netBadge.className = "studio-badge online";
    netBadgeText.textContent = `ROOM: ${code}`;
    meetRoomCodeText.textContent = code;
}

meetRoomCodePill.onclick = () => {
    navigator.clipboard.writeText(net.getShareUrl()).then(() => showToast("Ссылка скопирована", 'content_copy'));
};

function leaveConference() {
    soundFx.leave();
    const tiles = document.querySelectorAll('.video-tile:not(#tile-cam-local)');
    tiles.forEach(t => t.remove());
    net.destroy(true);

    conferenceScreen.classList.add('p2p-hidden');
    lobbyScreen.classList.remove('p2p-hidden');
    myHostCrown.classList.add('p2p-hidden');
    netBadge.className = "studio-badge";
    netBadgeText.textContent = "STANDBY";
    pinnedTileId = null;
    closeMobileSheet();
    updateGridCount();
}
document.getElementById('btnLeaveCall').onclick = leaveConference;

net.on('status', ({ online, reconnecting }) => {
    if (reconnecting) {
        netBadge.className = "studio-badge reconnecting";
        netBadgeText.textContent = "RECONNECTING";
    } else if (online) {
        if (net.roomId) setRoomStatus(net.roomId);
        else { netBadge.className = "studio-badge online"; netBadgeText.textContent = "ONLINE"; }
    } else {
        netBadge.className = "studio-badge"; netBadgeText.textContent = "OFFLINE";
    }
});

net.on('remote-stream', ({ peerId, stream, metadata }) => {
    if (metadata?.type === 'screen') {
        addOrUpdateScreenTile(peerId, stream, `${metadata.name || 'Участник'}`);
    } else {
        addOrUpdateCamTile(peerId, stream, metadata?.name, metadata?.isMicOn ?? true, metadata?.isCamOn ?? true);
    }
});

net.on('peer-connected', ({ peerId, name }) => {
    soundFx.join();
    showToast(`${name || 'Новый участник'} присоединился`, 'person_add');
    refreshAdminParticipantsList();
});

net.on('peer-disconnected', ({ peerId }) => {
    soundFx.leave();
    removeTile(`tile-cam-${peerId}`);
    removeTile(`tile-screen-${peerId}`);
});

net.on('kicked', () => {
    soundFx.kick();
    alert("Вы были исключены организатором встречи.");
    leaveConference();
});

net.on('host-changed', ({ isHost, hostName, hostId }) => {
    if (isHost) {
        myHostCrown.classList.remove('p2p-hidden');
        showToast("👑 Вы стали организатором встречи", 'admin_panel_settings');
    } else {
        myHostCrown.classList.add('p2p-hidden');
        showToast(`Организатор сменился: ${hostName}`, 'admin_panel_settings');
    }

    document.querySelectorAll('.host-crown').forEach(c => c.classList.add('p2p-hidden'));
    if (isHost) {
        myHostCrown.classList.remove('p2p-hidden');
    } else {
        const crown = document.getElementById(`crown-cam-${hostId}`);
        if (crown) crown.classList.remove('p2p-hidden');
    }

    updateAdminSettingsUI();
});

net.on('data', (data, senderPeerId) => {
    if (data.type === 'CHAT_MSG') {
        soundFx.chat();
        appendChatMessage(data.name, data.text, false);
    } else if (data.type === 'REACTION') {
        soundFx.reaction();
        spawnFloatingReaction(data.emoji);
    } else if (data.type === 'HAND_RAISE') {
        const targetId = data.peerId || senderPeerId;
        const handEl = document.getElementById(`hand-${targetId}`);
        if (handEl) handEl.classList.toggle('p2p-hidden', !data.isRaised);
        if (data.isRaised) {
            soundFx.hand();
            showToast(`${data.name || 'Участник'} поднял(а) руку ✋`, 'back_hand');
        }
    } else if (data.type === 'VAD_ACTIVITY') {
        const targetId = data.peerId || senderPeerId;
        const tile = document.getElementById(`tile-cam-${targetId}`);
        if (tile) tile.classList.toggle('speaking', !!data.isSpeaking);
    } else if (data.type === 'MIC_STATUS') {
        const micEl = document.getElementById(`mic-cam-${senderPeerId}`);
        if (micEl) {
            micEl.textContent = data.isMicOn ? 'mic' : 'mic_off';
            micEl.style.color = data.isMicOn ? 'var(--google-green)' : 'var(--google-red)';
        }
    } else if (data.type === 'CAM_STATUS') {
        const vid = document.getElementById(`video-cam-${senderPeerId}`);
        const avt = document.getElementById(`avatar-cam-${senderPeerId}`);
        if (vid && avt) {
            vid.style.display = data.isCamOn ? 'block' : 'none';
            avt.style.display = data.isCamOn ? 'none' : 'flex';
        }
    } else if (data.type === 'SCREEN_STOPPED') {
        removeTile(`tile-screen-${senderPeerId}`);
    } else if (data.type === 'FORCE_STOP_SCREEN') {
        if (isScreenSharing) {
            toggleScreenShare();
            showToast("Демонстрация остановлена администратором", 'cancel_presentation');
        }
    } else if (data.type === 'SCREEN_PERM_CHANGED') {
        if (!data.allowed && isScreenSharing) {
            toggleScreenShare();
            showToast("Демонстрация экрана отключена администратором", 'block');
        }
    }
});

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

document.getElementById('btnInviteInfo').onclick = () => {
    document.getElementById('modalRoomCode').textContent = net.roomId;
    const qrEl = document.getElementById('modalQrCode'); qrEl.innerHTML = "";
    new QRCode(qrEl, { text: net.getShareUrl(), width: 140, height: 140, colorDark: "#131314", colorLight: "#ffffff" });
    document.getElementById('inviteModal').classList.remove('p2p-hidden');
};
document.getElementById('btnCloseInviteModal').onclick = () => document.getElementById('inviteModal').classList.add('p2p-hidden');
document.getElementById('btnCopyInviteLink').onclick = () => {
    navigator.clipboard.writeText(net.getShareUrl()).then(() => showToast("Ссылка скопирована", 'content_copy'));
};

window.addEventListener('load', async () => {
    await initPreview();
    const hash = window.location.hash.substring(1).trim();
    if (hash.length >= 3) {
        inputRoomCode.value = P2PNet.cleanCode(hash);
    }
});
