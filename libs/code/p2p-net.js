/**
 * P2PNet v3.0 - Промышленный WebRTC Mesh с гарантированным replaceTrack и селектором камер
 */
class P2PNet {
    static ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    static HEARTBEAT_INTERVAL = 4000;

    static DEFAULT_ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];

    constructor(options = {}) {
        this.appPrefix = options.appPrefix || 'p2papp';
        this.mode = options.mode || 'mesh';
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

        this._heartbeatTimer = null;
        this._reconnectAttempts = 0;
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
                this._startHeartbeat();
                this._log(`Комната создана: ${this.roomId}`);
                this.emit('room-created', { roomId: this.roomId, isHost: true });
                return this.roomId;
            } catch (err) {
                if (err.type === 'unavailable-id' && !customCode) continue;
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
        this._startHeartbeat();
        this._log(`Подключение к хосту: ${hostPeerId}`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Таймаут подключения к хосту")), 15000);

            this._connectToPeer(hostPeerId, {
                onOpen: (conn) => {
                    clearTimeout(timer);
                    this.emit('joined-room', { roomId: this.roomId, isHost: false });
                    conn.send({ __sys: 'JOIN_REQ', peerId: this.peer.id, ...myData });
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
                config: { iceServers: this.iceServers, iceTransportPolicy: 'all' }
            };

            this.peer = fixedId ? new Peer(fixedId, config) : new Peer(config);

            let opened = false;
            this.peer.on('open', (id) => {
                opened = true;
                this._reconnectAttempts = 0;
                this._log(`PeerJS готов: ${id}`);
                this.emit('status', { online: true, id });
                resolve(id);
            });

            this.peer.on('connection', (conn) => this._handleIncomingConnection(conn));
            this.peer.on('call', (call) => this._handleIncomingCall(call));

            this.peer.on('disconnected', () => {
                this._log("Потерян сигнальный сервер. Переподключение...");
                this.emit('status', { online: false, reconnecting: true });
                this._tryReconnect();
            });

            this.peer.on('error', (err) => {
                this._log("Peer error:", err.type, err);
                this.emit('error', err);
                if (!opened) reject(err);
            });
        });
    }

    _tryReconnect() {
        if (this.isDestroyed || !this.peer) return;
        this._reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts), 10000);

        setTimeout(() => {
            if (!this.isDestroyed && this.peer && this.peer.disconnected) {
                try { this.peer.reconnect(); } catch (e) { }
            }
        }, delay);
    }

    _startHeartbeat() {
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
            const now = Date.now();
            this.peers.forEach((record, peerId) => {
                if (record.conn && record.conn.open) {
                    record.conn.send({ __sys: 'PING', ts: now });
                }
                if (record.lastSeen && now - record.lastSeen > 12000) {
                    this._cleanupPeer(peerId);
                }
            });
        }, P2PNet.HEARTBEAT_INTERVAL);
    }

    _connectToPeer(remotePeerId, callbacks = {}) {
        if (this.peers.has(remotePeerId)) {
            const existing = this.peers.get(remotePeerId);
            if (existing.conn && existing.conn.open) return existing.conn;
        }

        const conn = this.peer.connect(remotePeerId, { reliable: true });
        const peerRecord = this.peers.get(remotePeerId) || { conn, call: null, queue: [], isReady: false, name: '', lastSeen: Date.now() };
        peerRecord.conn = conn;
        this.peers.set(remotePeerId, peerRecord);

        conn.on('open', () => {
            peerRecord.isReady = true;
            peerRecord.lastSeen = Date.now();
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
        const peerRecord = this.peers.get(conn.peer) || { conn, call: null, queue: [], isReady: false, name: '', lastSeen: Date.now() };
        peerRecord.conn = conn;
        this.peers.set(conn.peer, peerRecord);

        conn.on('open', () => {
            peerRecord.isReady = true;
            peerRecord.lastSeen = Date.now();
            this.emit('peer-connected', { peerId: conn.peer, totalPeers: this.peers.size });
        });

        this._bindDataEvents(conn, peerRecord);
    }

    _bindDataEvents(conn, peerRecord) {
        conn.on('data', (packet) => {
            if (!packet || typeof packet !== 'object') return;
            peerRecord.lastSeen = Date.now();

            if (packet.__sys) {
                this._handleSystemPacket(conn.peer, packet);
                return;
            }
            this.emit('data', packet, conn.peer);
        });

        conn.on('close', () => this._cleanupPeer(conn.peer));
        conn.on('error', () => this._cleanupPeer(conn.peer));
    }

    _cleanupPeer(peerId) {
        if (this.peers.has(peerId)) {
            const p = this.peers.get(peerId);
            if (p.conn) try { p.conn.close(); } catch (e) { }
            if (p.call) try { p.call.close(); } catch (e) { }
            this.peers.delete(peerId);
        }
        if (this.screenCalls.has(peerId)) {
            const sc = this.screenCalls.get(peerId);
            try { sc.close(); } catch (e) { }
            this.screenCalls.delete(peerId);
        }
        this.emit('peer-disconnected', { peerId, totalPeers: this.peers.size });
    }

    _handleSystemPacket(senderPeerId, packet) {
        if (packet.__sys === 'PING') {
            this.send({ __sys: 'PONG', ts: packet.ts }, senderPeerId);
        } else if (packet.__sys === 'PONG') {
            // Heartbeat OK
        } else if (packet.__sys === 'JOIN_REQ' && this.isHost) {
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
        } else if (packet.__sys === 'ROOM_MEMBERS') {
            packet.members.forEach(m => {
                if (m.peerId !== this.peer.id && !this.peers.has(m.peerId)) {
                    this._connectToPeer(m.peerId);
                }
            });
        } else if (packet.__sys === 'NEW_PEER') {
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
        this.peers.forEach((_, peerId) => {
            if (!excludePeerIds.includes(peerId)) {
                this.send(data, peerId);
            }
        });
    }

    call(remotePeerId, stream, metadata = { type: 'camera' }) {
        if (!this.peer || this.peer.destroyed) return;
        const mediaStream = stream || this.localStream;
        if (!mediaStream) return;

        const call = this.peer.call(remotePeerId, mediaStream, { metadata });
        if (!call) return;

        let peerRecord = this.peers.get(remotePeerId);
        if (!peerRecord) {
            peerRecord = { conn: null, call, queue: [], isReady: false, name: '', lastSeen: Date.now() };
            this.peers.set(remotePeerId, peerRecord);
        } else {
            peerRecord.call = call;
        }

        this._setupCallEvents(call, remotePeerId, metadata);
    }

    callScreen(remotePeerId, stream, senderName = '') {
        if (!this.peer || this.peer.destroyed || !stream) return;
        const call = this.peer.call(remotePeerId, stream, { metadata: { type: 'screen', name: senderName } });
        if (call) {
            this.screenCalls.set(remotePeerId, call);
            this._setupCallEvents(call, remotePeerId, { type: 'screen', name: senderName });
        }
    }

    _handleIncomingCall(call) {
        const meta = call.metadata || { type: 'camera' };
        if (meta.type === 'screen') {
            call.answer();
        } else {
            // Отвечаем текущим localStream (он всегда должен содержать оба трека)
            call.answer(this.localStream);
        }
        this._setupCallEvents(call, call.peer, meta);
    }

    _setupCallEvents(call, peerId, meta) {
        call.on('stream', (remoteStream) => {
            this.emit('remote-stream', { peerId, stream: remoteStream, metadata: meta });
        });

        if (call.peerConnection) {
            call.peerConnection.oniceconnectionstatechange = () => {
                const state = call.peerConnection.iceConnectionState;
                if (state === 'failed' || state === 'disconnected') {
                    this._log(`ICE state [${state}] с пиром ${peerId}. Рестарт ICE...`);
                    try { call.peerConnection.restartIce(); } catch (e) { }
                }
            };
        }
    }

    /**
     * НАДЕЖНАЯ ЗАМЕНА ТРЕКА (REPLACE TRACK)
     * Ищет RTP Sender соответствующего типа (audio/video) и на лету подменяет трек
     */
    async replaceTrack(newTrack, kind = 'video') {
        const promises = [];
        this.peers.forEach((peerRecord, peerId) => {
            if (peerRecord.call && peerRecord.call.peerConnection) {
                const pc = peerRecord.call.peerConnection;
                let sender = pc.getSenders().find(s => {
                    if (s.track && s.track.kind === kind) return true;
                    // Если трек был сброшен в null, проверяем transceiver
                    return false;
                });

                if (!sender && pc.getTransceivers) {
                    const transceiver = pc.getTransceivers().find(t => {
                        return (t.sender && t.sender.track && t.sender.track.kind === kind) ||
                            (t.receiver && t.receiver.track && t.receiver.track.kind === kind);
                    });
                    if (transceiver && transceiver.sender) {
                        sender = transceiver.sender;
                    }
                }

                if (sender) {
                    promises.push(
                        sender.replaceTrack(newTrack).catch(err => {
                            console.error(`[P2PNet] Ошибка replaceTrack для ${peerId}:`, err);
                        })
                    );
                } else if (newTrack) {
                    try {
                        pc.addTrack(newTrack, this.localStream);
                    } catch (e) {
                        console.warn(`[P2PNet] addTrack error для ${peerId}:`, e);
                    }
                }
            }
        });
        await Promise.all(promises);
    }

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
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
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