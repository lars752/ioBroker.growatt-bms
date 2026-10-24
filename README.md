# ioBroker.growatt-bms

Liest ein **Growatt-Niedervolt-BMS** (CAN-Protokoll Rev 04) direkt vom CAN-Bus aus, dekodiert die Frames 0x311–0x321 und stellt Spannung, Strom, SoC, SOH, Lade-/Entladelimits, Zellspannungen, Alarme und Herstellerdaten bereit.

## Funktionen

- **Zwei Datenquellen:** SocketCAN direkt (über `candump` aus can-utils, keine native Kompilierung nötig) oder die Zustände eines vorhandenen CAN-Adapters (`canbus.N.<ID>.json`).
- **Watchdog:** Kommen länger als das Timeout (Standard 15 s) keine gültigen Frames, setzt der Adapter `Online = false` sowie `Charge_Current_Limit`, `Discharge_Current_Limit` und `Current` auf 0 (abschaltbar).
- **Plausibilitätsprüfung:** Unplausible Frames (0x311, 0x313, 0x319) werden verworfen, `Data_Invalid` zeigt das an.
- **Eigener Namensraum:** Alle Datenpunkte liegen unter `growatt-bms.<Instanz>.*`. Weitere Instanzen (`growatt-bms.1`, `.2` …) sind für ein zweites BMS an einer anderen CAN-Schnittstelle möglich.
- Schreibt nur geänderte Werte; `info.connection` zeigt, ob das BMS Daten sendet.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren":  
   `https://github.com/lars752/ioBroker.growatt-bms`  
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.growatt-bms`
2. Instanz anlegen und konfigurieren.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.

## CAN-Schnittstelle vorbereiten (Quelle „SocketCAN")

```bash
sudo apt install can-utils
# CAN-Adapter mit Linux-Treiber (z. B. MCP2515, PEAK, USB-CAN mit gs_usb):
sudo ip link set can0 up type can bitrate 500000
candump can0          # Test: Frames mit den IDs 311…321 müssen erscheinen
```

- Bitrate laut Growatt-Protokoll bzw. Datenblatt prüfen (häufig 500 kbit/s).
- USB-Adapter mit serieller Schnittstelle (slcan): `sudo slcand -o -c -s6 /dev/ttyUSB0 slcan0 && sudo ip link set slcan0 up`, in der Instanz dann `slcan0` eintragen.
- Dauerhaft einrichten über `/etc/network/interfaces.d/can0` oder systemd-networkd.
- Docker: Container mit `--network host` betreiben, damit die Schnittstelle sichtbar ist.
- Der ioBroker-Benutzer braucht nur Leserechte auf die Schnittstelle.

## Konfiguration

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Quelle | `socketcan` | `socketcan` oder `canadapter` |
| CAN-Schnittstelle | `can0` | Schnittstellenname für SocketCAN |
| candump-Pfad | `candump` | Pfad zum candump-Binary |
| CAN-Adapter-Instanz | `canbus.0` | Instanz des CAN-Adapters |
| Timeout | 15 s | Watchdog-Schwelle |
| Watchdog-Intervall | 5 s | Prüfintervall des Watchdogs |
| Drossel | 5 s | Mindestabstand zwischen Schreibvorgängen |
| Fail-Safe | an | Limits und Strom auf 0 bei Timeout |
| Plausibilitätsprüfung | an | Unplausible Frames verwerfen |

## Datenpunkte (`growatt-bms.0.*`)

| Gruppe | Datenpunkte |
|---|---|
| Status | `Online`, `Data_Invalid`, `Last_Update`, `info.connection` |
| Messwerte (0x313) | `Voltage`, `Current`, `Max_Temperature`, `SoC`, `SOH` |
| Limits (0x311) | `Charge_Voltage_Limit`, `Discharge_Voltage_Limit`, `Charge_Current_Limit`, `Discharge_Current_Limit` |
| Alarme (0x312) | `Alarm_Table_1…4`, `Any_Protection`, `Any_Warning`, `Parallel_Pack_Number`, `Total_Cell_Number` |
| Kapazität (0x314) | `RM_Capacity`, `FCC_Capacity`, `Delta_Voltage`, `Cycle_Count` |
| Zellen (0x315–0x318) | `Cells.Cell_1_Voltage … Cell_16_Voltage` |
| Zellextrema (0x319) | `Battery_Type`, `Max/Min_Cell_Voltage`, `Max/Min_Cell_Voltage_Index`, `Protect_Pack_ID` |
| Hersteller (0x320/0x321) | `Manufacturer`, `Hardware_Version`, `Software_Version`, `Update_Status` |

Hinweis: `Min_Temperature` und `Status_Bitmask` werden angelegt, aber vom Protokoll nicht gefüllt (Frame 0x313 liefert nur die maximale Temperatur).

## Entwicklung

```bash
npm install
npm test        # läuft ohne ioBroker-Instanz
```

Struktur: `lib/growatt.js` (Protokoll), `lib/core.js` (Verarbeitung, Watchdog), `lib/candump.js` (SocketCAN-Quelle), `main.js` (Adapter).  
Ein weiteres BMS-Protokoll lässt sich als zusätzliches Modul neben `growatt.js` ergänzen.

## Lizenz

MIT
