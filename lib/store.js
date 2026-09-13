"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { validateState, freshState } = require("./model");
const digest = (data) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
// Synchronous, small checkpoints serialize mutations with durable commits on the event loop.
// Dual independently valid slots retain the previous successful revision after torn writes.
class Store {
  constructor(directory) {
    this.directory = directory;
    this.lastSave = null;
    this.warning = null;
    this.slot = 0;
  }
  load() {
    fs.mkdirSync(this.directory, { recursive: true });
    const valid = [];
    let present = 0;
    for (let i = 0; i < 2; i++) {
      const file = path.join(this.directory, `state-${i}.json`);
      try {
        const text = fs.readFileSync(file, "utf8");
        present++;
        const envelope = JSON.parse(text);
        if (envelope.checksum !== digest(envelope.data))
          throw new Error("Checksum mismatch");
        valid.push({ slot: i, data: validateState(envelope.data) });
      } catch (error) {
        if (error.code !== "ENOENT") {
          if (!present) present++;
          this.warning = "Recovered state slot unavailable: " + error.message;
        }
      }
    }
    if (!valid.length && present)
      throw new Error(
        "Both fuel checkpoints are unreadable. Restore a backup; refusing to reset fuel totals.",
      );
    valid.sort((a, b) => b.data.revision - a.data.revision);
    if (valid.length) {
      this.slot = 1 - valid[0].slot;
      return valid[0].data;
    }
    return freshState();
  }
  save(state) {
    validateState(state);
    const target = path.join(this.directory, `state-${this.slot}.json`),
      tmp = target + ".tmp";
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ checksum: digest(state), data: state }),
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    const dir = fs.openSync(this.directory, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
    this.slot = 1 - this.slot;
    this.lastSave = new Date().toISOString();
  }
}
module.exports = { Store };
