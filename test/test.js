'use strict';
const assert = require('assert');
const g = require('../lib/growatt');
const { BmsCore } = require('../lib/core');
const { parseCandumpLine } = require('../lib/candump');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

(async () => {
    await test('0x313 dekodieren', () => {
        const d = g.decode('313', hex('14FE 005A 0100 5C 64'));
        assert.deepStrictEqual(d, { Voltage: 53.74, Current: 9, Max_Temperature: 25.6, SoC: 92, SOH: 100 });
    });
    await test('0x311 dekodieren', () => {
        const d = g.decode('311', hex('023A 0640 0708 0962'));
        assert.strictEqual(d.Charge_Voltage_Limit, 57);
        assert.strictEqual(d.Charge_Current_Limit, 180);
        assert.strictEqual(d.Discharge_Current_Limit, 240.2);
    });
    await test('0x319 dekodieren', () => {
        const d = g.decode('319', hex('C0 0D20 0D1E 03 07 00'));
        assert.strictEqual(d.Max_Cell_Voltage, 3.36);
        assert.strictEqual(d.Min_Cell_Voltage, 3.358);
        assert.strictEqual(d.Battery_Type, 'LiFePO4');
        assert.strictEqual(d.Max_Cell_Voltage_Index, 3);
    });
    await test('0x316 liefert Zellen 5-8', () => {
        const d = g.decode('316', hex('0D20 0D21 0D22 0D23'));
        assert.deepStrictEqual(Object.keys(d), ['Cells.Cell_5_Voltage', 'Cells.Cell_6_Voltage', 'Cells.Cell_7_Voltage', 'Cells.Cell_8_Voltage']);
    });
    await test('0x312 Alarme', () => {
        const d = g.decode('312', hex('00 04 00 00 01 00 00 10'));
        assert.strictEqual(d.Any_Protection, true);
        assert.strictEqual(d.Any_Warning, false);
        assert.strictEqual(d.Alarm_Table_2, '0x04');
        assert.strictEqual(d.Total_Cell_Number, 16);
    });
    await test('Plausibilität', () => {
        assert.strictEqual(g.isPlausible('313', hex('14FE 005A 0100 5C 64')), true);
        assert.strictEqual(g.isPlausible('313', hex('0000 005A 0100 5C 64')), false);
        assert.strictEqual(g.isPlausible('313', hex('14FE 005A 0100 65 64')), false);
        assert.strictEqual(g.isPlausible('319', hex('C0 0D1E 0D20 03 07 00')), false);
    });
    await test('parseToBuffer', () => {
        assert.deepStrictEqual([...g.parseToBuffer('14FE005A')], [0x14, 0xfe, 0x00, 0x5a]);
        assert.deepStrictEqual([...g.parseToBuffer('[20,254]')], [20, 254]);
        assert.deepStrictEqual([...g.parseToBuffer([1, 2])], [1, 2]);
        assert.strictEqual(g.parseToBuffer('xyz'), null);
        assert.strictEqual(g.parseToBuffer([300]), null);
    });
    await test('candump-Zeilen', () => {
        const f = parseCandumpLine('(1700000000.123456) can0 313#14FE005A01005C64');
        assert.strictEqual(f.id, '313');
        assert.strictEqual(f.data.length, 8);
        assert.strictEqual(parseCandumpLine('(1700000000.1) can0 12345678#00'), null);
        assert.strictEqual(parseCandumpLine('müll'), null);
        assert.strictEqual(parseCandumpLine('(1.0) can0 321#').data.length, 0);
    });
    await test('Datenpunkte: 36 feste + 16 Zellen, keine Duplikate', () => {
        const defs = g.stateDefs();
        assert.strictEqual(defs.length, 36 + 16);
        assert.strictEqual(new Set(defs.map((d) => d.id)).size, defs.length);
    });

    // Kernlogik mit simulierter Uhr
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const mk = () => {
        const w = {};
        const t = { now: 1_000_000 };
        const core = new BmsCore({ log, write: async (id, v) => { w[id] = v; }, now: () => t.now });
        return { w, t, core };
    };
    await test('Kern: gültiger Frame setzt Online und Werte', async () => {
        const { w, core } = mk();
        assert.strictEqual(await core.handleFrame('313', hex('14FE005A01005C64')), 'ok');
        assert.strictEqual(w.Online, true);
        assert.strictEqual(w.SoC, 92);
        assert.ok(w.Last_Update > 0);
    });
    await test('Kern: unbekannte ID und zu kurze Frames', async () => {
        const { core } = mk();
        assert.strictEqual(await core.handleFrame('123', hex('0000000000000000')), 'ignored');
        assert.strictEqual(await core.handleFrame('313', hex('14FE')), 'short');
        assert.strictEqual(await core.handleFrame('321', hex('01')), 'ok');
    });
    await test('Kern: unplausibel -> Data_Invalid, danach Erholung', async () => {
        const { w, core } = mk();
        assert.strictEqual(await core.handleFrame('313', hex('0000005A01005C64')), 'invalid');
        assert.strictEqual(w.Data_Invalid, true);
        assert.strictEqual(w.Voltage, undefined);
        await core.handleFrame('313', hex('14FE005A01005C64'));
        assert.strictEqual(w.Data_Invalid, false);
    });
    await test('Kern: Watchdog setzt Online=false und Limits auf 0, Erholung', async () => {
        const { w, t, core } = mk();
        await core.handleFrame('311', hex('023A0640070809 62'));
        assert.strictEqual(w.Discharge_Current_Limit, 240.2);
        t.now += 14_000; await core.checkWatchdog();
        assert.strictEqual(w.Online, true);
        t.now += 2_000; await core.checkWatchdog();
        assert.strictEqual(w.Online, false);
        assert.strictEqual(w.Charge_Current_Limit, 0);
        assert.strictEqual(w.Discharge_Current_Limit, 0);
        assert.strictEqual(w.Current, 0);
        await core.handleFrame('313', hex('14FE005A01005C64'));
        assert.strictEqual(w.Online, true);
    });
    await test('Kern: failSafeZero=false lässt Limits stehen', async () => {
        const w = {};
        const core = new BmsCore({ log, write: async (i, v) => { w[i] = v; }, cfg: { failSafeZero: false } });
        await core.markOffline('Test');
        assert.strictEqual(w.Online, false);
        assert.strictEqual(w.Charge_Current_Limit, undefined);
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
