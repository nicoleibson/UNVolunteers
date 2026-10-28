/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — lifeline_engine.js
 *  Motor de producción: integra el stack RF real (radio/*.js) con
 *  los datos reales del dispositivo. Cero datos de ejemplo:
 *  ítems de telemetría remota SOLO entran por ingestRemoteTelemetry().
 *  Funciona en el navegador (window.LifelineEngine) y en Node
 *  (module.exports) para poder testearse.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function loadRadio() {
        if (IS_NODE) {
            return {
                AES128: require('../../radio/aes128.js'),
                PacketEncoder: require('../../radio/packet_encoder.js').PacketEncoder,
                PacketBuilder: require('../../radio/packet_encoder.js').PacketBuilder,
                PACKET_CONFIG: require('../../radio/packet_encoder.js').PACKET_CONFIG,
                LoRaNode: require('../../radio/lora_mesh.js').LoRaNode,
                LoRaMesh: require('../../radio/lora_mesh.js').LoRaMesh,
                APRSTracker: require('../../radio/aprs_protocol.js').APRSTracker,
                SDRReceiver: require('../../radio/sdr_receiver.js').SDRReceiver,
                FrequencyManager: require('../../radio/frequency_mgr.js').FrequencyManager,
                AtmosphereBridge: require('../../radio/atmosphere_bridge.js').LifelineAtmosphereBridge,
                evaluateAtmosphere: require('../../radio/atmosphere_bridge.js').evaluateAtmosphere,
                ThermalCam: require('../../radio/thermal_cam.js').ThermalCam,
                detectHumanSignatures: require('../../radio/thermal_cam.js').detectHumanSignatures,
                parseThermalGrid: require('../../radio/thermal_cam.js').parseThermalGrid,
                DtnStore: require('../../radio/dtn_store.js').DtnStore,
                WakeRadioController: require('../../radio/wake_radio.js').WakeRadioController,
                coreMath: require('./core_math.js'),
            };
        }
        return {
            AES128: global.AES128,
            PacketEncoder: global.PacketEncoder,
            PacketBuilder: global.PacketBuilder,
            PACKET_CONFIG: global.PACKET_CONFIG,
            LoRaNode: global.LoRaNode,
            LoRaMesh: global.LoRaMesh,
            APRSTracker: global.APRSTracker,
            SDRReceiver: global.SDRReceiver,
            FrequencyManager: global.FrequencyManager,
            AtmosphereBridge: global.LifelineAtmosphereBridge,
            evaluateAtmosphere: global.evaluateAtmosphere,
            ThermalCam: global.ThermalCam,
            detectHumanSignatures: global.detectHumanSignatures,
            parseThermalGrid: global.parseThermalGrid,
            DtnStore: global.DtnStore,
            WakeRadioController: global.WakeRadioController,
            coreMath: global.coreMath,
        };
    }

    function hexOf(bytes) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function bytesFromHex(hex) {
        const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return out;
    }

    /**
     * Crea el motor RF real.
     * @param {object} [config]
     *  - key: clave AES-128 en hex (32 chars). Si falta, PacketEncoder usa la
     *    clave de referencia NIST SOLO para demo (documentado en radio/).
     *  - encryption: 'AES-CTR' (default) | 'XOR' | 'NONE'
     *  - callsign: indicativo APRS del operador. null/omito → '—' (sin APRS).
     *  - frequency: 'US915' (default) | 'EU868'
     *  - region: 'AMERICAS' | 'EUROPE' (APRS 144.390 / 144.800)
     *  - loraBandHz: frecuencia central LoRa en Hz (default 915e6)
     *  - sdrFreq: frecuencia central SDR (default 433e6)
     *  - onLog: (channel, message) => void
     * @returns {object} engine
     */
    function createEngine(config = {}) {
        const R = loadRadio();
        const ready = !!(R.PacketEncoder && R.PacketBuilder && R.PACKET_CONFIG &&
            R.LoRaMesh && R.LoRaNode && R.APRSTracker && R.SDRReceiver && R.FrequencyManager &&
            (R.AES128 || config.encryption !== 'AES-CTR'));

        const engine = {
            ready,
            config: { ...config },
            sequence: 0,
            onLog: config.onLog || null,
            encoder: null,
            mesh: null,
            tracker: null,
            sdr: null,
            freqMgr: null,
            localNode: null,
            remoteNodes: new Map(),
            callsign: config.callsign || null,
            started: false,
            // Intercom cross-device: lo enruta la GUI cuando una trama real
            // con `msg` incrustado llega desde un par (chat device-to-device).
            onIntercomMessage: null,
        };

        function log(channel, msg) {
            if (engine.onLog) {
                try { engine.onLog(channel, msg); } catch (e) { /* el logger no debe romper */ }
            }
        }

        if (!ready) return engine;

        engine.encoder = new R.PacketEncoder({
            encoding: 'CBOR',
            compression: 'LZ77',
            encryption: config.encryption || 'AES-CTR',
            key: config.key,
        });

        const loraId = config.loraId || 'CAFEBABE00000001';

        engine.localNode = new R.LoRaNode({
            id: loraId,
            name: config.nodeName || 'LOCAL-DEVICE',
            type: 'SCOUT',
            lat: config.lat || 0,
            lon: config.lon || 0,
            alt: config.alt || 0,
            frequency: config.frequency || 'US915',
            spreadingFactor: config.spreadingFactor || 'SF10',
            bandwidth: config.bandwidth || 'BW125',
            txPower: config.txPower || 'MEDIUM',
            battery: config.battery != null ? config.battery : null,
        });

        engine.mesh = new R.LoRaMesh({ frequency: config.frequency || 'US915' });
        engine.mesh.addNode(engine.localNode);
        // Recepción real: los paquetes que la malla entrega al nodo local se
        // descifran y materializan como nodos remotos (nunca inventados).
        engine.localNode.onPacket = (packet) => engine._handleIncoming(packet);

        // Modo baliza: TODO dispositivo en modo baliza (VIGILANCE) que emita
        // BEACON se materializa en la malla/radar con los datos que el beacon
        // realmente trae (fuente, tipo, posición, batería, señal). Los vitales
        // y el rol quedan null/'UNKNOWN' hasta que llegue su telemetría.
        engine._origProcessBeacon = engine.mesh.processBeacon.bind(engine.mesh);
        engine.mesh.processBeacon = function (receivingNode, beacon) {
            const src = beacon && beacon.payload;
            const sourceId = src && src.sourceId;
            if (sourceId && sourceId !== engine.localNode.id) {
                try { engine._materializeBeacon(src); } catch (e) { /* un beacon no rompe la malla */ }
            }
            return engine._origProcessBeacon(receivingNode, beacon);
        };

        /** Materializa (o refresca) un nodo remoto a partir de un BEACON real. */
        engine._materializeBeacon = function (src) {
            const sourceId = src.sourceId;
            if (!sourceId || sourceId === engine.localNode.id) return null;
            const existing = engine.remoteNodes.get(sourceId);
            if (!existing) {
                const node = new R.LoRaNode({
                    id: sourceId,
                    name: src.sourceName || 'NODO-BALIZA',
                    type: src.sourceType || 'VICTIM',
                    lat: (src.position && src.position.lat) || 0,
                    lon: (src.position && src.position.lon) || 0,
                    alt: (src.position && src.position.alt) || 0,
                    frequency: config.frequency || 'US915',
                });
                engine.mesh.addNode(node);
            }
            engine.remoteNodes.set(sourceId, {
                id: sourceId,
                node: engine.mesh.nodes.get(sourceId),
                label: src.sourceName || (existing ? existing.label : 'NODO-BALIZA'),
                role: existing ? existing.role : 'UNKNOWN',
                lat: (src.position && src.position.lat != null) ? src.position.lat : (existing ? existing.lat : null),
                lon: (src.position && src.position.lon != null) ? src.position.lon : (existing ? existing.lon : null),
                alt: (src.position && src.position.alt != null) ? src.position.alt : (existing ? existing.alt : null),
                bpm: existing ? existing.bpm : null,
                spo2: existing ? existing.spo2 : null,
                battery: src.battery != null ? src.battery : (existing ? existing.battery : null),
                pressure: existing ? existing.pressure : null,
                rssi: src.signalStrength != null ? src.signalStrength : (existing ? existing.rssi : null),
                isRelay: existing ? existing.isRelay : false,
                lastSeen: Date.now(),
            });
            return engine.remoteNodes.get(sourceId);
        };

        /** Poda nodos remotos sin señal reciente (TTL, por defecto 30 s). */
        engine.pruneStaleNodes = function (ttlMs = config.nodeTtlMs != null ? config.nodeTtlMs : 30000) {
            if (!engine.ready) return 0;
            const now = Date.now();
            let removed = 0;
            engine.remoteNodes.forEach((entry, id) => {
                const seen = entry.lastSeen != null ? entry.lastSeen : 0;
                if (now - seen > ttlMs) {
                    engine.remoteNodes.delete(id);
                    try { engine.mesh.removeNode(id); } catch (e) { /* ya fuera de la malla */ }
                    removed++;
                }
            });
            return removed;
        };

        engine.tracker = new R.APRSTracker({
            callsign: engine.callsign || 'N0CALL',
            frequency: config.region === 'EUROPE' ? 144.800 : 144.390,
        });

        engine.sdr = new R.SDRReceiver({
            frequency: config.sdrFreq || 433e6,
            sampleRate: config.sampleRate || 96000,
            demodMode: 'FM',
        });

        engine.freqMgr = new R.FrequencyManager({ region: config.region || 'AMERICAS' });
        engine.freqMgr.requestFrequency({
            requesterId: loraId,
            type: 'DATA',
            priority: 2,
            bandwidth: 125000,
        });

        // ── DTN Data Mule (Etapa 2: store-and-forward) ────────────────
        // El motor actúa como "mula de datos": almacena cifradas las balizas
        // de víctimas que llegan sin vía de salida y las expone por
        // engine.dtn.pending() para sincronizarlas al cruzar otro dispositivo
        // o un Gateway. `config.dtn=false` lo desactiva.
        if (config.dtn !== false && R.DtnStore) {
            try {
                engine.dtn = new R.DtnStore({
                    key: config.key,
                    io: (typeof global !== 'undefined' && global.localStorage) ? {
                        get: (k) => global.localStorage.getItem(k),
                        set: (k, v) => global.localStorage.setItem(k, v),
                        remove: (k) => global.localStorage.removeItem(k),
                    } : undefined,
                });
            } catch (e) {
                engine.dtn = null;
            }
        }

        // ── Wake-up radio (Etapa 2: escucha ultra-baja) ────────────────
        // Controlador de escucha pasiva que despierta los sensores de alcance
        // solo ante una firma de proximidad (signalProximity). Sin detección
        // real no despierta (honesto). GUI lo engancha a su HCI/transporte.
        if (R.WakeRadioController) {
            engine.wakeRadio = new R.WakeRadioController({
                idleMs: config.wakeIdleMs || 1000,
                activeMs: config.wakeActiveMs || 8000,
                dutyCycle: config.wakeDutyCycle || 0.05,
            });
            // La escucha ultra-baja se habilita al arrancar (→ IDLE): así los
            // sensores de alcance están en espera pasiva y despiertan SOLO ante
            // una firma de proximidad real. Nunca inventa una detección.
            engine.wakeRadio.enable();
        }

        // ── Vectorización magnética de precisión (UWB + IMU) ────────────
        // Filtro de Kalman 1D por instancia del dispositivo (estabiliza el
        // Azimut ante el hierro estructural). Null-safe: sin distancia UWB o
        // sin orientación real, calculateRescueVector devuelve null.
        if (R.coreMath && R.coreMath.AzimuthKalmanFilter) {
            engine.azimuthFilter = new R.coreMath.AzimuthKalmanFilter({
                q: config.kfQ, r: config.kfR, p0: config.kfP0,
            });
        }
        // API: los bridges BLE/Serial (UWB) + DeviceOrientation alimentan esto.
        engine.calculateRescueVector = function (distance, rawAzimuth, gyroRate, pitch, dt) {
            if (!R.coreMath || !R.coreMath.calculateRescueVector) return null;
            if (!engine.azimuthFilter) engine.azimuthFilter = new R.coreMath.AzimuthKalmanFilter({});
            return R.coreMath.calculateRescueVector(distance, rawAzimuth, gyroRate, pitch, dt, engine.azimuthFilter);
        };
        engine.rescueVectorState = function () {
            return engine.azimuthFilter ? { x: engine.azimuthFilter.x, p: engine.azimuthFilter.p } : null;
        };
        engine.resetRescueVector = function () {
            if (engine.azimuthFilter) { engine.azimuthFilter.x = null; engine.azimuthFilter.p = R.coreMath ? 1.0 : 1.0; }
        };

        /** Construye un paquete de telemetría real (CBOR+LZ77+AES-CTR) y devuelve el hex. */
        engine.buildTelemetryPacket = function (snapshot) {
            if (!engine.ready) return null;
            engine.sequence++;
            const payload = {
                gps: snapshot.gps || { lat: null, lon: null, alt: null },
                baro_hpa: snapshot.pressure ? Math.round((snapshot.pressure / 100) * 100) / 100 : null,
                bpm: snapshot.bpm != null ? snapshot.bpm : null,
                spo2: snapshot.spo2 != null ? snapshot.spo2 : null,
                battery: snapshot.battery != null ? snapshot.battery : null,
                depth_m: snapshot.depth_m != null ? snapshot.depth_m : null,
                role: snapshot.role || 'UNKNOWN',
                tilt: snapshot.tilt != null ? snapshot.tilt : null,
                light: snapshot.light != null ? snapshot.light : null,
                mic: snapshot.mic != null ? snapshot.mic : null,
            };
            // Atmósfera (Etapa 2): CO/O2 reales del módulo de gases del Scout
            // viajan solo si existen (honesto: ausentes → no se incluyen).
            if (snapshot.atm && snapshot.atm.coPpm != null) payload.co_ppm = snapshot.atm.coPpm;
            if (snapshot.atm && snapshot.atm.o2Pct != null) payload.o2_pct = snapshot.atm.o2Pct;
            // Intercom: el texto viaja incrustado en la trama real (chat
            // cross-device). Solo se añade cuando hay mensaje para no engordar
            // las tramas de telemetría ordinaria.
            if (snapshot.msg != null) payload.msg = String(snapshot.msg);
            const packet = new R.PacketBuilder()
                .setType(R.PACKET_CONFIG.types.TELEMETRY || R.PACKET_CONFIG.types.DATA)
                .setSource(engine.localNode.id)
                .setDestination('FFFFFFFFFFFFFFFF')
                .setSequence(engine.sequence)
                .setPayload(payload)
                .build();
            const bytes = engine.encoder.encode(packet);
            const hex = hexOf(bytes);
            engine.lastTelemetryBytes = bytes;
            engine.lastSnapshot = snapshot;
            return hex;
        };

        /** Envía un ping (telemetría unicast) a un nodo concreto de la malla real. */
        engine.sendPing = function (nodeId) {
            if (!engine.ready || !engine.started) return null;
            const hex = engine.buildTelemetryPacket(engine.lastSnapshot || {});
            engine.mesh.sendPacket(engine.localNode.id, nodeId, { trama_hex: hex, ping: true });
            log('lora', `Ping → ${String(nodeId).slice(0, 4)}... (unicast relay)`);
            if (engine.afterLocalTx) { try { engine.afterLocalTx(hex); } catch (e) { /* radio opcional */ } }
            return hex;
        };

        /** Transmite la telemetría local por la malla (broadcast real). */
        engine.sendLocalTelemetry = function (snapshot, destinationId) {
            if (!engine.ready || !engine.started) return null;
            const hex = engine.buildTelemetryPacket(snapshot);
            if (!hex) return null;
            engine.mesh.sendPacket(engine.localNode.id, destinationId || 'FF:FF:FF:FF', { trama_hex: hex });
            log('lora', `Telemetry TX ${hex.length / 2}B seq#${engine.sequence} (AES-CTR)`);
            // Etapa 0: cuando hay una radio física vinculada, la misma trama
            // real sale también por el transceptor LoRa (hook de la GUI).
            if (engine.afterLocalTx) { try { engine.afterLocalTx(hex); } catch (e) { /* radio opcional */ } }
            return hex;
        };

        /**
         * Ingreso de telemetría remota real (feed del operativo / puente
         * cross-device). Cada entrada crea un nodo de la malla y un objeto
         * APRS real. entries: [{ id, label, role, lat, lon, alt, bpm, spo2,
         * battery, pressure, rssi, isRelay }]
         */
        engine.ingestRemoteTelemetry = function (entries) {
            if (!engine.ready) return;
            if (!entries) return;
            entries.forEach((e) => {
                if (!e || !e.id) return;
                const nodeId = String(e.id);
                if (engine.remoteNodes.has(nodeId)) return;
                const rssi = e.rssi != null ? e.rssi : null;
                const node = new R.LoRaNode({
                    id: nodeId,
                    name: e.label || nodeId,
                    type: e.isRelay ? 'RELAY' : 'VICTIM',
                    lat: e.lat || 0,
                    lon: e.lon || 0,
                    alt: e.alt || 0,
                    frequency: config.frequency || 'US915',
                });
                engine.remoteNodes.set(nodeId, {
                    id: nodeId,
                    node,
                    label: e.label || nodeId,
                    role: e.role || 'UNKNOWN',
                    lat: e.lat || null,
                    lon: e.lon || null,
                    alt: e.alt || null,
                    bpm: e.bpm != null ? e.bpm : null,
                    spo2: e.spo2 != null ? e.spo2 : null,
                    battery: e.battery != null ? e.battery : null,
                    pressure: e.pressure != null ? e.pressure : null,
                    rssi,
                    isRelay: !!e.isRelay,
                    lastSeen: Date.now(),
                });
                engine.mesh.addNode(node);
                if (engine.tracker && engine.callsign) {
                    engine.tracker.addObject(nodeId, {
                        latitude: e.lat || 0,
                        longitude: e.lon || 0,
                        symbol: e.isRelay ? 'R' : '[',
                    });
                }
                log('lora', `Node ${nodeId.slice(0, 4)}... joined (${e.label || 'remote'})`);
            });
        };

        /**
         * Recepción real: cuando la malla entrega un paquete al nodo local,
         * se descifra `trama_hex` (CBOR+LZ77+AES-CTR) y se actualiza/crea el
         * nodo remoto. Es la vía natural de ingreso cross-device: nunca inventa
         * nodos, solo materializa lo que realmente llegó por radio/relay.
         */
        engine._handleIncoming = function (packet) {
            const hex = packet && packet.payload && packet.payload.trama_hex;
            if (!hex) return null;
            let pkt;
            try {
                pkt = engine.encoder.decode(bytesFromHex(hex));
            } catch (e) {
                return null;
            }
            const sourceId = pkt && pkt.sourceId;
            if (!sourceId || sourceId === engine.localNode.id) return null;

            const pl = pkt.payload || {};
            const existing = engine.remoteNodes.get(sourceId);
            const role = pl.role || (existing ? existing.role : 'UNKNOWN');
            const label = (packet && packet._relayName) || (existing ? existing.label : 'NODO-REMOTO');

            if (!engine.remoteNodes.has(sourceId)) {
                const node = new R.LoRaNode({
                    id: sourceId,
                    name: label,
                    type: role === 'SCOUT' ? 'SCOUT' : 'VICTIM',
                    lat: (pl.gps && pl.gps.lat) || 0,
                    lon: (pl.gps && pl.gps.lon) || 0,
                    alt: (pl.gps && pl.gps.alt) || 0,
                    frequency: config.frequency || 'US915',
                });
                engine.mesh.addNode(node);
            }

            engine.remoteNodes.set(sourceId, {
                id: sourceId,
                node: engine.mesh.nodes.get(sourceId),
                label,
                role,
                lat: (pl.gps && pl.gps.lat != null) ? pl.gps.lat : (existing ? existing.lat : null),
                lon: (pl.gps && pl.gps.lon != null) ? pl.gps.lon : (existing ? existing.lon : null),
                alt: (pl.gps && pl.gps.alt != null) ? pl.gps.alt : (existing ? existing.alt : null),
                bpm: pl.bpm != null ? pl.bpm : (existing ? existing.bpm : null),
                spo2: pl.spo2 != null ? pl.spo2 : (existing ? existing.spo2 : null),
                battery: pl.battery != null ? pl.battery : (existing ? existing.battery : null),
                pressure: pl.baro_hpa != null ? pl.baro_hpa * 100 : (existing ? existing.pressure : null),
                coPpm: pl.co_ppm != null ? pl.co_ppm : (existing ? existing.coPpm : null),
                o2Pct: pl.o2_pct != null ? pl.o2_pct : (existing ? existing.o2Pct : null),
                rssi: existing ? existing.rssi : null,
                isRelay: false,
                lastSeen: Date.now(),
            });
            log('lora', `RX telemetría de ${sourceId.slice(0, 4)}... (${role}) vía mesh`);
            // DTN (Etapa 2): si es una víctima y hay store habilitado, se
            // acumula la baliza cifrada para el cruce con otro dispositivo o
            // gateway (store-and-forward). No falla si el store está apagado.
            if (engine.dtn && role !== 'SCOUT') {
                try {
                    const entry = engine.remoteNodes.get(sourceId);
                    engine.dtn.ingest({
                        nodeId: sourceId,
                        timestamp: Date.now(),
                        data: {
                            role,
                            lat: entry.lat, lon: entry.lon, alt: entry.alt,
                            bpm: entry.bpm, spo2: entry.spo2, battery: entry.battery,
                            coPpm: entry.coPpm, o2Pct: entry.o2Pct,
                        },
                    });
                } catch (e) { /* el store no debe romper la ingesta */ }
            }
            // Intercom cross-device: si la trama real trae `msg`, se enruta a
            // la GUI del par para su log de intercom (chat device-to-device).
            if (pl.msg != null && typeof engine.onIntercomMessage === 'function') {
                try {
                    engine.onIntercomMessage({
                        fromId: sourceId,
                        fromName: label,
                        msg: String(pl.msg),
                    });
                } catch (e) { /* el callback no debe romper la ingesta */ }
            }
            return pkt;
        };

        /**
         * Inyecta un frame recibido por el relay cross-device en la malla
         * local (mismo criterio que udp_bridge). Cada nodo lo procesa; el
         * nodo local dispara `_handleIncoming` para materializar el remoto.
         */
        engine.injectRelayedFrame = function (frame, relayName) {
            if (!engine.ready || !frame) return null;
            if (relayName) {
                // El frame es el objeto codificado { preamble, header, payload, crc };
                // onPacket recibe frame.payload, así que el nombre debe vivir ahí.
                frame._relayName = relayName;
                if (frame.payload && typeof frame.payload === 'object') {
                    frame.payload._relayName = relayName;
                }
            }
            let delivered = null;
            engine.mesh.nodes.forEach((node) => {
                try {
                    const result = node.processPacket(frame);
                    if (!delivered && result) delivered = result;
                } catch (e) { /* un nodo no debe romper la inyección */ }
            });
            return delivered;
        };

        /** Quita todos los nodos remotos (local solo) de la malla y del radar. */
        engine.clearRemoteNodes = function () {
            engine.remoteNodes.forEach((r) => {
                try { engine.mesh.removeNode(r.id); } catch (e) { /* ya fuera */ }
            });
            engine.remoteNodes.clear();
            return engine;
        };

        // ── DTN sync (Etapa 2) ─────────────────────────────────────────
        /** Outbox de la mula de datos: balizas pendientes por sincronizar. */
        engine.syncDTN = function () {
            if (!engine.dtn) return [];
            return engine.dtn.pending();
        };

        /** Acepta el outbox de OTRO dispositivo (cruces de mulas) y lo mezcla. */
        engine.mergeDTN = function (beacons) {
            if (!engine.dtn || !Array.isArray(beacons)) return { added: 0, updated: 0, duplicate: 0 };
            return engine.dtn.merge(beacons);
        };

        // ── Asignación dinámica de roles (Etapa 2) ─────────────────────
        /**
         * Reconfiguración autónoma de rol por densidad de nodos. Regla honesta
         * basada en los nodos REALES conocidos:
         *  - Si hay ≥ `relayMinScouts` (2) otros SCOUT en la zona Y al menos una
         *    víctima/baliza en el borde sin cobertura, este Scout pasa a ser
         *    REPETIDOR de largo alcance (activa enlaces LoRa/AX.25).
         *  - Si el sector está saturado de scouts y no hay víctimas que retrans-
         *    mitir, vuelve a SCOUT de barrido.
         * @returns {{current:string, suggested:string, switch:boolean,
         *            reason:string, remoteScouts:number, victims:number,
         *            localType:string}}
         */
        engine.rebalanceRoles = function () {
            const minScouts = config.relayMinScouts != null ? config.relayMinScouts : 2;
            let remoteScouts = 0;
            let victims = 0;
            engine.remoteNodes.forEach((entry) => {
                const role = entry.role || 'UNKNOWN';
                const type = (entry.node && entry.node.type) || '';
                if (role === 'SCOUT' || type === 'SCOUT') remoteScouts++;
                if (role === 'VICTIM' || type === 'VICTIM' || type === 'BEACON') victims++;
            });
            const localType = (engine.localNode && engine.localNode.type) || 'SCOUT';
            const isRelay = localType === 'RELAY';
            let suggested = isRelay ? 'RELAY' : 'SCOUT';
            let reason = 'densidad normal';

            if (!isRelay && remoteScouts >= minScouts && victims > 0) {
                suggested = 'RELAY';
                reason = `${remoteScouts} scouts + ${victims} víctima(s): convertir en repetidor`;
            } else if (isRelay && (remoteScouts < minScouts || victims === 0)) {
                suggested = 'SCOUT';
                reason = 'sector saturado o sin víctimas: volver a barrido';
            }
            return {
                current: localType,
                suggested,
                switch: suggested !== localType,
                reason,
                remoteScouts,
                victims,
                localType,
            };
        };

        /** Aplica un rol local (SCOUT/RELAY) y lo refleja en la malla real. */
        engine.setLocalRole = function (role) {
            if (!engine.localNode) return false;
            const next = role === 'RELAY' ? 'RELAY' : 'SCOUT';
            engine.localNode.type = next;
            engine.config.role = next;
            log('lora', `Rol local → ${next}`);
            return true;
        };

        /** Descriptores de nodo para el radar (local + remotos ingeridos). */
        engine.getNodes = function () {
            const out = [];
            if (engine.localNode) {
                out.push({
                    id: engine.localNode.id,
                    label: engine.config.nodeName || 'LOCAL-DEVICE',
                    role: engine.config.role || 'UNKNOWN',
                    gps: engine.config.lat != null ? { lat: engine.config.lat, lon: engine.config.lon } : null,
                    bpm: null, spo2: null, battery: engine.config.battery != null ? engine.config.battery : null,
                    rssi: null,
                    isRelay: false,
                    isLocal: true,
                    loraId: engine.localNode.id,
                    aprsCallsign: engine.callsign,
                    pressure: engine.config.pressure != null ? engine.config.pressure : null,
                    lastSeen: Date.now(),
                });
            }
            engine.remoteNodes.forEach((r) => {
                out.push({
                    id: r.id,
                    label: r.label,
                    role: r.role,
                    gps: r.lat != null ? { lat: r.lat, lon: r.lon } : null,
                    bpm: r.bpm, spo2: r.spo2, battery: r.battery,
                    rssi: r.rssi,
                    isRelay: r.isRelay,
                    isLocal: false,
                    loraId: r.id,
                    aprsCallsign: null,
                    pressure: r.pressure,
                    coPpm: r.coPpm,
                    o2Pct: r.o2Pct,
                    lastSeen: r.lastSeen,
                });
            });
            return out;
        };

        engine.getStats = function () {
            const lora = engine.mesh ? {
                totalPackets: engine.mesh.stats.totalPackets,
                deliveries: engine.mesh.stats.successfulDeliveries,
                failed: engine.mesh.stats.failedDeliveries,
                avgHops: engine.mesh.packetLog.length
                    ? (engine.mesh.packetLog.reduce((a, p) => a + (p.hopCount || 0), 0) / engine.mesh.packetLog.length).toFixed(1)
                    : 0,
            } : { totalPackets: 0, deliveries: 0, failed: 0, avgHops: 0 };
            const aprs = engine.tracker ? {
                packetsSent: engine.tracker.stats.packetsSent,
                lastBeacon: engine.tracker.stats.lastBeacon,
            } : { packetsSent: 0, lastBeacon: 0 };
            const sdr = engine.sdr ? { sampleRate: engine.sdr.sampleRate } : { sampleRate: null };
            return { lora, aprs, sdr, seq: engine.sequence };
        };

        engine.start = function () {
            if (!engine.ready || engine.started) return engine;
            engine.started = true;
            engine.localNode.activate();
            engine.mesh.startBeaconing();
            engine.sdr.start();
            log('lora', 'Mesh beaconing started (real stack)');
            log('aprs', engine.callsign ? `APRS tracker active — ${engine.callsign}` : 'APRS inactive — callsign unset');
            log('sdr', `SDR receiving @ ${(engine.sdr.frequency / 1e6).toFixed(3)} MHz / ${engine.sdr.sampleRate / 1000} kHz`);
            return engine;
        };

        engine.stop = function () {
            if (!engine.started) return;
            engine.started = false;
            engine.mesh.stop();
            engine.sdr.stop();
        };

        return engine;
    }

    const api = { createEngine, hexOf };
    if (IS_NODE) {
        module.exports = api;
    } else if (typeof global.window !== 'undefined') {
        global.window.LifelineEngine = api;
    } else {
        global.LifelineEngine = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
