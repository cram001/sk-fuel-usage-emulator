"use strict";
const { randomUUID } = require("node:crypto");
const finite = (x, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const pathPattern = /^(propulsion|engine)\.([A-Za-z0-9_-]+)\.fuel\.rate$/;
const safeId = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const defaults = {
  timeoutSeconds: 10,
  checkpointSeconds: 30,
  maxFuelRateLph: 1000,
  outputMode: "off",
  providerId: "",
  mappings: [],
};
function config(input = {}) {
  const c = { ...defaults, ...input };
  for (const [key, min, max] of [
    ["timeoutSeconds", 1, 300],
    ["checkpointSeconds", 1, 3600],
    ["maxFuelRateLph", 1, 100000],
  ]) {
    if (!finite(c[key], min, max)) throw new Error(`Invalid ${key}`);
  }
  if (!["off", "provider", "device"].includes(c.outputMode))
    throw new Error("Invalid output mode");
  if (typeof c.providerId !== "string" || c.providerId.length > 128)
    throw new Error("Invalid provider ID");
  if (!Array.isArray(c.mappings) || c.mappings.length > 64)
    throw new Error("Invalid engine mappings");
  const paths = new Set(),
    instances = new Set();
  for (const m of c.mappings) {
    if (!m || !pathPattern.test(m.path) || paths.has(m.path))
      throw new Error("Invalid or duplicate engine path");
    paths.add(m.path);
    if (
      typeof m.enabled !== "boolean" ||
      typeof m.source !== "string" ||
      m.source.length > 256
    )
      throw new Error("Invalid mapping source/enabled");
    if (!Number.isInteger(m.instance) || !finite(m.instance, 0, 252))
      throw new Error("Invalid engine instance");
    if (m.enabled && instances.has(m.instance))
      throw new Error(
        "Enabled engines must have different N2K instances; disable duplicate aliases",
      );
    if (m.enabled) instances.add(m.instance);
  }
  return c;
}
function freshState() {
  return {
    version: 2,
    revision: 0,
    serial: randomUUID(),
    engines: [],
    tanks: [],
    history: [],
    requests: [],
    migrated: false,
  };
}
function validateState(s) {
  if (
    !s ||
    s.version !== 2 ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    typeof s.serial !== "string" ||
    s.serial.length > 80
  )
    throw new Error("Invalid fuel state header");
  for (const [key, max] of [
    ["engines", 64],
    ["tanks", 32],
    ["history", 500],
    ["requests", 256],
  ])
    if (!Array.isArray(s[key]) || s[key].length > max)
      throw new Error(`Invalid ${key}`);
  const ids = new Set(),
    paths = new Set();
  for (const e of s.engines) {
    if (
      !e ||
      typeof e.name !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(e.name) ||
      !safeId(e.id) ||
      ids.has(e.id) ||
      !pathPattern.test(e.path) ||
      typeof e.source !== "string"
    )
      throw new Error("Invalid engine identity");
    ids.add(e.id);
    if (paths.has(e.path)) throw new Error("Duplicate engine path");
    paths.add(e.path);
    for (const key of ["totalL", "tripBaseL", "seasonBaseL", "gaps"])
      if (!finite(e[key])) throw new Error(`Invalid engine ${key}`);
    if (e.tripBaseL > e.totalL || e.seasonBaseL > e.totalL)
      throw new Error("Invalid fuel baseline");
    if (
      e.instance !== null &&
      (!Number.isInteger(e.instance) || !finite(e.instance, 0, 252))
    )
      throw new Error("Invalid instance");
    if (typeof e.enabled !== "boolean") throw new Error("Invalid enabled flag");
    if (e.tankId !== null && !safeId(e.tankId))
      throw new Error("Invalid tank mapping");
  }
  const tanks = new Set();
  for (const t of s.tanks) {
    if (
      !safeId(t.id) ||
      tanks.has(t.id) ||
      typeof t.name !== "string" ||
      t.name.length > 80 ||
      !finite(t.capacityL, 0.1, 1000000) ||
      !finite(t.reserveL, 0, t.capacityL) ||
      !(t.remainingL === null || finite(t.remainingL, 0, t.capacityL))
    )
      throw new Error("Invalid tank");
    tanks.add(t.id);
  }
  if (s.engines.some((e) => e.tankId && !tanks.has(e.tankId)))
    throw new Error("Missing mapped tank");
  if (
    s.history.some(
      (h) =>
        !h ||
        typeof h.at !== "string" ||
        !Number.isFinite(Date.parse(h.at)) ||
        typeof h.action !== "string",
    )
  )
    throw new Error("Invalid history");
  if (s.requests.some((x) => typeof x !== "string" || x.length > 128))
    throw new Error("Invalid request ledger");
  return s;
}
class Model {
  constructor(state = freshState(), options = {}) {
    this.state = validateState(state);
    this.options = config(options);
    this.live = new Map();
    this.candidates = new Map();
    for (const e of state.engines) this.applyMapping(e);
  }
  changed() {
    this.state.revision++;
  }
  event(action, details, now = Date.now()) {
    this.state.history.push({
      at: new Date(now).toISOString(),
      action,
      ...details,
    });
    this.state.history = this.state.history.slice(-500);
    this.changed();
  }
  applyMapping(e) {
    const m = this.options.mappings.find((m) => m.path === e.path);
    if (m) {
      e.instance = m.instance;
      e.enabled = m.enabled;
      if (m.source) e.source = m.source;
    }
  }
  discover(path, source) {
    let e = this.state.engines.find((e) => e.path === path);
    if (e) return e;
    if (this.state.engines.length >= 64)
      throw new Error("Engine discovery limit reached");
    const name = path.match(pathPattern)[2];
    const used = new Set(this.state.engines.map((e) => e.instance));
    let instance =
      /^\d+$/.test(name) && Number(name) <= 252
        ? Number(name)
        : name === "main" || name === "port"
          ? 0
          : name === "starboard"
            ? 1
            : null;
    if (instance === null) {
      instance =
        Array.from({ length: 253 }, (_, i) => i).find((i) => !used.has(i)) ??
        null;
    }
    e = {
      id: randomUUID(),
      name,
      path,
      source,
      instance,
      enabled: true,
      totalL: 0,
      tripBaseL: 0,
      seasonBaseL: 0,
      tankId: null,
      gaps: 0,
      lastSeen: null,
    };
    this.applyMapping(e);
    this.state.engines.push(e);
    this.event("engine-discovered", { engineId: e.id, path, source });
    return e;
  }
  conflict(e) {
    return (
      e.enabled &&
      this.state.engines.some(
        (other) =>
          other.id !== e.id && other.enabled && other.instance === e.instance,
      )
    );
  }
  advance(e, mono) {
    const r = this.live.get(e.id);
    if (!r || !e.enabled || this.conflict(e)) return;
    const end = Math.min(mono, r.received + this.options.timeoutSeconds * 1000);
    const seconds = Math.max(0, end - r.integrated) / 1000;
    if (seconds > 0) {
      const delta = (r.rateLph * seconds) / 3600;
      e.totalL += delta;
      const tank = this.state.tanks.find((t) => t.id === e.tankId);
      if (tank && tank.remainingL !== null)
        tank.remainingL = Math.max(0, tank.remainingL - delta);
      r.integrated = end;
      if (delta > 0) this.changed();
    }
    if (
      mono - r.received > this.options.timeoutSeconds * 1000 &&
      !r.gapRecorded
    ) {
      e.gaps++;
      r.gapRecorded = true;
      this.event("data-gap", { engineId: e.id });
    }
  }
  tick(mono) {
    for (const e of this.state.engines) this.advance(e, mono);
  }
  ingest(path, value, source, timestamp, mono, wall = Date.now()) {
    if (
      !pathPattern.test(path) ||
      typeof source !== "string" ||
      !source ||
      source.includes("sk-fuel-usage-mgr-emulator")
    )
      return;
    const time = Date.parse(timestamp);
    let e = this.state.engines.find((e) => e.path === path);
    if (
      !finite(value, 0, this.options.maxFuelRateLph / 3600000) ||
      !Number.isFinite(time) ||
      time > wall + 2000 ||
      wall - time > this.options.timeoutSeconds * 1000
    ) {
      if (e && e.source === source) {
        this.advance(e, mono);
        this.live.delete(e.id);
      }
      return;
    }
    e = e || this.discover(path, source);
    if (!e.source) e.source = source;
    const sources = this.candidates.get(e.id) || new Set();
    sources.add(source);
    this.candidates.set(e.id, sources);
    if (!e.enabled || this.conflict(e) || e.source !== source) return;
    const prior = this.live.get(e.id);
    if (prior && time <= prior.timestamp) return; // No replay, duplicate timestamp, or old packet refresh.
    this.advance(e, mono);
    this.live.set(e.id, {
      rateLph: value * 3600000,
      timestamp: time,
      received: mono,
      integrated: mono,
      gapRecorded: false,
    });
    e.lastSeen = new Date(time).toISOString();
    this.changed();
  }
  reset(id, scope, mono) {
    if (!["trip", "season"].includes(scope))
      throw new Error("Invalid reset scope");
    const engines =
      id === "all"
        ? this.state.engines
        : this.state.engines.filter((e) => e.id === id);
    if (!engines.length) throw new Error("Engine not found");
    this.tick(mono);
    for (const e of engines)
      e[scope === "trip" ? "tripBaseL" : "seasonBaseL"] = e.totalL;
    this.event(`${scope}-reset`, { engineId: id });
  }
  tank(body) {
    if (
      !safeId(body.id) ||
      typeof body.name !== "string" ||
      body.name.length > 80 ||
      !finite(body.capacityL, 0.1, 1000000) ||
      !finite(body.reserveL, 0, body.capacityL)
    )
      throw new Error("Invalid tank configuration");
    let t = this.state.tanks.find((t) => t.id === body.id);
    if (t && t.remainingL !== null && t.remainingL > body.capacityL)
      throw new Error("Capacity is less than recorded fuel");
    if (t)
      Object.assign(t, {
        name: body.name,
        capacityL: body.capacityL,
        reserveL: body.reserveL,
      });
    else {
      if (this.state.tanks.length >= 32) throw new Error("Tank limit reached");
      t = {
        id: body.id,
        name: body.name,
        capacityL: body.capacityL,
        reserveL: body.reserveL,
        remainingL: null,
        lastFullAt: null,
      };
      this.state.tanks.push(t);
    }
    this.event("tank-configured", { tankId: t.id });
  }
  refuel(id, mode, liters) {
    const t = this.state.tanks.find((t) => t.id === id);
    if (!t) throw new Error("Tank not found");
    const before = t.remainingL;
    if (mode === "full") {
      t.remainingL = t.capacityL;
      t.lastFullAt = new Date().toISOString();
    } else if (mode === "add") {
      if (t.remainingL === null)
        throw new Error("Set initial fuel quantity before adding fuel");
      if (
        !finite(liters, 0.001, t.capacityL) ||
        t.remainingL + liters > t.capacityL
      )
        throw new Error("Added fuel exceeds tank capacity");
      t.remainingL += liters;
    } else if (mode === "set") {
      if (!finite(liters, 0, t.capacityL))
        throw new Error("Invalid fuel quantity");
      t.remainingL = liters;
    } else throw new Error("Invalid refuel operation");
    this.event(`fuel-${mode}`, {
      tankId: id,
      beforeL: before,
      afterL: t.remainingL,
      addedL: mode === "add" ? liters : null,
    });
  }
  mapTank(engineId, tankId, mono) {
    const e = this.state.engines.find((e) => e.id === engineId);
    if (
      !e ||
      (tankId !== null && !this.state.tanks.some((t) => t.id === tankId))
    )
      throw new Error("Invalid engine/tank");
    this.tick(mono);
    e.tankId = tankId;
    this.event("tank-mapped", { engineId, tankId });
  }
  snapshot(mono) {
    return {
      ...structuredClone(this.state),
      engines: this.state.engines.map((e) => {
        const r = this.live.get(e.id);
        const conflict = this.conflict(e);
        const status = !e.enabled
          ? "disabled"
          : conflict
            ? "instance conflict"
            : !r
              ? "waiting"
              : mono - r.received > this.options.timeoutSeconds * 1000
                ? "stale"
                : "live";
        return {
          ...e,
          tripL: e.totalL - e.tripBaseL,
          seasonL: e.totalL - e.seasonBaseL,
          rateLph: status === "live" ? r.rateLph : null,
          status,
          sources: [...(this.candidates.get(e.id) || new Set([e.source]))],
        };
      }),
    };
  }
  migrate(savedUsage) {
    if (this.state.migrated) return;
    for (const [path, total] of Object.entries(savedUsage || {})) {
      const ratePath = path.replace(/\.fuel\.used$/, ".fuel.rate");
      if (pathPattern.test(ratePath) && finite(total)) {
        const e = this.discover(ratePath, "legacy-unassigned");
        e.totalL = total * 1000;
        e.tripBaseL = e.totalL;
        e.seasonBaseL = e.totalL;
        e.source = "";
      }
    }
    this.state.migrated = true;
    this.event("migration", {
      note: "Legacy cubic metres imported as lifetime fuel; new trip and season start at zero.",
    });
  }
}
module.exports = {
  Model,
  config,
  defaults,
  freshState,
  validateState,
  pathPattern,
  finite,
};
