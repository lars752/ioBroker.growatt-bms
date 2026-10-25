'use strict';
const utils = require('@iobroker/adapter-core');
const g = require('./lib/growatt');
const { BmsCore } = require('./lib/core');
const { CandumpReader } = require('./lib/candump');

class GrowattBms extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'growatt-bms' });
        this.cache = new Map();
        this.queue = Promise.resolve();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (growatt-bms.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
                if (id === 'bms.Online') await this.setStateAsync('info.connection', { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    async createObjects() {
        await this.extendObjectAsync('bms', { type: 'channel', common: { name: 'BMS Datenpunkte' }, native: {} });
        await this.extendObjectAsync('Cells', { type: 'channel', common: { name: 'Zellspannungen' }, native: {} });
        for (const d of g.stateDefs()) {
            // Zellspannungen bleiben unter Cells.*, alle anderen unter bms.*
            const id = d.id.startsWith('Cells.') ? d.id : `bms.${d.id}`;
            const common = { name: d.name, type: d.type, role: d.role, read: true, write: false, def: d.def };
            if (d.unit) common.unit = d.unit;
            await this.extendObjectAsync(id, { type: 'state', common, native: {} });
            if (!(await this.getStateAsync(id))) await this.setStateAsync(id, { val: d.def, ack: true });
        }
    }

    async pruneOnStart() {
        const expectedIds = new Set(['info', 'info.connection', 'bms', 'Cells']);
        for (const d of g.stateDefs()) {
            expectedIds.add(d.id.startsWith('Cells.') ? d.id : `bms.${d.id}`);
        }
        const all = await this.getAdapterObjectsAsync();
        for (const fullId of Object.keys(all)) {
            // fullId is e.g. "growatt-bms.0.Voltage" — strip namespace prefix
            const relId = fullId.slice(this.namespace.length + 1);
            if (!expectedIds.has(relId)) {
                try {
                    await this.delObjectAsync(relId, { recursive: true });
                    this.log.info(`Veralteten Datenpunkt gelöscht: ${fullId}`);
                } catch (e) {
                    this.log.warn(`Konnte ${fullId} nicht löschen: ${e.message}`);
                }
            }
        }
    }

    async onReady() {
        const c = this.config;
        await this.setStateAsync('info.connection', false, true);

        await this.createObjects();
        await this.pruneOnStart();

        this.core = new BmsCore({
            log: this.log,
            write: (id, val) => this.write(id, val),
            cfg: {
                timeoutMs: Math.max(1, Number(c.timeoutSec) || 15) * 1000,
                throttleMs: Math.max(1, Number(c.throttleSec) || 5) * 1000,
                failSafeZero: c.failSafeZero !== false,
                plausibility: c.plausibility !== false,
            },
        });
        await this.core.markOffline('Adapterstart');

        if (c.source === 'canbus-adapter') this.startForeignSource(String(c.canAdapterInstance || 'canbus.0').trim());
        else this.startCandump(String(c.canInterface || 'can0').trim(), String(c.candumpPath || 'candump').trim());

        this.watchdog = setInterval(() => this.core.checkWatchdog().catch((e) => this.log.error(e.message)), Math.max(1, Number(c.watchdogSec) || 5) * 1000);
        this.log.info(`Adapter gestartet (Quelle: ${c.source || 'socketcan'}), Datenpunkte unter ${this.namespace}.*`);
    }

    startCandump(iface, candump) {
        if (!/^[A-Za-z0-9_.-]{1,15}$/.test(iface) || !/^[A-Za-z0-9_./-]+$/.test(candump)) {
            this.log.error('Ungültige Schnittstelle oder ungültiger candump-Pfad in der Konfiguration');
            return;
        }
        this.reader = new CandumpReader({ iface, candump, log: this.log });
        this.reader.on('frame', (id, data) => this.core.handleFrame(id, data).catch((e) => this.log.error(`Frame ${id}: ${e.message}`)));
        this.reader.start();
    }

    startForeignSource(inst) {
        if (!/^[A-Za-z0-9_-]+\.\d+$/.test(inst)) {
            this.log.error(`Ungültige CAN-Adapter-Instanz "${inst}"`);
            return;
        }
        this.foreignRe = new RegExp(`^${inst.replace(/\./g, '\\.')}\\.([0-9a-fA-F]{3,8})\\.json$`);
        this.foreignConn = `${inst}.info.connection`;
        this.subscribeForeignStates(`${inst}.*`);
    }

    onStateChange(id, state) {
        if (!state || !this.foreignRe || !this.core) return;
        const m = this.foreignRe.exec(id);
        if (m) {
            const buf = g.parseToBuffer(state.val);
            if (buf) this.core.handleFrame(m[1].length === 3 ? m[1] : '', buf).catch((e) => this.log.error(e.message));
        } else if (id === this.foreignConn && state.val === false) {
            this.core.markOffline('CAN-Adapter meldet keine Verbindung').catch((e) => this.log.error(e.message));
        }
    }

    onUnload(callback) {
        try {
            if (this.watchdog) clearInterval(this.watchdog);
            if (this.reader) this.reader.stop();
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) module.exports = (options) => new GrowattBms(options);
else new GrowattBms();
