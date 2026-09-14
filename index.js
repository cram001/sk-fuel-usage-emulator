"use strict";
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  Model,
  config,
  defaults,
  validateState,
  pathPattern,
} = require("./lib/model");
const { Store } = require("./lib/store");
const { Transport } = require("./lib/n2k");
const ID = "sk-fuel-usage-mgr-emulator";
module.exports = function (app) {
  let model,
    store,
    transport,
    timer,
    options,
    running = false,
    blocked = null,
    lastCheckpoint = 0;
  let unsubscribes = [],
    listeners = [];
  let capture = { active: false, records: [], bytes: 0, dropped: 0, until: 0 };
  const error = (e) => {
    app.error(e.message || String(e));
    app.setPluginError?.(e.message || String(e));
  };
  function record(kind, value) {
    if (!capture.active || Date.now() > capture.until) {
      capture.active = false;
      return;
    }
    try {
      const entry = {
        at: new Date().toISOString(),
        kind,
        data: Buffer.isBuffer(value) ? { hex: value.toString("hex") } : value,
      };
      const text = JSON.stringify(entry);
      if (
        text.length > 32768 ||
        capture.records.length >= 4000 ||
        capture.bytes + text.length > 2000000
      ) {
        capture.dropped++;
        return;
      }
      capture.records.push(JSON.parse(text));
      capture.bytes += text.length;
    } catch {
      capture.dropped++;
    }
  }
  function checkpoint() {
    try {
      store.save(model.state);
      lastCheckpoint = performance.now();
      blocked = null;
    } catch (e) {
      blocked = "Persistence failed: " + e.message;
      error(e);
      throw e;
    }
  }
  function status() {
    return {
      running,
      blocked,
      configuration: options || defaults,
      state: model?.snapshot(performance.now()) || null,
      lastSave: store?.lastSave || null,
      storageWarning: store?.warning || null,
      n2k: {
        status: transport?.status || "Stopped",
        submitted: transport?.sent || 0,
        providers: transport?.providers || [],
      },
      capture: {
        active: capture.active && Date.now() < capture.until,
        count: capture.records.length,
        dropped: capture.dropped,
      },
      protocol: {
        standardTrip: true,
        navicoSeasonal: false,
        nativeResets: false,
      },
    };
  }
  function publish() {
    const s = model.snapshot(performance.now()),
      values = [],
      meta = [];
    for (const e of s.engines) {
      if (!e.enabled || e.status === "instance conflict") continue;
      const root = `propulsion.${e.name}`;
      for (const [key, value] of [
        ["trip.fuelUsed", e.tripL / 1000],
        ["fuel.used", e.totalL / 1000],
        ["fuel.seasonUsed", e.seasonL / 1000],
      ]) {
        const p = `${root}.${key}`;
        values.push({ path: p, value });
        meta.push({
          path: p,
          value: {
            units: "m3",
            description: "SK Fuel Usage Manager Emulator accumulated consumption",
          },
        });
      }
    }
    // A separate namespace avoids overwriting a physical sender's currentVolume.
    for (const t of s.tanks)
      if (t.remainingL !== null) {
        const p = `tanks.fuel.fdm_${t.id}`;
        values.push(
          { path: p + ".currentVolume", value: t.remainingL / 1000 },
          { path: p + ".capacity", value: t.capacityL / 1000 },
          { path: p + ".currentLevel", value: t.remainingL / t.capacityL },
        );
      }
    if (values.length)
      app.handleMessage(ID, {
        updates: [{ timestamp: new Date().toISOString(), values, meta }],
      });
    transport.send(s);
  }
  function delta(message) {
    if (!running || blocked) return;
    if (
      message.context &&
      message.context !== "vessels.self" &&
      message.context !== app.selfContext
    )
      return;
    for (const u of message.updates || []) {
      const source =
        u.$source ||
        (u.source?.label
          ? `${u.source.label}${u.source.src === undefined ? "" : "." + u.source.src}`
          : "");
      for (const v of u.values || [])
        if (pathPattern.test(v.path)) {
          try {
            model.ingest(
              v.path,
              v.value,
              source,
              u.timestamp,
              performance.now(),
            );
          } catch (e) {
            error(e);
          }
        }
    }
  }
  const plugin = {
    id: ID,
    name: "SK Fuel Usage Manager Emulator",
    description:
      "Persistent engine fuel totals, refuelling and tank inventory. Standard N2K output; Navico proprietary seasonal protocol remains unverified.",
    schema: {
      type: "object",
      properties: {
        timeoutSeconds: {
          type: "number",
          title: "Fuel sample timeout (seconds)",
          default: 10,
          minimum: 1,
          maximum: 300,
        },
        checkpointSeconds: {
          type: "number",
          title: "Checkpoint interval (seconds)",
          default: 30,
          minimum: 1,
          maximum: 3600,
        },
        maxFuelRateLph: {
          type: "number",
          title: "Maximum plausible per-engine flow (L/h)",
          default: 1000,
          minimum: 1,
        },
        outputMode: {
          type: "string",
          title: "N2K output",
          enum: ["off", "provider", "device"],
          default: "off",
        },
        providerId: {
          type: "string",
          title: "Virtual-device provider ID",
          default: "",
        },
        mappings: {
          type: "array",
          title: "Engine source and instance overrides",
          default: [],
          items: {
            type: "object",
            required: ["path", "source", "instance", "enabled"],
            properties: {
              path: { type: "string" },
              source: { type: "string", default: "" },
              instance: { type: "integer", minimum: 0, maximum: 252 },
              enabled: { type: "boolean", default: true },
            },
          },
        },
      },
    },
    start(input = {}) {
      plugin.stop();
      options = config(input);
      const directory =
        typeof app.getDataDirPath === "function"
          ? app.getDataDirPath()
          : app.config?.configPath
            ? path.join(app.config.configPath, "plugin-data", ID)
            : null;
      if (!directory)
        throw new Error("SK persistent data directory is unavailable");
      store = new Store(directory);
      model = new Model(store.load(), options);
      model.migrate(input.savedUsage);
      checkpoint();
      transport = new Transport(app, options, model.state.serial, error);
      transport.start();
      running = true;
      app.subscriptionmanager.subscribe(
        {
          context: "vessels.self",
          subscribe: [
            { path: "propulsion.*.fuel.rate", policy: "instant" },
            { path: "engine.*.fuel.rate", policy: "instant" },
          ],
        },
        unsubscribes,
        error,
        delta,
      );
      // Inventory existing paths without integrating or treating cached values as live.
      for (const root of ["propulsion", "engine"]) {
        const tree = app.getSelfPath?.(root) || {};
        for (const [name, e] of Object.entries(tree)) {
          const leaf = e?.fuel?.rate;
          if (!leaf || !Number.isFinite(leaf.value)) continue;
          const p = `${root}.${name}.fuel.rate`;
          if (pathPattern.test(p)) model.discover(p, leaf.$source || "");
        }
      }
      for (const event of [
        "N2KAnalyzerOut",
        "canboatjs:unparsed:data",
        "canboatjs:unparsed:object",
      ]) {
        const fn = (p) => record(event, p);
        app.on(event, fn);
        listeners.push([event, fn]);
      }
      timer = setInterval(() => {
        if (!running || blocked) return;
        try {
          model.tick(performance.now());
          if (
            performance.now() - lastCheckpoint >=
            options.checkpointSeconds * 1000
          )
            checkpoint();
          publish();
        } catch (e) {
          error(e);
        }
      }, 1000);
      timer.unref?.();
      app.setPluginStatus(
        "Fuel manager running; open the SK Fuel Usage Manager Emulator WebApp",
      );
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      unsubscribes.forEach((fn) => fn());
      unsubscribes = [];
      listeners.forEach(([event, fn]) => app.removeListener(event, fn));
      listeners = [];
      transport?.stop();
      capture.active = false;
      if (model && store && !blocked) {
        model.tick(performance.now());
        try {
          checkpoint();
        } catch {}
      }
      model = undefined;
      store = undefined;
      transport = undefined;
    },
    registerWithRouter(router) {
      // SK enforces admin access to plugin routes by default. Do not bypass it.
      router.get("/status", (_req, res) => res.json(status()));
      router.get("/backup", (_req, res) => {
        if (!model) return res.status(503).json({ error: "Plugin is stopped" });
        res
          .set(
            "Content-Disposition",
            'attachment; filename="sk-fuel-usage-mgr-emulator-backup.json"',
          )
          .json(model.state);
      });
      router.get("/capture", (_req, res) =>
        res
          .set(
            "Content-Disposition",
            'attachment; filename="sk-fuel-usage-mgr-emulator-capture.json"',
          )
          .json({
            format: 1,
            coverage:
              "Decoded N2K plus unparsed events exposed by this provider; not a guaranteed complete raw CAN log.",
            dropped: capture.dropped,
            records: capture.records,
          }),
      );
      router.post("/settings", (req, res) => {
        if (req.get("X-Fuel-Manager") !== "1" || !req.is("application/json"))
          return res
            .status(403)
            .json({ error: "JSON request header required" });
        if (blocked) return res.status(503).json({ error: blocked });
        let next;
        try {
          next = config(req.body?.configuration);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        if (typeof app.savePluginOptions !== "function")
          return res
            .status(503)
            .json({
              error: "Use the Signal K configuration panel to save settings",
            });
        app.savePluginOptions(next, (err) => {
          if (err) return res.status(500).json({ error: String(err) });
          try {
            if (running) plugin.start(next);
            else options = next;
            res.json(status());
          } catch (e) {
            error(e);
            res.status(500).json({ error: e.message });
          }
        });
      });
      router.post("/action", (req, res) => {
        if (!running || !model)
          return res
            .status(503)
            .json({ error: "Enable the plugin before using fuel controls" });
        // Require JSON and a non-simple header to prevent cross-site form mutations.
        if (req.get("X-Fuel-Manager") !== "1" || !req.is("application/json"))
          return res
            .status(403)
            .json({ error: "JSON request header required" });
        const b = req.body;
        if (
          !b ||
          typeof b.requestId !== "string" ||
          b.requestId.length > 128 ||
          !b.requestId.length
        )
          return res.status(400).json({ error: "Unique requestId required" });
        if (model.state.requests.includes(b.requestId))
          return res.json(status());
        if (blocked && b.action !== "checkpoint")
          return res.status(503).json({ error: blocked });
        const before = structuredClone(model.state),
          beforeLive = structuredClone(model.live);
        try {
          model.tick(performance.now());
          if (b.action === "reset")
            model.reset(b.engineId, b.scope, performance.now());
          else if (b.action === "tank") model.tank(b);
          else if (b.action === "refuel")
            model.refuel(b.tankId, b.mode, b.liters);
          else if (b.action === "mapTank")
            model.mapTank(b.engineId, b.tankId, performance.now());
          else if (b.action === "restore") {
            const restored = validateState(structuredClone(b.state));
            restored.revision = model.state.revision + 1;
            restored.serial = model.state.serial;
            model = new Model(restored, options);
            model.event("backup-restored", {});
          } else if (b.action === "captureStart")
            capture = {
              active: true,
              records: [],
              bytes: 0,
              dropped: 0,
              until: Date.now() + 120000,
            };
          else if (b.action === "captureStop") capture.active = false;
          else if (b.action === "captureMark")
            record("user-action", String(b.label || "").slice(0, 120));
          else if (b.action !== "checkpoint") throw new Error("Unknown action");
          model.state.requests.push(b.requestId);
          model.state.requests = model.state.requests.slice(-256);
          model.changed();
          checkpoint();
          res.json(status());
        } catch (e) {
          model.state = before;
          model.live = blocked ? new Map() : beforeLive;
          error(e);
          res.status(blocked ? 503 : 400).json({ error: e.message });
        }
      });
    },
  };
  return plugin;
};
