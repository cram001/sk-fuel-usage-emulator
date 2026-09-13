require("esbuild").buildSync({
  entryPoints: ["test/host.jsx"],
  bundle: true,
  outfile: "test/host-build.js",
  format: "iife",
  define: { "process.env.NODE_ENV": '\"production\"' },
});
