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
                if (id === 'Online') await this.setStateAsync('info.connection', { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    async createObjects() {
        const channel = { type: 'channel', common: { name: 'Zellspannungen' }, native: {} };
        await this.extendObjectAsync('Cells', channel);
        for (const d of g.stateDefs()) {
            const common = { name: d.name, type: d.type, role: d.role, read: true, write: false, def: d.def };
            if (d.unit) common.unit = d.unit;
            const obj = { type: 'state', common, native: {} };
            await this.extendObjectAsync(d.id, obj);
            if (!(await this.getStateAsync(d.id))) await this.setStateAsync(d.id, { val: d.def, ack: true });
        }
    }

    async onReady() {
        const c = this.config;
        await this.setStateAsync('info.connection', false, true);

        await this.createObjects();

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
