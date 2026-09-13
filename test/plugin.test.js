"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const request = require("supertest");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pluginFactory = require("..");
const { Transport, messages } = require("../lib/n2k");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdm-api-")),
    app = new EventEmitter();
  let cb;
  Object.assign(app, {
    getDataDirPath: () => dir,
    getSelfPath: () => undefined,
    selfContext: "vessels.test",
    error: () => {},
    setPluginStatus: () => {},
    handleMessage: () => {},
    savePluginOptions: (c, done) => done(),
    subscriptionmanager: {
      subscribe: (spec, unsubs, error, fn) => {
        cb = fn;
        unsubs.push(() => {
          cb = null;
        });
      },
    },
  });
  const plugin = pluginFactory(app),
    http = express(),
    router = express.Router();
  http.use(express.json({ limit: "1mb" }));
  plugin.registerWithRouter(router);
  http.use("/plugins/fuel-usage-calculator", router);
  plugin.start();
  t.after(() => {
    plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, plugin, http, dir, delta: (d) => cb(d) };
}
const action = (http, body) =>
  request(http)
    .post("/plugins/fuel-usage-calculator/action")
    .set("X-Fuel-Manager", "1")
    .send(body);
test("actions save durably and refuelling request retries are idempotent", async (t) => {
  const f = fixture(t);
  await action(f.http, {
    action: "tank",
    id: "main",
    name: "Main",
    capacityL: 100,
    reserveL: 5,
    requestId: "1",
  }).expect(200);
  await action(f.http, {
    action: "refuel",
    tankId: "main",
    mode: "set",
    liters: 20,
    requestId: "2",
  }).expect(200);
  for (let i = 0; i < 2; i++)
    await action(f.http, {
      action: "refuel",
      tankId: "main",
      mode: "add",
      liters: 10,
      requestId: "3",
    }).expect(200);
  f.plugin.stop();
  f.plugin.start();
  const r = await request(f.http).get("/plugins/fuel-usage-calculator/status");
  assert.equal(r.body.state.tanks[0].remainingL, 30);
});
test("all delta values processed; wrong vessel, unknown source and self echo ignored", async (t) => {
  const f = fixture(t),
    updates = [
      {
        timestamp: new Date().toISOString(),
        $source: "sensor",
        values: [
          { path: "propulsion.0.fuel.rate", value: 0 },
          { path: "propulsion.1.fuel.rate", value: 0 },
        ],
      },
    ];
  f.delta({ context: "vessels.other", updates });
  f.delta({ context: "vessels.test", updates });
  const r = await request(f.http).get("/plugins/fuel-usage-calculator/status");
  assert.equal(r.body.state.engines.length, 2);
  f.delta({ updates: [{ ...updates[0], $source: "fuel-usage-calculator" }] });
});
test("validation and missing CSRF header cannot mutate totals", async (t) => {
  const f = fixture(t);
  await request(f.http)
    .post("/plugins/fuel-usage-calculator/action")
    .send({ action: "reset", requestId: "a" })
    .expect(403);
  await action(f.http, {
    action: "tank",
    id: "bad",
    name: "x",
    capacityL: -1,
    reserveL: 0,
    requestId: "b",
  }).expect(400);
  const r = await request(f.http).get("/plugins/fuel-usage-calculator/status");
  assert.equal(r.body.state.tanks.length, 0);
});
test("storage errors pause accounting and mutations instead of claiming success", async (t) => {
  const f = fixture(t);
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated disk error");
  };
  try {
    await action(f.http, {
      action: "tank",
      id: "x",
      name: "X",
      capacityL: 10,
      reserveL: 0,
      requestId: "x",
    }).expect(503);
  } finally {
    fs.renameSync = original;
  }
  const r = await request(f.http).get("/plugins/fuel-usage-calculator/status");
  assert.match(r.body.blocked, /Persistence failed/);
  assert.equal(r.body.state.tanks.length, 0);
  await action(f.http, { action: "checkpoint", requestId: "recover" }).expect(
    200,
  );
});
test("WebApp settings save restarts subscriptions without leaking listeners", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++)
    await request(f.http)
      .post("/plugins/fuel-usage-calculator/settings")
      .set("X-Fuel-Manager", "1")
      .send({ configuration: { checkpointSeconds: 15 } })
      .expect(200);
  assert.equal(f.app.listenerCount("N2KAnalyzerOut"), 1);
  f.plugin.stop();
  assert.equal(f.app.listenerCount("N2KAnalyzerOut"), 0);
});
test("capture is bounded; raw payload representation is retained", async (t) => {
  const f = fixture(t);
  await action(f.http, { action: "captureStart", requestId: "capture" }).expect(
    200,
  );
  f.app.emit("canboatjs:unparsed:data", Buffer.from([0, 1, 255]));
  for (let i = 0; i < 4010; i++)
    f.app.emit("N2KAnalyzerOut", { pgn: 127497, src: 1, dst: 255 });
  const r = await request(f.http).get("/plugins/fuel-usage-calculator/capture");
  assert.equal(r.body.records.length, 4000);
  assert.equal(r.body.records[0].data.hex, "0001ff");
  assert.ok(r.body.dropped > 0);
});
test("standard N2K outputs exclude disabled/conflicting engines and reject overflow", () => {
  const snapshot = {
    engines: [
      { enabled: true, status: "waiting", instance: 0, tripL: 25, tankId: "t" },
      { enabled: false, status: "disabled", instance: 1, tripL: 50 },
    ],
    tanks: [{ id: "t", remainingL: 40 }],
  };
  const m = messages(snapshot);
  assert.equal(m[0].fields.tripFuelUsed, 25);
  assert.equal(m[1].fields.estimatedFuelRemaining, 40);
  snapshot.engines[0].tripL = 70000;
  assert.equal(
    messages(snapshot).some((p) => p.pgn === 127497),
    false,
  );
});
test("device creation waits for provider and uses stable identity; stop unsubscribes", () => {
  const app = new EventEmitter();
  let cb,
    removed = 0,
    sent = [],
    claim;
  app.onPropertyValues = (name, fn) => {
    cb = fn;
    return () => removed++;
  };
  const utils = {
    supportsDeviceCreation: true,
    createEmulator: (id, o, a) => {
      claim = a;
      return { send: (p) => sent.push(p) };
    },
    removeEmulator: () => removed++,
  };
  const tr = new Transport(
    app,
    { outputMode: "device", providerId: "" },
    "serial",
    (e) => {
      throw e;
    },
  );
  tr.start();
  cb([{ value: { id: "can0", utils } }]);
  assert.equal(claim.fields.manufacturerCode, "Signal K");
  tr.send({
    engines: [{ enabled: true, status: "waiting", instance: 0, tripL: 25 }],
    tanks: [],
  });
  assert.equal(sent.length, 1);
  tr.stop();
  assert.equal(removed, 2);
});
test("actual canboat encoder/decoder round-trip preserves trip, inventory and device identity", () => {
  const { pgnToActisenseSerialFormat, FromPgn } = require("@canboat/canboatjs");
  const decode = (p) =>
    new FromPgn({ useCamelCompat: false }).parseString(
      pgnToActisenseSerialFormat(p),
    );
  const output = messages({
    engines: [
      {
        enabled: true,
        status: "waiting",
        instance: 2,
        tripL: 25.4,
        tankId: "t",
      },
    ],
    tanks: [{ id: "t", remainingL: 80 }],
  });
  assert.equal(decode(output[0]).fields.tripFuelUsed, 25);
  assert.equal(decode(output[0]).fields.instance, 2);
  assert.equal(decode(output[1]).fields.estimatedFuelRemaining, 80);
  let callback, identity;
  const app = {
    onPropertyValues: (n, cb) => {
      callback = cb;
      return () => {};
    },
  };
  const utils = {
    supportsDeviceCreation: true,
    createEmulator: (id, o, a, p) => {
      identity = [a, p];
      return { send: () => {} };
    },
    removeEmulator: () => {},
  };
  const t = new Transport(
    app,
    { outputMode: "device", providerId: "" },
    "known-serial",
    (e) => {
      throw e;
    },
  );
  t.start();
  callback([{ value: { id: "can0", utils } }]);
  const claim = decode(identity[0]);
  assert.equal(claim.fields.deviceClass, "Propulsion");
  assert.equal(claim.fields.deviceFunction, 130);
  assert.equal(claim.fields.manufacturerCode, "Signal K");
  assert.equal(decode(identity[1]).fields.modelId, "SK Fuel Manager");
  t.stop();
});
