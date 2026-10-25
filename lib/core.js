'use strict';
const g = require('./growatt');

/** Datenpunkte in den Unterordner 'bms' packen; Zellspannungen (Cells.*) bleiben unverändert. */
const bms = (id) => id.startsWith('Cells.') ? id : `bms.${id}`;

/**
 * Kernlogik: Frame-Verarbeitung, Plausibilitätsprüfung und Watchdog.
 * Alle Schreibzugriffe laufen über opts.write(id, value) (muss die Reihenfolge garantieren).
 */
class BmsCore {
    constructor(opts) {
        this.log = opts.log;
        this.write = opts.write;
        this.now = opts.now || Date.now;
        this.cfg = { timeoutMs: 15000, throttleMs: 5000, failSafeZero: true, plausibility: true, ...opts.cfg };
        this.lastMsg = this.now();
        this.lastUpdateWrite = 0;
        this.offline = false;
        this.invalid = new Set();
    }

    async handleFrame(canId, buf) {
        const id = String(canId).toUpperCase().padStart(3, '0');
        if (!g.BMS_IDS.has(id)) return 'ignored';
        if (!buf || buf.length < g.minLength(id)) {
            this.log.debug(`Frame ${id} zu kurz oder ungültig (${buf ? buf.length : 0} Byte)`);
            return 'short';
        }
        this.lastMsg = this.now();
        if (this.offline) {
            this.offline = false;
            this.log.info('Verbindung zum BMS wieder erkannt');
        }
        await this.write(bms('Online'), true);
        if (this.lastMsg - this.lastUpdateWrite > this.cfg.throttleMs) {
            this.lastUpdateWrite = this.lastMsg;
            await this.write(bms('Last_Update'), this.lastMsg);
        }
        if (this.cfg.plausibility && !g.isPlausible(id, buf)) {
            this.log.warn(`Unplausible Werte in CAN-ID ${id} verworfen`);
            if (!this.invalid.has(id)) {
                this.invalid.add(id);
                await this.write(bms('Data_Invalid'), true);
            }
            return 'invalid';
        }
        if (this.invalid.delete(id) && this.invalid.size === 0) await this.write(bms('Data_Invalid'), false);
        for (const [key, val] of Object.entries(g.decode(id, buf))) await this.write(bms(key), val);
        return 'ok';
    }

    async markOffline(reason) {
        if (this.offline) return;
        this.offline = true;
        this.log.warn(`Watchdog: BMS offline (${reason})`);
        await this.write(bms('Online'), false);
        if (this.cfg.failSafeZero) {
            await this.write(bms('Charge_Current_Limit'), 0);
            await this.write(bms('Discharge_Current_Limit'), 0);
            await this.write(bms('Current'), 0);
        }
    }

    checkWatchdog() {
        if (!this.offline && this.now() - this.lastMsg > this.cfg.timeoutMs) {
            return this.markOffline(`keine CAN-Nachrichten seit über ${this.cfg.timeoutMs / 1000} s`);
        }
        return Promise.resolve();
    }
}

module.exports = { BmsCore };
