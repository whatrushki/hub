/**
 * P2PNet - Универсальная библиотека надежного WebRTC взаимодействия на базе PeerJS
 * Поддерживает: 1v1 (Duo), Multi-Peer (Mesh), потоковую передачу файлов и медиа (Аудио/Видео/Экран).
 */
class P2PNet {
    static ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // Исключены 0, O, 1, I, L для удобства ввода
    static CHUNK_SIZE = 16 * 1024; // 16 KB для стабильной передачи бинарных данных

    static DEFAULT_ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];

    constructor(options = {}) {
        this.appPrefix = options.appPrefix || 'p2papp';
        this.mode = options.mode || 'duo'; // 'duo' (1v1) или 'mesh' (конференции / мультиплеер)
        this.debug = options.debug || false;
        this.iceServers = options.iceServers || P2PNet.DEFAULT_ICE_SERVERS;

        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isDestroyed = false;

        // Хранилище соединений: { [peerId]: { conn, call, queue: [], name: '' } }
        this.peers = new Map();
        this.localStream = null;

        // Внутренний Event Emitter
        this._events = {};

        // Регистрация на смену hash в URL
        this._initUrlSync();
    }

    /* ================= 1. EVENT EMITTER ================= */
    on(event, handler) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(handler);
        return this;
    }

    off(event, handler) {
        if (!this._events[event]) return;
        this._events[event] = this._events[event].filter(h => h !== handler);
    }

    emit(event, ...args) {
        if (this._events[event]) {
            this._events[event].forEach(h => {
                try { h(...args); } catch (e) { console.error(`[P2PNet] Event error '${event}':`, e); }
            });
        }
    }

    _log(...args) {
        if (this.debug) console.log(`[P2PNet:${this.appPrefix}]`, ...args);
    }

    /* ================= 2. КОМНАТЫ И ПОДКЛЮЧЕНИЕ ================= */
    static generateCode(len = 5) {
        let res = "";
        for (let i = 0; i < len; i++) {
            res += P2PNet.ALPHABET.charAt(Math.floor(Math.random() * P2PNet.ALPHABET.length));
        }
        return res;
    }

    static cleanCode(str) {
        if (!str) return "";
        return str.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
    }

    // Создать комнату (Хост)
    async createRoom(customCode = null, maxRetries = 3) {
        this.isHost = true;
        let attempts = 0;

        while (attempts < maxRetries) {
            attempts++;
            const code = customCode || P2PNet.generateCode();
            const fullPeerId = `${this.appPrefix}-${code}`;

            try {
                await this._initPeer(fullPeerId);
                this.roomId = code;
                this._log(`Комната создана: ${this.roomId}`);
                this.emit('room-created', { roomId: this.roomId, isHost: true });
                return this.roomId;
            } catch (err) {
                if (err.type === 'unavailable-id' && !customCode) {
                    this._log(`ID ${code} занят, пробуем другой...`);
                    continue;
                }
                throw err;
            }
        }
        throw new Error("Не удалось занять ID комнаты после нескольких попыток.");
    }

    // Подключиться к комнате (Клиент)
    async joinRoom(code, myData = {}) {
        this.isHost = false;
        this.roomId = P2PNet.cleanCode(code);
        const hostPeerId = `${this.appPrefix}-${this.roomId}`;

        await this._initPeer(); // Клиент получает динамический peerId от сервера
        this._log(`Подключение к хосту: ${hostPeerId}`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Таймаут подключения к комнате")), 10000);

            this._connectToPeer(hostPeerId, {
                onOpen: (conn) => {
                    clearTimeout(timer);
                    this.emit('joined-room', { roomId: this.roomId, isHost: false });
                    // Если Mesh, отправляем запрос хосту со своими данными
                    if (this.mode === 'mesh') {
                        conn.send({ __sys: 'JOIN_REQ', peerId: this.peer.id, ...myData });
                    }
                    resolve();
                },
                onError: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    _initPeer(fixedId = null) {
        return new Promise((resolve, reject) => {
            this.destroy();
            this.isDestroyed = false;

            const config = {
                debug: this.debug ? 1 : 0,
                config: { iceServers: this.iceServers }
            };

            this.peer = fixedId ? new Peer(fixedId, config) : new Peer(config);

            let opened = false;
            this.peer.on('open', (id) => {
                opened = true;
                this._log(`PeerJS онлайн. Мой ID: ${id}`);
                this.emit('status', { online: true, id });
                resolve(id);
            });

            this.peer.on('connection', (conn) => this._handleIncomingConnection(conn));
            this.peer.on('call', (call) => this._handleIncomingCall(call));

            this.peer.on('disconnected', () => {
                this._log("Потеряно соединение с сигнальным сервером. Авто-реконнект...");
                this.emit('status', { online: false, reconnecting: true });
                if (!this.isDestroyed && this.peer) {
                    try { this.peer.reconnect(); } catch (e) { }
                }
            });

            this.peer.on('error', (err) => {
                this._log("Peer error:", err.type, err);
                this.emit('error', err);
                if (!opened) reject(err);
            });
        });
    }

    /* ================= 3. ОБРАБОТКА ДАННЫХ И СООБЩЕНИЙ ================= */
    _connectToPeer(remotePeerId, callbacks = {}) {
        if (this.peers.has(remotePeerId)) return this.peers.get(remotePeerId).conn;

        const conn = this.peer.connect(remotePeerId, { reliable: true });
        const peerRecord = { conn, call: null, queue: [], isReady: false, name: '' };
        this.peers.set(remotePeerId, peerRecord);

        conn.on('open', () => {
            peerRecord.isReady = true;
            this._log(`Канал данных открыт c: ${remotePeerId}`);
            // Сброс очереди сообщений, если отправляли до коннекта
            while (peerRecord.queue.length > 0) {
                const queuedData = peerRecord.queue.shift();
                conn.send(queuedData);
            }
            if (callbacks.onOpen) callbacks.onOpen(conn);
            this.emit('peer-connected', { peerId: remotePeerId, totalPeers: this.peers.size });
        });

        this._bindDataEvents(conn, peerRecord);
        return conn;
    }

    _handleIncomingConnection(conn) {
        this._log(`Входящее P2P соединение от: ${conn.peer}`);
        const peerRecord = { conn, call: null, queue: [], isReady: false, name: '' };
        this.peers.set(conn.peer, peerRecord);

        conn.on('open', () => {
            peerRecord.isReady = true;
            this.emit('peer-connected', { peerId: conn.peer, totalPeers: this.peers.size });
        });

        this._bindDataEvents(conn, peerRecord);
    }

    _bindDataEvents(conn, peerRecord) {
        conn.on('data', (packet) => {
            if (!packet || typeof packet !== 'object') return;

            // Обработка системных управляющих пакетов
            if (packet.__sys) {
                this._handleSystemPacket(conn.peer, packet);
                return;
            }

            // Обработка передачи файлов
            if (packet.__fileChunk) {
                this._handleFileChunk(conn.peer, packet);
                return;
            }

            // Обычные прикладные данные
            this.emit('data', packet, conn.peer);
        });

        conn.on('close', () => {
            this._log(`Соединение закрыто с ${conn.peer}`);
            this.peers.delete(conn.peer);
            this.emit('peer-disconnected', { peerId: conn.peer, totalPeers: this.peers.size });
        });

        conn.on('error', (err) => {
            this._log(`Ошибка канала ${conn.peer}:`, err);
        });
    }

    _handleSystemPacket(senderPeerId, packet) {
        if (packet.__sys === 'JOIN_REQ' && this.isHost) {
            // Хост отправляет новому пиру список всех текущих участников Mesh
            const members = Array.from(this.peers.keys()).map(id => ({ peerId: id, name: this.peers.get(id).name }));
            this.send({ __sys: 'ROOM_MEMBERS', members, hostId: this.peer.id }, senderPeerId);

            // Оповещаем остальных участников о новичке
            this.broadcast({ __sys: 'NEW_PEER', peerId: senderPeerId, name: packet.name || '' }, [senderPeerId]);
            if (packet.name) this.peers.get(senderPeerId).name = packet.name;

            // Если включено видео - звоним новичку
            if (this.localStream) this.call(senderPeerId, this.localStream);
        }
        else if (packet.__sys === 'ROOM_MEMBERS') {
            // Клиент получил список участников и подключается ко всем для Full Mesh
            packet.members.forEach(m => {
                if (m.peerId !== this.peer.id && !this.peers.has(m.peerId)) {
                    this._connectToPeer(m.peerId);
                    if (this.localStream) this.call(m.peerId, this.localStream);
                }
            });
        }
        else if (packet.__sys === 'NEW_PEER') {
            // К Mesh подключился новый пир
            if (packet.peerId !== this.peer.id && !this.peers.has(packet.peerId)) {
                this._connectToPeer(packet.peerId);
                if (this.localStream) this.call(packet.peerId, this.localStream);
            }
        }
    }

    // Безопасная отправка данных конкретному пиру (или хосту в режиме 1v1)
    send(data, targetPeerId = null) {
        const peerId = targetPeerId || (this.peers.keys().next().value);
        if (!peerId) {
            this._log("Предупреждение: нет подключенных пиров для отправки.");
            return false;
        }

        const peerRecord = this.peers.get(peerId);
        if (!peerRecord) return false;

        if (peerRecord.isReady && peerRecord.conn.open) {
            peerRecord.conn.send(data);
        } else {
            // Очередь до момента открытия сокета
            peerRecord.queue.push(data);
        }
        return true;
    }

    // Отправка всем подключенным (Mesh или комната)
    broadcast(data, excludePeerIds = []) {
        this.peers.forEach((peerRecord, peerId) => {
            if (!excludePeerIds.includes(peerId)) {
                this.send(data, peerId);
            }
        });
    }

    /* ================= 4. ПОТОКОВАЯ ПЕРЕДАЧА ФАЙЛОВ ================= */
    // Отправка файла с контролем Backpressure (не переполняет память)
    async sendFile(file, targetPeerId = null, onProgress = null) {
        const peerId = targetPeerId || (this.peers.keys().next().value);
        const peerRecord = this.peers.get(peerId);
        if (!peerRecord || !peerRecord.conn || !peerRecord.conn.open) {
            throw new Error("Канал передачи недоступен.");
        }

        const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const totalSize = file.size;

        // Оповещаем о начале файла
        this.send({
            __sys: 'FILE_START',
            id: fileId,
            name: file.name,
            size: totalSize,
            type: file.type || 'application/octet-stream'
        }, peerId);

        let offset = 0;
        const dc = peerRecord.conn._dc || peerRecord.conn.dataChannel;

        while (offset < totalSize) {
            // Защита от переполнения буфера WebRTC (Backpressure)
            while (dc && dc.bufferedAmount > 256 * 1024) {
                await new Promise(r => setTimeout(r, 20));
            }

            const slice = file.slice(offset, offset + P2PNet.CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();

            this.send({
                __fileChunk: true,
                id: fileId,
                data: buffer
            }, peerId);

            offset += buffer.byteLength;
            if (onProgress) {
                const percent = totalSize === 0 ? 100 : Math.round((offset / totalSize) * 100);
                onProgress({ fileId, offset, total: totalSize, percent });
            }
        }

        // Ждем окончательного сброса буфера сокета
        while (dc && dc.bufferedAmount > 0) {
            await new Promise(r => setTimeout(r, 20));
        }

        this.send({ __sys: 'FILE_END', id: fileId }, peerId);
        return fileId;
    }

    _handleFileChunk(senderPeerId, packet) {
        if (!this._incomingFiles) this._incomingFiles = {};
        const item = this._incomingFiles[packet.id];
        if (!item) return;

        item.chunks.push(packet.data);
        item.receivedBytes += packet.data.byteLength || 0;

        const percent = item.size === 0 ? 100 : Math.round((item.receivedBytes / item.size) * 100);
        this.emit('file-progress', {
            fileId: packet.id,
            name: item.name,
            percent,
            receivedBytes: item.receivedBytes,
            totalBytes: item.size
        }, senderPeerId);
    }

    /* ================= 5. АУДИО / ВИДЕО / МЕДИА ================= */
    async startMedia(constraints = { video: true, audio: true }) {
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        this.emit('local-stream', this.localStream);

        // Если уже есть участники — звоним всем
        this.peers.forEach((peerRecord, peerId) => {
            this.call(peerId, this.localStream);
        });
        return this.localStream;
    }

    call(remotePeerId, stream) {
        if (!this.peer || this.peer.destroyed) return;
        const call = this.peer.call(remotePeerId, stream);
        if (this.peers.has(remotePeerId)) {
            this.peers.get(remotePeerId).call = call;
        }

        call.on('stream', (remoteStream) => {
            this.emit('remote-stream', { peerId: remotePeerId, stream: remoteStream });
        });
    }

    _handleIncomingCall(call) {
        this._log(`Входящий медиазвонок от ${call.peer}`);
        call.answer(this.localStream);

        if (this.peers.has(call.peer)) {
            this.peers.get(call.peer).call = call;
        }

        call.on('stream', (remoteStream) => {
            this.emit('remote-stream', { peerId: call.peer, stream: remoteStream });
        });
    }

    // Замена видеотрека (для переключения Камера <-> Демонстрация экрана)
    replaceTrack(newTrack, kind = 'video') {
        this.peers.forEach(peerRecord => {
            if (peerRecord.call && peerRecord.call.peerConnection) {
                const sender = peerRecord.call.peerConnection.getSenders().find(s => s.track && s.track.kind === kind);
                if (sender) sender.replaceTrack(newTrack);
            }
        });
    }

    /* ================= 6. УТИЛИТЫ И ОЧИСТКА ================= */
    _initUrlSync() {
        if (typeof window !== 'undefined' && window.location) {
            window.addEventListener('load', () => {
                if (window.location.hash.length > 1) {
                    const code = P2PNet.cleanCode(window.location.hash.substring(1));
                    this.emit('url-code-detected', code);
                }
            });
        }
    }

    getShareUrl() {
        if (!this.roomId) return window.location.href;
        return window.location.href.split('#')[0] + "#" + this.roomId;
    }

    destroy() {
        this.isDestroyed = true;
        this.peers.forEach(p => {
            if (p.conn) try { p.conn.close(); } catch (e) { }
            if (p.call) try { p.call.close(); } catch (e) { }
        });
        this.peers.clear();

        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }

        if (this.peer && !this.peer.destroyed) {
            try { this.peer.destroy(); } catch (e) { }
            this.peer = null;
        }
        this.roomId = null;
    }
}