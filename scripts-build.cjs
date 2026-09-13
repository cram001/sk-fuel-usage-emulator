const fs = require("node:fs");
require("esbuild").buildSync({
  entryPoints: ["src/standalone.jsx"],
  bundle: true,
  minify: true,
  outfile: "public/app.js",
  loader: { ".jsx": "jsx" },
  target: "es2022",
});
fs.writeFileSync(
  "public/index.html",
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fuel Data Manager</title><link rel="stylesheet" href="app.css"></head><body class="fdm-standalone"><div id="root"></div><script src="app.js"></script></body></html>',
);
