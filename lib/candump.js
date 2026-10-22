'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

/** Zerlegt eine Zeile im Format `candump -L`: (1700000000.123456) can0 313#14FE005A01005C64 */
function parseCandumpLine(line) {
    const m = /^\(\d+\.\d+\)\s+\S+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)\s*$/.exec(line.trim());
    if (!m || m[1].length !== 3) return null; // nur Standard-Frames (11 Bit)
    return { id: m[1].toUpperCase(), data: Buffer.from(m[2].length % 2 ? `0${m[2]}` : m[2], 'hex') };
}

/** Liest SocketCAN über `candump -L <Schnittstelle>` (Paket can-utils), startet bei Abbruch neu. */
class CandumpReader extends EventEmitter {
    constructor({ iface, candump, log, restartMs = 5000 }) {
        super();
        this.iface = iface;
        this.candump = candump;
        this.log = log;
        this.restartMs = restartMs;
        this.stopped = false;
        this.proc = null;
        this.timer = null;
    }

    start() {
        this.stopped = false;
        const useStdbuf = fs.existsSync('/usr/bin/stdbuf');
        const cmd = useStdbuf ? 'stdbuf' : this.candump;
        const args = useStdbuf ? ['-oL', this.candump, '-L', this.iface] : ['-L', this.iface];
        this.log.info(`Starte ${this.candump} auf ${this.iface}`);
        let buffer = '';
        const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const frame = parseCandumpLine(buffer.slice(0, idx));
                buffer = buffer.slice(idx + 1);
                if (frame) this.emit('frame', frame.id, frame.data);
            }
            if (buffer.length > 4096) buffer = '';
        });
        proc.stderr.on('data', (d) => this.log.warn(`candump: ${d.toString().trim()}`));
        proc.on('error', (e) => this.log.error(`candump konnte nicht gestartet werden: ${e.message} (Paket can-utils installiert?)`));
        proc.on('close', (code) => {
            this.proc = null;
            if (this.stopped) return;
            this.log.warn(`candump beendet (Code ${code}), Neustart in ${this.restartMs / 1000} s`);
            this.timer = setTimeout(() => this.start(), this.restartMs);
        });
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.proc) this.proc.kill();
    }
}

module.exports = { CandumpReader, parseCandumpLine };
