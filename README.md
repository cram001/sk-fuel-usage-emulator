# Signal K Fuel Data Manager

Persistent multi-engine fuel accounting, a Signal K WebApp for resets/refuelling, and optional direct NMEA 2000 output. Rebuilt from `fuel-usage-calculator` as **2.0.0-beta.1**.

**This is not a verified drop-in Navico FDM clone.** Standard N2K trip fuel and vessel fuel remaining are supported. Navico proprietary seasonal messages, plotter reset commands, and B&G device recognition have not been verified. All trip/season resets and refuelling operations are performed in the Signal K WebApp.

## Features

- Automatically discovers `propulsion.*.fuel.rate` and legacy/custom `engine.*.fuel.rate`, including `main`, `0`, `1`, and other engine names. Signal K input units must be **m³/s**, not L/h.
- Independent lifetime, trip and season consumption for each engine; independent trip/season resets.
- Explicit source selection and engine-instance overrides. Conflicting aliases pause accounting until resolved instead of counting the same engine twice.
- Tank capacities/reserves, initial quantity, partial refuelling, mark-full and engine-to-tank assignment. Multiple engines can consume from one tank. Change assignments when switching tanks.
- Durable checkpoints, bounded operation history, downloadable backups and restore.
- Standalone WebApp plus React 19 federated panels for the current Signal K Admin UI.
- Optional N2K output through canboatjs; neither Derived Data nor Emitter Cannon is required.
- Bounded diagnostic capture for future compatibility investigation.

## Install this beta

Requires **Node.js 22 or newer**. The embedded configuration panel targets the current React 19 Signal K Admin UI. A transmit-capable N2K provider is required only for N2K output; a read-only gateway cannot transmit.

Back up your existing plugin settings and fuel totals first. The package retains the name `fuel-usage-calculator`, so it replaces the old package rather than running alongside it. This beta has not been published to npm.

In your Signal K configuration directory (commonly `~/.signalk`):

```sh
npm install 'github:cram001/fuel-usage-calculator-v2#feat/fdm-rebuild'
```

Git installation runs the included build script and needs development dependencies during installation. Restart Signal K, enable **Fuel Data Manager**, and open it from **WebApps**. Its direct URL is `/fuel-usage-calculator/`. Log in to Signal K as an administrator to use its API. No separate account or password is stored by this plugin.

1. Leave N2K output **Off** initially. Confirm each engine's displayed flow and selected source.
2. Resolve aliases under **Settings**. `main`/`port` default to instance 0, `starboard` to 1, and numeric names to their matching instance. Other names receive an available instance. These defaults are suggestions; verify them against your engine network. Disable duplicate paths representing the same physical engine.
3. Create each tank, set its actual initial quantity or mark it full, and assign engines on the Fuel page.
4. Choose your sample timeout and checkpoint interval. Timeout must exceed the normal interval between flow updates.
5. Test consumption against a known flow before enabling N2K output.

Legacy `savedUsage` values, when present in plugin options, are imported once from cubic metres into lifetime litres. Trip and season begin at zero because the old value does not establish their reset dates. Import does not infer tank inventory.

## Accounting and persistence

The previous valid fuel rate is integrated over elapsed monotonic time. Timer ticks and input packets share the same integration cursor, so an interval is counted only once. Input must have a source and a valid timestamp. Duplicate/out-of-order timestamps do not refresh the rate. Implausible, negative, stale or future samples are rejected. The first valid source is pinned; other detected sources do not also accumulate fuel.

After a missing update, the last rate is used only until the configured timeout (default **10 seconds**). This can overestimate if an engine stops without sending zero. Longer outages and server downtime are **not** estimated. After restart, a fresh sample is required. For engines that run while Signal K is off, an upstream cumulative counter on the ESP32 would improve continuity; this version does not ingest such a counter.

State is saved in the plugin data directory returned by Signal K's `getDataDirPath()` (typically `~/.signalk/plugin-data/fuel-usage-calculator/`). Two alternating JSON slots include checksums; writes use a temporary file, file sync, rename and directory sync. The latest valid revision wins on restart. Counters, reset baselines, tanks, mappings stored in state, and history survive normal reboots.

- Automatic checkpoint: default **30 seconds**; clean plugin stop also checkpoints.
- Reset, refuel and other WebApp mutations: checkpoint before reporting success.
- Sudden power loss can lose consumption since the latest completed checkpoint. Damaged storage can also force recovery from the older slot. This is not a guarantee against failed flash media.
- Storage failure pauses accounting and mutations and exposes **Retry checkpoint**. Resolve the disk issue, then retry; the paused interval is not reconstructed.
- The latest 256 action request IDs prevent duplicate application of immediate retries. The UI retains the ID for a failed identical action during that page session. After a reload or much later retry, inspect history before re-entering fuel.
- History retains 500 events, not an unlimited voyage log. Export backups periodically.

A backup replaces counters/inventory and clears live rates. It preserves the installation's N2K identity. If **both checkpoint slots are unreadable**, startup refuses to zero the counters. Preserve the damaged files, stop/disable the plugin, move `state-0.json` and `state-1.json` aside, start with N2K output off, and immediately restore a known-good downloaded backup from Diagnostics. Check quantities before resuming operation. Do not discard the damaged files until recovery is complete.

Calculated inventory is separate from a physical tank sender. It cannot account for leaks, fuel used by unmonitored appliances, unrecorded refills, or fuel transferred between tanks. Consumption is clamped at zero remaining fuel. Simultaneous split feeds, automatic physical-sender reconciliation, economy/range calculations and automatic fuel-flow calibration are not implemented. Supply **net engine consumption**, accounting for a diesel return line upstream.

## Signal K outputs

Published every second, with source `fuel-usage-calculator`:

| Path                                    | Units / meaning                         |
| --------------------------------------- | --------------------------------------- |
| `propulsion.<name>.trip.fuelUsed`       | m³ since trip reset                     |
| `propulsion.<name>.fuel.used`           | m³ lifetime consumption                 |
| `propulsion.<name>.fuel.seasonUsed`     | m³ since season reset; plugin extension |
| `tanks.fuel.fdm_<tankId>.currentVolume` | m³ calculated remaining fuel            |
| `tanks.fuel.fdm_<tankId>.capacity`      | m³ capacity                             |
| `tanks.fuel.fdm_<tankId>.currentLevel`  | 0–1 calculated fraction                 |

Custom `engine.<name>` input is normalized to `propulsion.<name>` for output. Treat paths with the same name as aliases and disable duplicates. Tank output has its own namespace so it does not overwrite a physical sender.

## NMEA 2000 output

| Mode                   | Behaviour                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Off                    | SK accounting and WebApp only                                                                                             |
| Existing provider      | Emits `nmea2000JsonOut` directly; your configured provider encodes/transmits the PGNs                                     |
| Virtual SK fuel device | Uses canboatjs `createEmulator()` on a provider that supports device creation; a distinct Signal K identity is advertised |

In virtual-device mode, select the provider ID when more than one capable provider is available. Device identity persists with the state. It identifies itself as **SK Fuel Manager / Signal K**, not as a Navico certified product. A provider mode counter means messages submitted, not verified bus delivery. Existing-provider mode cannot select among event listeners and may reach multiple configured transmitters; configure those listeners accordingly.

| PGN                             | Fields sent                     | Limits                                                                                                              |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 127497, Engine Trip Parameters  | engine instance, trip fuel used | Whole litres on the wire; overflow beyond 65,532 L is omitted                                                       |
| 127496, Trip Parameters, Vessel | estimated fuel remaining        | Whole litres; only when every tank quantity is known and every enabled engine has a non-conflicting tank assignment |

Unimplemented PGN fields remain unavailable. No proprietary seasonal PGN or incoming reset command is implemented. Recognizing standard data does **not** imply that a B&G plotter will identify this as a Navico FDM or expose every FDM page.

Emitter Cannon can alternatively emit the standard engine trip output using `propulsion.<name>.trip.fuelUsed`; leave this plugin's output off in that arrangement. **Use one emitter for each fuel PGN** to avoid conflicting sources. The Derived Data plugin remains useful for economy calculations, but is not part of this plugin's persistence or transmission path.

Diagnostics can record two minutes, up to 4,000 records / approximately 2 MB, using `N2KAnalyzerOut` and available canboatjs unparsed events. Individual records are limited to 32 KB. Downloads identify their coverage and dropped-record count. This is not guaranteed to be a complete raw CAN capture. Use a dedicated CAN logger if proprietary fast-packet reconstruction requires every frame. Captures are memory-only and replaced when a new recording starts.

## Onboard acceptance checks

1. Verify input units, timestamps, sources and engine instances with N2K output off.
2. Run a known flow for a measured interval; compare expected litres with the WebApp and tank deduction. Stop updates and verify stale status.
3. Reset trip and season independently, add fuel, mark full, restart SK, and verify state survives.
4. Disable overlapping Cannon fuel outputs. Enable the chosen direct output and inspect PGNs 127497/127496 on the bus.
5. On the B&G, select the appropriate data source if offered. Check displayed trip and remaining fuel before/after a WebApp reset/refill. Record model, firmware, gateway and captures if data is missing.

Onboard plotter testing is still required before treating this as a usable FDM replacement.

## Development

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:ui
```

Core tests cover integration boundaries, source conflicts, stale data, tank switching, independent resets, migration, checkpoint corruption, persistence failures, API retries, listener lifecycle, bounded capture and actual canboat encode/decode. Browser tests exercise the standalone workflow at desktop/mobile sizes and the federated panel in a React 19 host harness. The harness is not a full Signal K server or a physical plotter test.

## Sources and acknowledgments

- [Original npm package / Phil Begg repository](https://github.com/pbegg/fuel-usage-calculator) — inspiration and legacy data format. The npm link supplied for `fuel-usage-calculator` points here.
- [Emitter Cannon](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) — standard engine/vessel trip conversion references.
- [Signal K Derived Data](https://github.com/SignalK/signalk-derived-data) — Signal K calculator patterns.
- [Signal K WebApp development](https://github.com/SignalK/signalk-server/blob/master/docs/develop/webapps.md) — WebApp discovery and current federated UI integration.
- [canboatjs device emulator example](https://github.com/canboat/canboatjs/blob/master/examples/signalk-device-emulator/src/index.ts) and [provider implementation](https://github.com/canboat/canboatjs/blob/master/lib/canbus.ts) — direct output and device creation.
- [CANboat definitions](https://github.com/canboat/canboat) — PGN layouts. An incomplete proprietary PGN description is not enough to implement Navico seasonal output reliably.
- [Simrad Fuel Data Manager](https://www.simrad-yachting.com/en-ca/simrad/type/accessories/engine-management/fuel-data-manager-pk/) — OEM product describes accumulated trip/season fuel consumption for up to three engines. This plugin's tank/refuelling ledger is implemented independently.

Apache-2.0; see LICENSE and NOTICE.
