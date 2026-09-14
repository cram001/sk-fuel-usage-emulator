const express = require("express"),
  { EventEmitter } = require("node:events"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const app = new EventEmitter(),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdm-ui-"));
let delta;
Object.assign(app, {
  getDataDirPath: () => dir,
  getSelfPath: () => undefined,
  error: console.error,
  setPluginStatus: () => {},
  handleMessage: () => {},
  savePluginOptions: (c, done) => done(),
  subscriptionmanager: {
    subscribe: (s, u, e, fn) => {
      delta = fn;
      u.push(() => {
        delta = null;
      });
    },
  },
});
const plugin = require("..")(app),
  http = express(),
  router = express.Router();
http.use(express.json({ limit: "1mb" }));
plugin.registerWithRouter(router);
http.use("/plugins/sk-fuel-usage-mgr-emulator", router);
http.use(
  "/sk-fuel-usage-mgr-emulator",
  express.static(path.join(__dirname, "../public")),
);
http.get("/admin/test-host", (_req, res) =>
  res.send(
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/test-host.js"></script></body></html>',
  ),
);
http.get("/test-host.js", (_req, res) =>
  res.sendFile(path.join(__dirname, "host-build.js")),
);
plugin.start();
setInterval(
  () =>
    delta?.({
      updates: [
        {
          timestamp: new Date().toISOString(),
          $source: "yanmar-sensor",
          values: [{ path: "propulsion.main.fuel.rate", value: 0 }],
        },
      ],
    }),
  500,
).unref();
http.listen(3107, "127.0.0.1");
process.on("SIGTERM", () => {
  plugin.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit();
});
