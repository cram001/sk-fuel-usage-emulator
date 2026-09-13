"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Model, config, freshState, validateState } = require("../lib/model");
const wall = Date.parse("2026-09-13T12:00:00Z");
function sample(m, ms, lph = 36, name = "main", source = "engine-sensor") {
  m.ingest(
    `propulsion.${name}.fuel.rate`,
    lph / 3600000,
    source,
    new Date(wall + ms).toISOString(),
    ms,
    wall + ms,
  );
  return m.state.engines.find((e) => e.name === name);
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`);
test("integrates preceding rate once across changing samples, duplicate updates and timer ticks", () => {
  const m = new Model();
  const e = sample(m, 0);
  m.tick(1000);
  sample(m, 1000, 72);
  sample(m, 1000, 72);
  m.tick(2000);
  near(e.totalL, 0.03);
});
test("timeout caps integration; reconnect never fills a missing interval", () => {
  const m = new Model();
  const e = sample(m, 0);
  m.tick(60000);
  near(e.totalL, 0.1);
  assert.equal(e.gaps, 1);
  sample(m, 60000);
  m.tick(61000);
  near(e.totalL, 0.11);
});
test("invalid, negative, future, old and duplicate data do not refresh flow", () => {
  for (const value of [null, NaN, Infinity, -1]) {
    const m = new Model();
    assert.doesNotThrow(() =>
      m.ingest(
        "propulsion.main.fuel.rate",
        value,
        "s",
        new Date(wall).toISOString(),
        0,
        wall,
      ),
    );
    assert.equal(m.state.engines.length, 0);
  }
  const m = new Model();
  const e = sample(m, 0);
  m.ingest(
    e.path,
    0.1,
    "engine-sensor",
    new Date(wall + 999999).toISOString(),
    500,
    wall + 500,
  );
  m.tick(60000);
  near(e.totalL, 0.005);
});
test("multiple sources pin one input and multiple engines remain independent", () => {
  const m = new Model();
  const e = sample(m, 0, 36, "0");
  sample(m, 0, 72, "1");
  sample(m, 500, 360, "0", "duplicate-gateway");
  m.tick(1000);
  near(e.totalL, 0.01);
  near(m.state.engines[1].totalL, 0.02);
  assert.equal(m.snapshot(1000).engines[0].sources.length, 2);
});
test("main and numeric zero conflict until aliases are explicitly resolved", () => {
  const m = new Model();
  sample(m, 0, 36, "main");
  sample(m, 0, 36, "0");
  m.tick(1000);
  assert.equal(m.snapshot(1000).engines[0].status, "instance conflict");
  near(m.state.engines[0].totalL, 0);
  const n = new Model(m.state, {
    mappings: [
      {
        path: "propulsion.0.fuel.rate",
        instance: 0,
        enabled: false,
        source: "",
      },
    ],
  });
  sample(n, 2000);
  n.tick(3000);
  near(n.state.engines[0].totalL, 0.01);
});
test("trip and seasonal resets preserve each other and tank inventory", () => {
  const m = new Model();
  const e = sample(m, 0);
  m.tank({ id: "main", name: "Main", capacityL: 100, reserveL: 10 });
  m.refuel("main", "full");
  m.mapTank(e.id, "main", 0);
  m.reset(e.id, "trip", 1000);
  near(e.totalL, 0.01);
  near(m.state.tanks[0].remainingL, 99.99);
  sample(m, 1000);
  m.reset(e.id, "season", 2000);
  near(e.totalL - e.tripBaseL, 0.01);
  near(e.totalL - e.seasonBaseL, 0);
});
test("partial refill, initial quantity and full tank are distinct", () => {
  const m = new Model();
  m.tank({ id: "x", name: "X", capacityL: 100, reserveL: 10 });
  assert.throws(() => m.refuel("x", "add", 10));
  m.refuel("x", "set", 20);
  m.refuel("x", "add", 30);
  assert.equal(m.state.tanks[0].remainingL, 50);
  assert.throws(() => m.refuel("x", "add", 60));
  m.refuel("x", "full");
  assert.equal(m.state.tanks[0].remainingL, 100);
  assert.throws(() =>
    m.tank({ id: "x", name: "X", capacityL: 90, reserveL: 10 }),
  );
});
test("tank switching settles prior consumption against prior tank", () => {
  const m = new Model();
  const e = sample(m, 0);
  for (const id of ["a", "b"]) {
    m.tank({ id, name: id, capacityL: 10, reserveL: 0 });
    m.refuel(id, "full");
  }
  m.mapTank(e.id, "a", 0);
  m.mapTank(e.id, "b", 1000);
  m.tick(2000);
  near(m.state.tanks[0].remainingL, 9.99);
  near(m.state.tanks[1].remainingL, 9.99);
});
test("reboot restores totals but no live rate or offline integration", () => {
  const m = new Model();
  sample(m, 0);
  m.tick(1000);
  const n = new Model(JSON.parse(JSON.stringify(m.state)));
  n.tick(9999999);
  near(n.state.engines[0].totalL, 0.01);
  assert.equal(n.snapshot(0).engines[0].status, "waiting");
});
test("legacy import uses m3, runs only once and does not treat lifetime as trip", () => {
  const m = new Model();
  m.migrate({ "propulsion.main.fuel.used": 0.1 });
  assert.equal(m.state.engines[0].totalL, 100);
  assert.equal(m.state.engines[0].tripBaseL, 100);
  m.migrate({ "propulsion.main.fuel.used": 3 });
  assert.equal(m.state.engines[0].totalL, 100);
  sample(m, 0);
  m.tick(1000);
  near(m.state.engines[0].totalL, 100.01);
});
test("configuration rejects invalid and duplicate mappings", () => {
  assert.throws(() => config({ timeoutSeconds: 0 }));
  assert.throws(() =>
    config({
      mappings: [
        {
          path: "propulsion.0.fuel.rate",
          source: "a",
          instance: 0,
          enabled: true,
        },
        {
          path: "propulsion.1.fuel.rate",
          source: "b",
          instance: 0,
          enabled: true,
        },
      ],
    }),
  );
  const s = freshState();
  s.engines = [{}];
  assert.throws(() => validateState(s));
});
