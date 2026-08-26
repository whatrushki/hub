/**
 * P2PNet v2.2 - Поддержка независимых потоков Камеры и Экрана
 */
class P2PNet {
    static ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    static CHUNK_SIZE = 16 * 1024;

    static DEFAULT_ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];

    constructor(options = {}) {
        this.appPrefix = options.appPrefix || 'p2papp';
        this.mode = options.mode || 'duo';
        this.debug = options.debug || false;
        this.iceServers = options.iceServers || P2PNet.DEFAULT_ICE_SERVERS;

        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isDestroyed = false;

        this.peers = new Map();
        this.localStream = null;
        this.screenStream = null;
        this.screenCalls = new Map();
        this._events = {};
    }

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
                try { h(...args); } catch (e) { console.error(`[P2PNet] Error in '${event}':`, e); }
            });
        }
    }

    _log(...args) {
        if (this.debug) console.log(`[P2PNet:${this.appPrefix}]`, ...args);
    }

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
        throw new Error("Не удалось создать уникальную комнату.");
    }

    async joinRoom(code, myData = {}) {
        this.isHost = false;
        this.roomId = P2PNet.cleanCode(code);
        const hostPeerId = `${this.appPrefix}-${this.roomId}`;

        await this._initPeer();
        this._log(`Подключение к хосту: ${hostPeerId}`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Таймаут подключения к комнате")), 12000);

            this._connectToPeer(hostPeerId, {
                onOpen: (conn) => {
                    clearTimeout(timer);
                    this.emit('joined-room', { roomId: this.roomId, isHost: false });
                    if (this.mode === 'mesh') {
                        conn.send({ __sys: 'JOIN_REQ', peerId: this.peer.id, ...myData });
                    }
                    resolve(conn);
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
            this.destroy(true);
            this.isDestroyed = false;

            const config = {
                debug: this.debug ? 1 : 0,
                config: { iceServers: this.iceServers }
            };

            this.peer = fixedId ? new Peer(fixedId, config) : new Peer(config);

            let opened = false;
            this.peer.on('open', (id) => {
                opened = true;
                this._log(`PeerJS подключен: ${id}`);
                this.emit('status', { online: true, id });
                resolve(id);
            });

            this.peer.on('connection', (conn) => this._handleIncomingConnection(conn));
            this.peer.on('call', (call) => this._handleIncomingCall(call));

            this.peer.on('disconnected', () => {
                this._log("Потерян сигнал сервера. Реконнект...");
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

    _connectToPeer(remotePeerId, callbacks = {}) {
        if (this.peers.has(remotePeerId)) return this.peers.get(remotePeerId).conn;

        const conn = this.peer.connect(remotePeerId, { reliable: true });
        const peerRecord = { conn, call: null, queue: [], isReady: false, name: '' };
        this.peers.set(remotePeerId, peerRecord);

        conn.on('open', () => {
            peerRecord.isReady = true;
            this._log(`Канал открыт c: ${remotePeerId}`);
            while (peerRecord.queue.length > 0) {
                conn.send(peerRecord.queue.shift());
            }
            if (callbacks.onOpen) callbacks.onOpen(conn);
            this.emit('peer-connected', { peerId: remotePeerId, totalPeers: this.peers.size });
        });

        this._bindDataEvents(conn, peerRecord);
        return conn;
    }

    _handleIncomingConnection(conn) {
        this._log(`Входящий пир: ${conn.peer}`);
        const peerRecord = this.peers.get(conn.peer) || { conn, call: null, queue: [], isReady: false, name: '' };
        peerRecord.conn = conn;
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

            if (packet.__sys) {
                this._handleSystemPacket(conn.peer, packet);
                return;
            }
            this.emit('data', packet, conn.peer);
        });

        conn.on('close', () => {
            this._log(`Пир отключился: ${conn.peer}`);
            this.peers.delete(conn.peer);
            this.screenCalls.delete(conn.peer);
            this.emit('peer-disconnected', { peerId: conn.peer, totalPeers: this.peers.size });
        });

        conn.on('error', (err) => {
            this._log(`Ошибка канала ${conn.peer}:`, err);
        });
    }

    _handleSystemPacket(senderPeerId, packet) {
        if (packet.__sys === 'JOIN_REQ' && this.isHost) {
            const members = Array.from(this.peers.keys()).map(id => ({ peerId: id, name: this.peers.get(id)?.name || '' }));
            this.send({ __sys: 'ROOM_MEMBERS', members, hostId: this.peer.id }, senderPeerId);
            this.broadcast({ __sys: 'NEW_PEER', peerId: senderPeerId, name: packet.name || '' }, [senderPeerId]);

            if (this.peers.has(senderPeerId)) this.peers.get(senderPeerId).name = packet.name;

            if (this.localStream) {
                setTimeout(() => this.call(senderPeerId, this.localStream, { type: 'camera' }), 300);
            }
            if (this.screenStream) {
                setTimeout(() => this.callScreen(senderPeerId, this.screenStream), 500);
            }
        }
        else if (packet.__sys === 'ROOM_MEMBERS') {
            packet.members.forEach(m => {
                if (m.peerId !== this.peer.id && !this.peers.has(m.peerId)) {
                    this._connectToPeer(m.peerId);
                }
            });
        }
        else if (packet.__sys === 'NEW_PEER') {
            if (packet.peerId !== this.peer.id && !this.peers.has(packet.peerId)) {
                this._connectToPeer(packet.peerId);
                if (this.localStream) {
                    setTimeout(() => this.call(packet.peerId, this.localStream, { type: 'camera' }), 300);
                }
                if (this.screenStream) {
                    setTimeout(() => this.callScreen(packet.peerId, this.screenStream), 500);
                }
            }
        }
    }

    send(data, targetPeerId = null) {
        const peerId = targetPeerId || (this.peers.keys().next().value);
        if (!peerId) return false;

        const peerRecord = this.peers.get(peerId);
        if (!peerRecord) return false;

        if (peerRecord.isReady && peerRecord.conn?.open) {
            peerRecord.conn.send(data);
        } else {
            peerRecord.queue.push(data);
        }
        return true;
    }

    broadcast(data, excludePeerIds = []) {
        this.peers.forEach((peerRecord, peerId) => {
            if (!excludePeerIds.includes(peerId)) {
                this.send(data, peerId);
            }
        });
    }

    /* МЕДИА-ЗВОНКИ (КАМЕРА И ЭКРАН) */
    async startMedia(constraints = { video: true, audio: true }) {
        if (this.localStream && this.localStream.active) {
            return this.localStream;
        }
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        this.emit('local-stream', this.localStream);
        return this.localStream;
    }

    call(remotePeerId, stream, metadata = { type: 'camera' }) {
        if (!this.peer || this.peer.destroyed) return;
        const mediaStream = stream || this.localStream;
        if (!mediaStream) return;

        this._log(`Исходящий звонок [${metadata.type}] к: ${remotePeerId}`);
        const call = this.peer.call(remotePeerId, mediaStream, { metadata });
        if (!call) return;

        let peerRecord = this.peers.get(remotePeerId);
        if (!peerRecord) {
            peerRecord = { conn: null, call, queue: [], isReady: false, name: '' };
            this.peers.set(remotePeerId, peerRecord);
        } else {
            peerRecord.call = call;
        }

        call.on('stream', (remoteStream) => {
            this._log(`Получен stream [${metadata.type}] от ${remotePeerId}`);
            this.emit('remote-stream', { peerId: remotePeerId, stream: remoteStream, metadata });
        });
    }

    callScreen(remotePeerId, stream, senderName = '') {
        if (!this.peer || this.peer.destroyed || !stream) return;
        this._log(`Исходящий звонок ЭКРАНА к: ${remotePeerId}`);
        const call = this.peer.call(remotePeerId, stream, { metadata: { type: 'screen', name: senderName } });
        if (call) {
            this.screenCalls.set(remotePeerId, call);
        }
    }

    _handleIncomingCall(call) {
        const meta = call.metadata || { type: 'camera' };
        this._log(`Входящий звонок [${meta.type}] от: ${call.peer}`);

        if (meta.type === 'screen') {
            // Для входящего экрана отвечаем пустым потоком
            call.answer();
        } else {
            // Для камеры отвечаем своим локальным стримом
            call.answer(this.localStream);
        }

        call.on('stream', (remoteStream) => {
            this._log(`Получен remote-stream [${meta.type}] от: ${call.peer}`);
            this.emit('remote-stream', { peerId: call.peer, stream: remoteStream, metadata: meta });
        });
    }

    // Замена трека в активных соединениях камеры
    replaceTrack(newTrack, kind = 'video') {
        this.peers.forEach(peerRecord => {
            if (peerRecord.call && peerRecord.call.peerConnection) {
                const senders = peerRecord.call.peerConnection.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === kind);
                if (sender) {
                    sender.replaceTrack(newTrack);
                }
            }
        });
    }

    // Запуск демонстрации экрана как второго независимого потока
    startScreenShare(stream, myName = '') {
        this.screenStream = stream;
        this.peers.forEach((_, peerId) => {
            this.callScreen(peerId, stream, myName);
        });
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        this.screenCalls.forEach(call => {
            try { call.close(); } catch (e) { }
        });
        this.screenCalls.clear();
        this.broadcast({ type: 'SCREEN_STOPPED', peerId: this.peer?.id });
    }

    getShareUrl() {
        if (!this.roomId) return window.location.href;
        return window.location.href.split('#')[0] + "#" + this.roomId;
    }

    destroy(keepStream = false) {
        this.isDestroyed = true;
        this.stopScreenShare();

        this.peers.forEach(p => {
            if (p.conn) try { p.conn.close(); } catch (e) { }
            if (p.call) try { p.call.close(); } catch (e) { }
        });
        this.peers.clear();

        if (!keepStream && this.localStream) {
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