"use strict";
const { createHash } = require("node:crypto");
const {
  PGN_60928,
  PGN_126996,
  PGN_126998,
  ManufacturerCode,
  IndustryCode,
  YesNo,
} = require("@canboat/ts-pgns");
function messages(snapshot) {
  const result = [];
  for (const e of snapshot.engines) {
    if (!e.enabled || e.status === "instance conflict" || e.instance === null)
      continue;
    if (e.tripL <= 65532)
      result.push({
        pgn: 127497,
        prio: 5,
        dst: 255,
        fields: { instance: e.instance, tripFuelUsed: Math.round(e.tripL) },
      });
  }
  // Inventory is emitted only when all active engines have explicit tank assignments.
  const engines = snapshot.engines.filter((e) => e.enabled);
  const tanks = snapshot.tanks;
  if (
    tanks.length &&
    tanks.every((t) => t.remainingL !== null) &&
    engines.length &&
    engines.every((e) => e.tankId && e.status !== "instance conflict")
  ) {
    const fuel = tanks.reduce((sum, t) => sum + t.remainingL, 0);
    if (fuel <= 65532)
      result.push({
        pgn: 127496,
        prio: 5,
        dst: 255,
        fields: { estimatedFuelRemaining: Math.round(fuel) },
      });
  }
  return result;
}
class Transport {
  constructor(app, options, serial, onError) {
    this.app = app;
    this.options = options;
    this.serial = serial;
    this.onError = onError;
    this.emulator = null;
    this.utils = null;
    this.stopped = false;
    this.sent = 0;
    this.providers = [];
    this.status =
      options.outputMode === "off"
        ? "N2K output disabled"
        : "Waiting for N2K provider";
  }
  start() {
    if (this.options.outputMode !== "device") {
      if (this.options.outputMode === "provider")
        this.status =
          "Using configured nmea2000JsonOut listeners; bus delivery not confirmed";
      return;
    }
    if (typeof this.app.onPropertyValues !== "function") {
      this.status = "This SK version does not expose device creation";
      return;
    }
    this.unsubscribe = this.app.onPropertyValues(
      "canboatjsUtils",
      (history) => {
        if (this.stopped || this.emulator) return;
        const entries = [
          ...new Map(
            (history || [])
              .filter(Boolean)
              .map((p) => p.value)
              .filter(Boolean)
              .map((e) => [e.providerId || e.id || e.utils, e]),
          ).values(),
        ];
        this.providers = entries.map((e) => ({
          id: e.providerId || e.id || "",
          supportsDeviceCreation: !!e.utils?.supportsDeviceCreation,
        }));
        const capable = entries.filter(
          (e) =>
            e.utils?.supportsDeviceCreation &&
            (!this.options.providerId ||
              (e.providerId || e.id) === this.options.providerId),
        );
        if (capable.length !== 1) {
          this.status = capable.length
            ? "Select one provider ID before creating a device"
            : "No matching provider supports device creation";
          return;
        }
        try {
          this.utils = capable[0].utils;
          this.emulator = this.utils.createEmulator(
            "sk-fuel-usage-mgr-emulator",
            {},
            new PGN_60928({
              uniqueNumber:
                createHash("sha256")
                  .update(this.serial)
                  .digest()
                  .readUInt32LE(0) & 0x1fffff,
              manufacturerCode: ManufacturerCode.SignalK,
              deviceFunction: 130,
              deviceClass: 50,
              deviceInstanceLower: 0,
              deviceInstanceUpper: 0,
              systemInstance: 0,
              industryGroup: IndustryCode.Marine,
              arbitraryAddressCapable: YesNo.Yes,
            }),
            new PGN_126996({
              nmea2000Version: 2100,
              productCode: 100,
              modelId: "SK Fuel Usage Mgr Emulator",
              softwareVersionCode: "2.0.0-beta.1",
              modelVersion: "1",
              modelSerialCode: this.serial.slice(0, 32),
              certificationLevel: 0,
              loadEquivalency: 0,
            }),
            new PGN_126998({
              installationDescription1: "Signal K fuel accounting",
            }),
          );
          this.status =
            "Virtual device created; plotter compatibility unverified";
        } catch (error) {
          this.status = error.message;
          this.onError(error);
        }
      },
    );
  }
  send(snapshot) {
    if (this.stopped || this.options.outputMode === "off") return;
    for (const pgn of messages(snapshot)) {
      if (this.options.outputMode === "device") {
        if (!this.emulator) return;
        this.emulator.send(pgn);
      } else this.app.emit("nmea2000JsonOut", pgn);
      this.sent++;
    }
  }
  stop() {
    this.stopped = true;
    if (typeof this.unsubscribe === "function") this.unsubscribe();
    if (this.emulator) this.utils.removeEmulator("sk-fuel-usage-mgr-emulator");
    this.emulator = null;
  }
}
module.exports = { messages, Transport };
