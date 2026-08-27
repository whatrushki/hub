/**
 * P2PNet v3.2 - Enterprise WebRTC Mesh с детальным аудитом и стабильным replaceTrack
 */
class P2PNet {
    static ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    static HEARTBEAT_INTERVAL = 3500;

    static DEFAULT_ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];

    constructor(options = {}) {
        this.appPrefix = options.appPrefix || 'dropconf';
        this.mode = options.mode || 'mesh';
        this.debug = true;
        this.iceServers = options.iceServers || P2PNet.DEFAULT_ICE_SERVERS;

        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isDestroyed = false;
        this.userName = 'User';

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
                try { h(...args); } catch (e) { this._audit('ERR', `Event '${event}' error:`, e.message); }
            });
        }
    }

    _audit(category, message, extra = null) {
        const time = new Date().toTimeString().split(' ')[0] + '.' + String(Date.now() % 1000).padStart(3, '0');
        const formatted = `[${time}] [${category}] ${message} ${extra ? JSON.stringify(extra) : ''}`;
        if (window.P2PAuditLog) {
            window.P2PAuditLog.add(category, message, extra);
        } else {
            console.log(formatted);
        }
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

    async createRoom(customCode = null, myName = 'Host', maxRetries = 3) {
        this.isHost = true;
        this.userName = myName;
        let attempts = 0;

        while (attempts < maxRetries) {
            attempts++;
            const code = customCode || P2PNet.generateCode();
            const fullPeerId = `${this.appPrefix}-${code}`;
            this._audit('SYS', `Попытка создания комнаты (id: ${fullPeerId}, попытка ${attempts})...`);

            try {
                await this._initPeer(fullPeerId);
                this.roomId = code;
                this._startHeartbeat();
                this._audit('SYS', `Комната успешно создана: ${this.roomId}`);
                this.emit('room-created', { roomId: this.roomId, isHost: true });
                return this.roomId;
            } catch (err) {
                this._audit('WARN', `Не удалось занять ID: ${fullPeerId}`, err.type || err.message);
                if (err.type === 'unavailable-id' && !customCode) continue;
                throw err;
            }
        }
        throw new Error("Не удалось создать уникальную комнату.");
    }

    async joinRoom(code, myData = {}) {
        this.isHost = false;
        this.roomId = P2PNet.cleanCode(code);
        this.userName = myData.name || 'Guest';
        const hostPeerId = `${this.appPrefix}-${this.roomId}`;

        this._audit('NET', `Инициализация клиента перед подключением к: ${hostPeerId}`);
        await this._initPeer();
        this._startHeartbeat();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._audit('ERR', `Таймаут подключения к хосту ${hostPeerId}`);
                reject(new Error("Таймаут подключения к хосту"));
            }, 14000);

            this._connectToPeer(hostPeerId, {
                onOpen: (conn) => {
                    clearTimeout(timer);
                    this._audit('NET', `Соединение DataChannel с хостом открыто, отправка JOIN_REQ`);
                    this.emit('joined-room', { roomId: this.roomId, isHost: false });
                    conn.send({ __sys: 'JOIN_REQ', peerId: this.peer.id, name: this.userName, ...myData });
                    resolve(conn);
                },
                onError: (err) => {
                    clearTimeout(timer);
                    this._audit('ERR', `Ошибка подключения к хосту:`, err);
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
                debug: 0,
                config: {
                    iceServers: this.iceServers,
                    iceTransportPolicy: 'all'
                }
            };

            this.peer = fixedId ? new Peer(fixedId, config) : new Peer(config);

            let opened = false;
            this.peer.on('open', (id) => {
                opened = true;
                this._reconnectAttempts = 0;
                this._audit('PEER', `PeerJS Signaler подключен, мой ID: ${id}`);
                this.emit('status', { online: true, id });
                resolve(id);
            });

            this.peer.on('connection', (conn) => {
                this._audit('NET', `Входящее подключение DataChannel от: ${conn.peer}`);
                this._handleIncomingConnection(conn);
            });

            this.peer.on('call', (call) => {
                this._audit('MEDIA', `Входящий WebRTC Call от: ${call.peer}, тип: ${call.metadata?.type || 'camera'}`);
                this._handleIncomingCall(call);
            });

            this.peer.on('disconnected', () => {
                this._audit('WARN', "Потеряно соединение с сигнальным сервером. Авто-реконнект...");
                this.emit('status', { online: false, reconnecting: true });
                this._tryReconnect();
            });

            this.peer.on('error', (err) => {
                this._audit('ERR', `PeerJS Error: [${err.type}] ${err.message}`);
                this.emit('error', err);
                if (!opened) reject(err);
            });
        });
    }

    _tryReconnect() {
        if (this.isDestroyed || !this.peer) return;
        this._reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts), 8000);

        setTimeout(() => {
            if (!this.isDestroyed && this.peer && this.peer.disconnected) {
                this._audit('SYS', `Попытка восстановить сигнальный канал (${this._reconnectAttempts})...`);
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
                    this._audit('WARN', `Пир ${peerId} не отвечал >12 сек. Очистка.`);
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
            this._audit('NET', `DataChannel готов с ${remotePeerId}`);
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
            this._audit('NET', `DataChannel открыт с ${conn.peer}`);
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

        conn.on('close', () => {
            this._audit('NET', `DataChannel закрыт: ${conn.peer}`);
            this._cleanupPeer(conn.peer);
        });
        conn.on('error', (e) => {
            this._audit('ERR', `DataChannel ошибка ${conn.peer}:`, e);
            this._cleanupPeer(conn.peer);
        });
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
        this._audit('SYS', `Пир ${peerId} удален из пула. Всего пиров: ${this.peers.size}`);
        this.emit('peer-disconnected', { peerId, totalPeers: this.peers.size });
    }

    _handleSystemPacket(senderPeerId, packet) {
        if (packet.__sys === 'PING') {
            this.send({ __sys: 'PONG', ts: packet.ts }, senderPeerId);
        } else if (packet.__sys === 'PONG') {
            // Heartbeat OK
        } else if (packet.__sys === 'JOIN_REQ' && this.isHost) {
            this._audit('SYS', `Хост обработал JOIN_REQ от ${senderPeerId} (${packet.name || 'NoName'})`);
            const members = Array.from(this.peers.keys()).map(id => ({ peerId: id, name: this.peers.get(id)?.name || '' }));
            this.send({ __sys: 'ROOM_MEMBERS', members, hostId: this.peer.id }, senderPeerId);
            this.broadcast({ __sys: 'NEW_PEER', peerId: senderPeerId, name: packet.name || '' }, [senderPeerId]);

            if (this.peers.has(senderPeerId)) this.peers.get(senderPeerId).name = packet.name;

            // Звоним новому участнику с локальным медиапотоком
            setTimeout(() => {
                if (this.localStream) {
                    this._audit('MEDIA', `Хост инициирует Call к новому участнику ${senderPeerId}`);
                    this.call(senderPeerId, this.localStream, { type: 'camera', name: this.userName });
                }
            }, 300);

            if (this.screenStream) {
                setTimeout(() => this.callScreen(senderPeerId, this.screenStream, this.userName), 600);
            }
        } else if (packet.__sys === 'ROOM_MEMBERS') {
            this._audit('SYS', `Получен список участников от хоста:`, packet.members);
            packet.members.forEach(m => {
                if (m.peerId !== this.peer.id && !this.peers.has(m.peerId)) {
                    this._connectToPeer(m.peerId);
                }
            });
        } else if (packet.__sys === 'NEW_PEER') {
            this._audit('SYS', `Уведомление о новом пире: ${packet.peerId} (${packet.name})`);
            if (packet.peerId !== this.peer.id && !this.peers.has(packet.peerId)) {
                this._connectToPeer(packet.peerId);
                setTimeout(() => {
                    if (this.localStream) {
                        this._audit('MEDIA', `Звонок к новому пиру ${packet.peerId}`);
                        this.call(packet.peerId, this.localStream, { type: 'camera', name: this.userName });
                    }
                }, 400);
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

    call(remotePeerId, stream, metadata = {}) {
        if (!this.peer || this.peer.destroyed) return;
        const mediaStream = stream || this.localStream;
        if (!mediaStream) {
            this._audit('WARN', `Попытка вызова ${remotePeerId} без localStream!`);
            return;
        }

        const meta = { type: 'camera', name: this.userName, ...metadata };
        this._audit('MEDIA', `Вызов peer.call() -> ${remotePeerId}`, meta);
        const call = this.peer.call(remotePeerId, mediaStream, { metadata: meta });
        if (!call) return;

        let peerRecord = this.peers.get(remotePeerId);
        if (!peerRecord) {
            peerRecord = { conn: null, call, queue: [], isReady: false, name: meta.name, lastSeen: Date.now() };
            this.peers.set(remotePeerId, peerRecord);
        } else {
            peerRecord.call = call;
        }

        this._setupCallEvents(call, remotePeerId, meta);
    }

    callScreen(remotePeerId, stream, senderName = '') {
        if (!this.peer || this.peer.destroyed || !stream) return;
        this._audit('MEDIA', `Трансляция экрана -> ${remotePeerId}`);
        const call = this.peer.call(remotePeerId, stream, { metadata: { type: 'screen', name: senderName || this.userName } });
        if (call) {
            this.screenCalls.set(remotePeerId, call);
            this._setupCallEvents(call, remotePeerId, { type: 'screen', name: senderName || this.userName });
        }
    }

    _handleIncomingCall(call) {
        const meta = call.metadata || { type: 'camera', name: 'Участник' };
        this._audit('MEDIA', `Ответ на входящий вызов от ${call.peer}`, meta);

        // Отвечаем с локальным стримом
        if (meta.type === 'screen') {
            call.answer();
        } else {
            call.answer(this.localStream);
        }

        let peerRecord = this.peers.get(call.peer);
        if (!peerRecord) {
            peerRecord = { conn: null, call, queue: [], isReady: false, name: meta.name || '', lastSeen: Date.now() };
            this.peers.set(call.peer, peerRecord);
        } else {
            peerRecord.call = call;
        }

        this._setupCallEvents(call, call.peer, meta);
    }

    _setupCallEvents(call, peerId, meta) {
        call.on('stream', (remoteStream) => {
            const vTracks = remoteStream.getVideoTracks().length;
            const aTracks = remoteStream.getAudioTracks().length;
            this._audit('MEDIA', `Получен remote-stream от ${peerId}! Tracks: V=${vTracks}, A=${aTracks}`, meta);
            this.emit('remote-stream', { peerId, stream: remoteStream, metadata: meta });
        });

        call.on('close', () => {
            this._audit('MEDIA', `Медиа-вызов завершен: ${peerId}`);
        });

        call.on('error', (err) => {
            this._audit('ERR', `Ошибка в MediaConnection (${peerId}):`, err);
        });

        if (call.peerConnection) {
            call.peerConnection.onconnectionstatechange = () => {
                this._audit('ICE', `ConnectionState [${peerId}]: ${call.peerConnection.connectionState}`);
            };
            call.peerConnection.oniceconnectionstatechange = () => {
                const state = call.peerConnection.iceConnectionState;
                this._audit('ICE', `ICE state [${peerId}]: ${state}`);
                if (state === 'failed' || state === 'disconnected') {
                    try {
                        this._audit('ICE', `Перезапуск ICE для ${peerId}...`);
                        call.peerConnection.restartIce();
                    } catch (e) { }
                }
            };
        }
    }

    /**
     * Замена трека в RTP Sender (на лету без пересоздания звонка)
     */
    async replaceTrack(newTrack, kind = 'video') {
        this._audit('MEDIA', `Начало replaceTrack [${kind}], новый трек:`, { id: newTrack?.id, readyState: newTrack?.readyState, enabled: newTrack?.enabled });
        const promises = [];

        this.peers.forEach((peerRecord, peerId) => {
            if (peerRecord.call && peerRecord.call.peerConnection) {
                const pc = peerRecord.call.peerConnection;
                const senders = pc.getSenders();
                let targetSender = senders.find(s => s.track && s.track.kind === kind);

                if (!targetSender && pc.getTransceivers) {
                    const transceivers = pc.getTransceivers();
                    const trans = transceivers.find(t =>
                        (t.sender && t.sender.track && t.sender.track.kind === kind) ||
                        (t.receiver && t.receiver.track && t.receiver.track.kind === kind)
                    );
                    if (trans && trans.sender) targetSender = trans.sender;
                }

                if (targetSender) {
                    this._audit('MEDIA', `Найден sender для ${peerId}, заменяем трек...`);
                    promises.push(
                        targetSender.replaceTrack(newTrack).then(() => {
                            this._audit('MEDIA', `replaceTrack успешно применен к ${peerId}`);
                        }).catch(e => {
                            this._audit('ERR', `replaceTrack error у ${peerId}:`, e.message);
                        })
                    );
                } else if (newTrack) {
                    this._audit('WARN', `Sender не найден у ${peerId}, попытка pc.addTrack...`);
                    try { pc.addTrack(newTrack, this.localStream); } catch (e) { }
                }
            }
        });
        await Promise.all(promises);
    }

    startScreenShare(stream, myName = '') {
        this.screenStream = stream;
        this.peers.forEach((_, peerId) => {
            this.callScreen(peerId, stream, myName || this.userName);
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
        this._audit('SYS', 'P2PNet экземпляр полностью очищен');
    }
}