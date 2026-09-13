"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../lib/store");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("alternating durable checkpoints recover last good slot after torn write", (t) => {
  const dir = fixture(t),
    store = new Store(dir),
    s = store.load();
  s.revision = 1;
  store.save(s);
  s.revision = 2;
  store.save(s);
  assert.equal(new Store(dir).load().revision, 2);
  fs.writeFileSync(path.join(dir, "state-1.json"), "truncated");
  const recovered = new Store(dir);
  assert.equal(recovered.load().revision, 1);
  assert.ok(recovered.warning);
});
test("both corrupt slots fail closed instead of zeroing totals", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "state-0.json"), "bad");
  fs.writeFileSync(path.join(dir, "state-1.json"), "bad");
  assert.throws(() => new Store(dir).load(), /refusing/);
});
test("changed checksum is rejected and leftover tmp is ignored", (t) => {
  const dir = fixture(t),
    store = new Store(dir),
    s = store.load();
  store.save(s);
  const file = path.join(dir, "state-0.json"),
    doc = JSON.parse(fs.readFileSync(file));
  doc.data.revision = 999;
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.writeFileSync(path.join(dir, "state-1.json.tmp"), "{}");
  assert.throws(() => new Store(dir).load());
});
