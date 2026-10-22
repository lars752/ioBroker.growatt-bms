# ioBroker.growatt-bms

Liest ein **Growatt-Niedervolt-BMS** (CAN-Protokoll Rev 04) direkt vom CAN-Bus aus und ersetzt damit das Skript „BMS CAN-Bus Decoder“.
Der Adapter dekodiert die Frames 0x311–0x321 und stellt Spannung, Strom, SoC, SOH, Lade-/Entladelimits, Zellspannungen, Alarme und Herstellerdaten bereit.

## Funktionen
- **Zwei Datenquellen:** SocketCAN direkt (über `candump` aus can-utils, keine native Kompilierung nötig) oder die Zustände eines vorhandenen CAN-Adapters (`canbus.N.<ID>.json`).
- **Watchdog:** Kommen länger als das Timeout (Standard 15 s) keine gültigen Frames, setzt der Adapter `Online = false` sowie `Charge_Current_Limit`, `Discharge_Current_Limit` und `Current` auf 0 (abschaltbar).
- **Plausibilitätsprüfung:** unplausible Frames (0x311, 0x313, 0x319) werden verworfen, `Data_Invalid` zeigt das an.
- **Eigener Namensraum:** Alle Datenpunkte liegen unter `growatt-bms.<Instanz>.*` (z. B. `growatt-bms.0.SoC`). Weitere Instanzen (`growatt-bms.1`, `.2` …) zählt ioBroker automatisch hoch, z. B. für ein zweites BMS an einer anderen CAN-Schnittstelle. Es wird nichts nach `0_userdata.0` geschrieben.
- Schreibt nur geänderte Werte; `info.connection` zeigt, ob das BMS Daten sendet.

## Installation über GitHub
1. Repository: https://github.com/lars752/ioBroker.growatt-bms – den Inhalt dieses Ordners direkt ins Hauptverzeichnis hochladen (Branch `main`).
2. Die Links in `package.json` und `io-package.json` zeigen bereits auf dieses Repository.
3. ioBroker Admin → Adapter → Experten-Modus aktivieren → „Adapter aus eigener URL installieren“ (GitHub-Symbol) → `https://github.com/<lars752>/ioBroker.growatt-bms` eingeben.
   Alternativ auf der Konsole: `iobroker url https://github.com/<lars752>/ioBroker.growatt-bms`
4. Instanz `growatt-bms.0` anlegen und konfigurieren.

Voraussetzungen: Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.

## CAN-Schnittstelle vorbereiten (Quelle „SocketCAN“)
```bash
sudo apt install can-utils
# CAN-Adapter mit Linux-Treiber (z. B. MCP2515, PEAK, USB-CAN mit gs_usb):
sudo ip link set can0 up type can bitrate 500000
candump can0          # Test: es müssen Frames mit den IDs 311…321 erscheinen
```
- Die Bitrate laut Growatt-Protokoll bzw. Datenblatt prüfen (häufig 500 kbit/s).
- USB-Adapter mit serieller Schnittstelle (slcan): `sudo slcand -o -c -s6 /dev/ttyUSB0 slcan0 && sudo ip link set slcan0 up`, in der Instanz dann `slcan0` eintragen.
- Dauerhaft einrichten über `/etc/network/interfaces.d/can0` oder systemd-networkd.
- Docker: Container mit `--network host` betreiben, damit die Schnittstelle sichtbar ist.
- Der ioBroker-Benutzer braucht nur Leserechte auf die Schnittstelle (Rootrechte sind nicht nötig).

## Umstieg vom Skript
1. Skript „BMS CAN-Bus Decoder“ in ioBroker stoppen und den alten Ordner `0_userdata.0.BMS` löschen, sobald nichts mehr darauf zugreift.
2. Bei Quelle „Vorhandener CAN-Adapter“ die bisherige Instanz (z. B. `canbus.2`) angeben; bei SocketCAN wird der CAN-Adapter nicht mehr benötigt.
3. Skripte und Visualisierungen auf die neuen IDs umstellen: `0_userdata.0.BMS.<Name>` wird zu `growatt-bms.0.<Name>`, z. B.
   `0_userdata.0.BMS.SoC` → `growatt-bms.0.SoC`, `0_userdata.0.BMS.Online` → `growatt-bms.0.Online`,
   `0_userdata.0.BMS.Discharge_Current_Limit` → `growatt-bms.0.Discharge_Current_Limit`, `0_userdata.0.BMS.Any_Protection` → `growatt-bms.0.Any_Protection`.
   Die Datenpunktnamen selbst sind unverändert.

## Datenpunkte (`growatt-bms.0.*`, identisch zum Skript)
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

Hinweis: `Min_Temperature` und `Status_Bitmask` werden wie im Original-Skript angelegt, aber vom Protokoll-Teil nicht gefüllt (Frame 0x313 liefert nur die maximale Temperatur).

## Entwicklung
```bash
npm install
npm test        # Dekodierung, Plausibilität, Watchdog (ohne ioBroker lauffähig)
```
Struktur: `lib/growatt.js` (Protokoll), `lib/core.js` (Verarbeitung, Watchdog), `lib/candump.js` (SocketCAN-Quelle), `main.js` (Adapter).
Ein weiteres BMS-Protokoll (z. B. Pylontech) lässt sich als zusätzliches Modul neben `growatt.js` ergänzen.

## Lizenz
MIT
