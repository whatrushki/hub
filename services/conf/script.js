/* ==========================================================================
           1. СИСТЕМА АУДИТА
           ========================================================================== */
window.P2PAuditLog = {
    logs: [],
    add(category, message, extra = null) {
        const time = new Date().toTimeString().split(' ')[0] + '.' + String(Date.now() % 1000).padStart(3, '0');
        const extraStr = extra ? (typeof extra === 'object' ? JSON.stringify(extra) : String(extra)) : '';
        this.logs.push({ time, category, message, extra: extraStr });
        if (this.logs.length > 600) this.logs.shift();

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
   2. РАСПРЕДЕЛЕННЫЙ VAD (БЕЗ ПЕРЕХВАТА УДАЛЕННОГО АУДИО)
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

                if (avg > 15) {
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

// Разблокировка системного звука при первом клике
function unlockAudioEngine() {
    localVAD.init();
    document.querySelectorAll('video').forEach(v => {
        if (v.id !== 'localVideo' && v.id !== 'previewVideo') {
            v.muted = false;
            v.volume = 1.0;
            v.play().catch(() => { });
        }
    });
}
window.addEventListener('click', unlockAudioEngine, { once: true });
window.addEventListener('touchstart', unlockAudioEngine, { once: true });

/* ==========================================================================
   3. ИНИЦИАЛИЗАЦИЯ И МЕДИА
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
const videoGrid = document.getElementById('videoGrid');

const btnMicToggle = document.getElementById('btnMicToggle');
const btnCamToggle = document.getElementById('btnCamToggle');
const btnFlipCam = document.getElementById('btnFlipCam');
const btnScreenShare = document.getElementById('btnScreenShare');
const btnHandRaise = document.getElementById('btnHandRaise');
const btnReactionToggle = document.getElementById('btnReactionToggle');
const reactionBar = document.getElementById('reactionBar');
const btnChatToggle = document.getElementById('btnChatToggle');
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const inputChatMessage = document.getElementById('inputChatMessage');

function showToast(msg, icon = 'info') {
    toastText.textContent = msg;
    toastIcon.textContent = icon;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2400);
}

function updateGridCount() {
    const count = videoGrid.children.length;
    videoGrid.classList.remove('count-1', 'count-2', 'count-3', 'count-4', 'count-many');
    if (count <= 1) videoGrid.classList.add('count-1');
    else if (count === 2) videoGrid.classList.add('count-2');
    else if (count === 3) videoGrid.classList.add('count-3');
    else if (count === 4) videoGrid.classList.add('count-4');
    else videoGrid.classList.add('count-many');
}

function updateMirrorState() {
    const isFront = (currentFacingMode === 'user');
    if (previewTile) previewTile.classList.toggle('mirrored', isFront);
    if (tileCamLocal) tileCamLocal.classList.toggle('mirrored', isFront);
}

async function getSafeUserMedia(facingMode = 'user', audioId = null, videoId = null) {
    const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(audioId ? { deviceId: { exact: audioId } } : {})
    };

    if (videoId) {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: videoId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: audioConstraints
            });
        } catch (e) {
            window.P2PAuditLog.add('WARN', `Точный deviceId ${videoId} недоступен, откат к facingMode`);
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
        window.P2PAuditLog.add('ERR', `Ошибка камеры/микрофона: ${e.message}`);
        isCamOn = false; isMicOn = false;
        previewAvatar.style.display = 'flex';
        myAvatar.style.display = 'flex';
        btnCamToggle.classList.add('off');
        btnMicToggle.classList.add('off');
    }
}

async function flipCamera() {
    const nextMode = (currentFacingMode === 'user') ? 'environment' : 'user';
    window.P2PAuditLog.add('MEDIA', `Переключение камеры на: ${nextMode}`);
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
        window.P2PAuditLog.add('ERR', `Ошибка переключения: ${err.message}`);
        showToast("Ошибка смены камеры", 'error');
    }
}

btnFlipCam.onclick = flipCamera;
document.getElementById('btnFlipCamPreview').onclick = flipCamera;

function toggleCamera() {
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
   4. ПОТОКИ И КАРТОЧКИ УЧАСТНИКОВ
   ========================================================================== */
function addOrUpdateCamTile(peerId, stream, participantName) {
    const tileId = `tile-cam-${peerId}`;
    let tile = document.getElementById(tileId);

    if (!tile) {
        window.P2PAuditLog.add('MEDIA', `Создание видео-карточки [${peerId}] (${participantName || 'Guest'})`);
        tile = document.createElement('div');
        tile.className = 'video-tile';
        tile.id = tileId;
        tile.innerHTML = `
                    <video id="video-cam-${peerId}" autoplay playsinline></video>
                    <div id="avatar-cam-${peerId}" class="tile-avatar" style="display:none;">
                        <span class="material-symbols-outlined" style="font-size:32px;">person</span>
                    </div>
                    <div class="tile-overlay">
                        <div class="tile-top-actions">
                            <div class="hand-badge p2p-hidden" id="hand-${peerId}">✋ Рука</div>
                            <button class="tile-action-btn" title="На весь экран" onclick="toggleNativeFullscreen('${tileId}')">
                                <span class="material-symbols-outlined">fullscreen</span>
                            </button>
                        </div>
                        <div class="tile-tag">
                            <span id="mic-cam-${peerId}" class="material-symbols-outlined" style="font-size:14px; color:var(--google-green);">mic</span>
                            <span id="name-cam-${peerId}">${escapeHtml(participantName || 'Участник')}</span>
                        </div>
                    </div>
                `;
        videoGrid.appendChild(tile);
    }

    const videoEl = document.getElementById(`video-cam-${peerId}`);
    if (videoEl && stream) {
        videoEl.srcObject = stream;
        videoEl.muted = false; // ГАРАНТИЯ ЗВУКА
        videoEl.volume = 1.0;

        videoEl.play().catch(err => {
            window.P2PAuditLog.add('WARN', `Autoplay требует взаимодействия на этом устройстве: ${err.message}`);
        });
    }
    updateGridCount();
}

function addOrUpdateScreenTile(peerId, stream, titleName, isLocal = false) {
    const tileId = `tile-screen-${peerId}`;
    let tile = document.getElementById(tileId);

    if (!tile) {
        tile = document.createElement('div');
        tile.className = 'video-tile screen-tile';
        tile.id = tileId;
        tile.innerHTML = `
                    <video id="video-screen-${peerId}" autoplay playsinline ${isLocal ? 'muted' : ''}></video>
                    <div class="tile-overlay">
                        <div class="tile-top-actions">
                            <button class="tile-action-btn" title="На весь экран" onclick="toggleNativeFullscreen('${tileId}')">
                                <span class="material-symbols-outlined">fullscreen</span>
                            </button>
                        </div>
                        <div class="tile-tag">
                            <span class="material-symbols-outlined" style="font-size:14px; color:var(--google-blue);">screen_share</span>
                            <span>${escapeHtml(titleName || 'Экран')}</span>
                        </div>
                    </div>
                `;
        videoGrid.appendChild(tile);
    }

    const videoEl = document.getElementById(`video-screen-${peerId}`);
    if (videoEl && stream) {
        videoEl.srcObject = stream;
        if (!isLocal) { videoEl.muted = false; videoEl.volume = 1.0; }
        videoEl.play().catch(() => { });
    }
    updateGridCount();
}

function removeTile(tileId) {
    const tile = document.getElementById(tileId);
    if (tile) tile.remove();
    updateGridCount();
}

window.toggleNativeFullscreen = function (tileId) {
    const tile = document.getElementById(tileId);
    if (tile) tile.classList.toggle('pseudo-fullscreen');
};

/* ==========================================================================
   5. РУКА И ДЕМОНСТРАЦИЯ ЭКРАНА
   ========================================================================== */
function toggleHandRaise() {
    isHandRaised = !isHandRaised;
    btnHandRaise.classList.toggle('active-yellow', isHandRaised);
    myHandBadge.classList.toggle('p2p-hidden', !isHandRaised);

    net.broadcast({
        type: 'HAND_RAISE',
        peerId: net.peer?.id,
        isRaised: isHandRaised,
        name: myName
    });

    if (isHandRaised) showToast("Вы подняли руку", 'back_hand');
}
btnHandRaise.onclick = toggleHandRaise;

async function toggleScreenShare() {
    if (isScreenSharing) {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        isScreenSharing = false;
        btnScreenShare.classList.remove('active');
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
            addOrUpdateScreenTile('local', screenStream, `${myName} (Экран)`, true);
            net.startScreenShare(screenStream, myName);
            screenStream.getVideoTracks()[0].onended = () => toggleScreenShare();
        } catch (err) {
            if (err.name !== 'NotAllowedError') showToast("Ошибка экрана", 'error');
        }
    }
}
btnScreenShare.onclick = toggleScreenShare;

/* ==========================================================================
   6. НАСТРОЙКИ ОБОРУДОВАНИЯ (СПИСОК ВСЕХ КАМЕР)
   ========================================================================== */
const settingsModal = document.getElementById('settingsModal');
const selectVideoInput = document.getElementById('selectVideoInput');
const selectAudioInput = document.getElementById('selectAudioInput');
const selectAudioOutput = document.getElementById('selectAudioOutput');

document.getElementById('btnSettingsOpen').onclick = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    selectVideoInput.innerHTML = '';
    selectAudioInput.innerHTML = '';
    selectAudioOutput.innerHTML = '';

    let camIndex = 1;
    devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.text = d.label || `${d.kind === 'videoinput' ? 'Камера ' + (camIndex++) : d.kind} (${d.deviceId.slice(0, 5)}...)`;

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

    settingsModal.classList.remove('p2p-hidden');
};

document.getElementById('btnCloseSettings').onclick = () => settingsModal.classList.add('p2p-hidden');
document.getElementById('btnSaveSettings').onclick = async () => {
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

        showToast("Устройства обновлены", 'check_circle');
    } catch (e) {
        showToast("Ошибка смены оборудования", 'error');
    }
};

/* ==========================================================================
   7. СЕТЬ И СОЕДИНЕНИЕ
   ========================================================================== */
document.getElementById('btnCreateRoom').onclick = async () => {
    unlockAudioEngine();
    prepareJoin();
    try {
        const code = await net.createRoom(null, myName);
        setRoomStatus(code);
        showToast("Комната создана: " + code, 'check_circle');
    } catch (err) {
        alert("Ошибка: " + err.message);
        leaveConference();
    }
};

document.getElementById('btnJoinRoom').onclick = () => {
    unlockAudioEngine();
    const code = inputRoomCode.value.trim();
    if (code.length < 3) return showToast("Введите код", 'warning');
    prepareJoin();
    net.joinRoom(code, { name: myName }).then(() => {
        setRoomStatus(code);
        showToast("Успешный вход", 'check_circle');
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
}

function leaveConference() {
    const tiles = document.querySelectorAll('.video-tile:not(#tile-cam-local)');
    tiles.forEach(t => t.remove());
    net.destroy(true);

    conferenceScreen.classList.add('p2p-hidden');
    lobbyScreen.classList.remove('p2p-hidden');
    netBadge.className = "studio-badge";
    netBadgeText.textContent = "STANDBY";
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
        addOrUpdateScreenTile(peerId, stream, `${metadata.name || 'Участник'} (Экран)`);
    } else {
        addOrUpdateCamTile(peerId, stream, metadata?.name);
    }
});

net.on('peer-disconnected', ({ peerId }) => {
    removeTile(`tile-cam-${peerId}`);
    removeTile(`tile-screen-${peerId}`);
});

net.on('data', (data, senderPeerId) => {
    if (data.type === 'CHAT_MSG') {
        appendChatMessage(data.name, data.text, false);
    } else if (data.type === 'REACTION') {
        spawnFloatingReaction(data.emoji);
    } else if (data.type === 'HAND_RAISE') {
        const targetId = data.peerId || senderPeerId;
        const handEl = document.getElementById(`hand-${targetId}`);
        if (handEl) handEl.classList.toggle('p2p-hidden', !data.isRaised);
        if (data.isRaised) showToast(`${data.name || 'Участник'} поднял(а) руку ✋`, 'back_hand');
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
    }
});

/* ==========================================================================
   8. ЧАТ И ЭМОДЗИ (СТРОГО СНИЗУ ВВЕРХ)
   ========================================================================== */
btnChatToggle.onclick = () => chatPanel.classList.toggle('p2p-hidden');
document.getElementById('btnCloseChat').onclick = () => chatPanel.classList.add('p2p-hidden');
document.getElementById('btnSendChat').onclick = sendChatMessage;
inputChatMessage.onkeydown = (e) => { if (e.key === 'Enter') sendChatMessage(); };

function sendChatMessage() {
    const text = inputChatMessage.value.trim();
    if (!text) return;
    appendChatMessage("You", text, true);
    net.broadcast({ type: 'CHAT_MSG', name: myName, text });
    inputChatMessage.value = '';
}

function appendChatMessage(sender, text, isMe) {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isMe ? 'me' : 'other'}`;
    msgEl.innerHTML = `
                <div style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(sender)}</div>
                <div class="chat-msg-bubble">${escapeHtml(text)}</div>
            `;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

btnReactionToggle.onclick = () => reactionBar.classList.toggle('p2p-hidden');
document.querySelectorAll('.reaction-item-btn').forEach(btn => {
    btn.onclick = () => {
        const emoji = btn.dataset.emoji;
        spawnFloatingReaction(emoji);
        net.broadcast({ type: 'REACTION', emoji });
        reactionBar.classList.add('p2p-hidden');
    };
});

function spawnFloatingReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'p2p-float-item';
    el.textContent = emoji;
    // Рандом по горизонтали
    el.style.left = (Math.random() * 60 + 20) + '%';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

document.getElementById('btnInviteInfo').onclick = () => {
    document.getElementById('modalRoomCode').textContent = net.roomId;
    const qrEl = document.getElementById('modalQrCode'); qrEl.innerHTML = "";
    new QRCode(qrEl, { text: net.getShareUrl(), width: 130, height: 130, colorDark: "#131314", colorLight: "#ffffff" });
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