'use strict';
/**
 * Growatt-BMS-Protokoll (Low Voltage, Rev 04): Frame-Dekodierung, Plausibilität, Datenpunkte.
 * Reine Logik ohne ioBroker-Abhängigkeit (testbar).
 */
const BATT_TYPES = ['LiFePO4', 'NMC', 'Titanat', 'Reserved'];
const BMS_IDS = new Set(['311', '312', '313', '314', '315', '316', '317', '318', '319', '320', '321']);
const CELL_COUNT = 16;

// [id, name, type, role, unit, def]
const STATES = [
    ['Online', 'BMS Online Status', 'boolean', 'indicator.reachable', '', false],
    ['Data_Invalid', 'Unplausible Daten empfangen', 'boolean', 'indicator.alarm', '', false],
    ['Last_Update', 'Letztes gültiges Update (Timestamp)', 'number', 'value.time', '', 0],
    ['Voltage', 'Gesamtspannung / Modulspannung', 'number', 'value.voltage', 'V', 0],
    ['Current', 'Gesamtstrom', 'number', 'value.current', 'A', 0],
    ['Charge_Voltage_Limit', 'Empfohlene Ladespannung (CV)', 'number', 'value.voltage', 'V', 0],
    ['Discharge_Voltage_Limit', 'Entladeschlussspannung (Min V)', 'number', 'value.voltage', 'V', 0],
    ['Charge_Current_Limit', 'Ladestrombegrenzung', 'number', 'value.current', 'A', 0],
    ['Discharge_Current_Limit', 'Entladestrombegrenzung', 'number', 'value.current', 'A', 0],
    ['SoC', 'State of Charge (SoC)', 'number', 'value.battery', '%', 0],
    ['SOH', 'State of Health (SOH)', 'number', 'value.battery', '%', 0],
    ['RM_Capacity', 'Restkapazität (RM)', 'number', 'value', 'Ah', 0],
    ['FCC_Capacity', 'Volle Nennkapazität (FCC)', 'number', 'value', 'Ah', 0],
    ['Cycle_Count', 'Ladezyklen', 'number', 'value', '', 0],
    ['Max_Temperature', 'Max. Zelltemperatur', 'number', 'value.temperature', '°C', 0],
    ['Min_Temperature', 'Min. Zelltemperatur', 'number', 'value.temperature', '°C', 0],
    ['Max_Cell_Voltage', 'Max. Zellspannung', 'number', 'value.voltage', 'V', 0],
    ['Min_Cell_Voltage', 'Min. Zellspannung', 'number', 'value.voltage', 'V', 0],
    ['Max_Cell_Voltage_Index', 'Nummer der Zelle mit max. Spannung', 'number', 'value', '', 0],
    ['Min_Cell_Voltage_Index', 'Nummer der Zelle mit min. Spannung', 'number', 'value', '', 0],
    ['Delta_Voltage', 'Zellspannungsdifferenz (Delta V)', 'number', 'value', 'mV', 0],
    ['Battery_Type', 'Batterietyp', 'string', 'text', '', ''],
    ['Parallel_Pack_Number', 'Anzahl paralleler Packs', 'number', 'value', '', 1],
    ['Total_Cell_Number', 'Gesamtzahl der Zellen', 'number', 'value', '', 0],
    ['Protect_Pack_ID', 'Fehlerhafte Batterie-ID (Parallel)', 'number', 'value', '', 0],
    ['Status_Bitmask', 'Status Register (0x311)', 'string', 'text', '', '0x0000'],
    ['Alarm_Table_1', 'Schutz Register 1 (0x312 Table 1)', 'string', 'text', '', '0x00'],
    ['Alarm_Table_2', 'Schutz Register 2 (0x312 Table 2)', 'string', 'text', '', '0x00'],
    ['Alarm_Table_3', 'Warnungs Register 1 (0x312 Table 3)', 'string', 'text', '', '0x00'],
    ['Alarm_Table_4', 'Warnungs Register 2 (0x312 Table 4)', 'string', 'text', '', '0x00'],
    ['Any_Protection', 'Schutz aktiv (Tabelle 1/2 != 0)', 'boolean', 'indicator.alarm', '', false],
    ['Any_Warning', 'Warnung aktiv (Tabelle 3/4 != 0)', 'boolean', 'indicator.alarm', '', false],
    ['Manufacturer', 'Hersteller', 'string', 'text', '', ''],
    ['Hardware_Version', 'Hardware Version', 'number', 'value', '', 0],
    ['Software_Version', 'Software Version', 'number', 'value', '', 0],
    ['Update_Status', 'Update / Upgrade Status', 'string', 'text', '', 'Normal'],
];

/** Alle Datenpunkt-Definitionen inklusive Zellspannungen. */
function stateDefs() {
    const defs = STATES.map(([id, name, type, role, unit, def]) => ({ id, name, type, role, unit, def }));
    for (let i = 1; i <= CELL_COUNT; i++) {
        defs.push({ id: `Cells.Cell_${i}_Voltage`, name: `Zellspannung Zelle ${i}`, type: 'number', role: 'value.voltage', unit: 'V', def: 0 });
    }
    return defs;
}

const round1 = (v) => Math.round(v * 10) / 10;
const hex = (v, len) => `0x${v.toString(16).padStart(len, '0')}`;
const validBytes = (a) => a.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);

/** Wandelt Zustandswerte des CAN-Adapters (Hex-String, JSON-Array, Array, Buffer) in einen Buffer. */
function parseToBuffer(val) {
    if (val === null || val === undefined || val === '') return null;
    if (Buffer.isBuffer(val)) return val;
    if (Array.isArray(val)) return validBytes(val) ? Buffer.from(val) : null;
    if (typeof val !== 'string') return null;
    const t = val.trim();
    if (t.startsWith('[')) {
        try {
            const p = JSON.parse(t);
            return Array.isArray(p) && validBytes(p) ? Buffer.from(p) : null;
        } catch {
            return null;
        }
    }
    if (!/^[0-9a-fA-F\s]+$/.test(t)) return null;
    let clean = t.replace(/\s+/g, '');
    if (clean.length % 2) clean = `0${clean}`;
    return Buffer.from(clean, 'hex');
}

const minLength = (id) => (id === '321' ? 1 : id === '320' ? 4 : 8);

function isPlausible(id, buf) {
    switch (id) {
        case '311': {
            const cv = buf.readUInt16BE(0) / 10;
            return cv >= 40 && cv <= 65;
        }
        case '313': {
            const v = buf.readUInt16BE(0) / 100;
            const i = buf.readInt16BE(2) / 10;
            return v >= 35 && v <= 65 && i >= -400 && i <= 400 && buf[6] <= 100 && (buf[7] & 0x7f) <= 100;
        }
        case '319': {
            const max = buf.readUInt16BE(1) / 1000;
            const min = buf.readUInt16BE(3) / 1000;
            return max >= 2 && max <= 4.5 && min >= 2 && min <= 4.5 && min <= max;
        }
        default:
            return true;
    }
}

/** Dekodiert einen Frame in { Datenpunkt: Wert }. */
function decode(id, buf) {
    switch (id) {
        case '311':
            return {
                Charge_Voltage_Limit: buf.readUInt16BE(0) / 10,
                Discharge_Voltage_Limit: buf.readUInt16BE(2) / 10,
                Charge_Current_Limit: buf.readUInt16BE(4) / 10,
                Discharge_Current_Limit: buf.readUInt16BE(6) / 10,
            };
        case '312':
            return {
                Alarm_Table_1: hex(buf[0], 2),
                Alarm_Table_2: hex(buf[1], 2),
                Alarm_Table_3: hex(buf[2], 2),
                Alarm_Table_4: hex(buf[3], 2),
                Any_Protection: buf[0] !== 0 || buf[1] !== 0,
                Any_Warning: buf[2] !== 0 || buf[3] !== 0,
                Parallel_Pack_Number: buf[4],
                Total_Cell_Number: buf[7],
            };
        case '313':
            return {
                Voltage: buf.readUInt16BE(0) / 100,
                Current: buf.readInt16BE(2) / 10,
                Max_Temperature: buf.readInt16BE(4) / 10,
                SoC: buf[6],
                SOH: buf[7] & 0x7f,
            };
        case '314':
            return {
                RM_Capacity: round1(buf.readUInt16BE(0) / 100),
                FCC_Capacity: round1(buf.readUInt16BE(2) / 100),
                Delta_Voltage: buf.readUInt16BE(4),
                Cycle_Count: buf.readUInt16BE(6),
            };
        case '315':
        case '316':
        case '317':
        case '318': {
            const base = (parseInt(id, 16) - 0x315) * 4;
            const out = {};
            for (let i = 0; i < 4; i++) out[`Cells.Cell_${base + i + 1}_Voltage`] = buf.readUInt16BE(i * 2) / 1000;
            return out;
        }
        case '319':
            return {
                Battery_Type: BATT_TYPES[buf[0] & 0x03] || 'LiFePO4',
                Max_Cell_Voltage: buf.readUInt16BE(1) / 1000,
                Min_Cell_Voltage: buf.readUInt16BE(3) / 1000,
                Max_Cell_Voltage_Index: buf[5],
                Min_Cell_Voltage_Index: buf[6],
                Protect_Pack_ID: buf[7],
            };
        case '320':
            return {
                Manufacturer: String.fromCharCode(buf[0], buf[1]).replace(/\0/g, '').trim(),
                Hardware_Version: buf[2],
                Software_Version: buf[3],
            };
        case '321':
            return { Update_Status: (buf[0] & 0x01) === 1 ? 'Programming / Updating' : 'Normal' };
        default:
            return {};
    }
}

module.exports = { BMS_IDS, STATES, stateDefs, parseToBuffer, minLength, isPlausible, decode };
