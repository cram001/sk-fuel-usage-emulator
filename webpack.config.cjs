const path = require("node:path");
const { container } = require("webpack");
module.exports = {
  entry: {},
  mode: "production",
  output: {
    path: path.resolve(__dirname, "public"),
    filename: "[name].js",
    chunkFilename: "[name].js",
    clean: true,
  },
  resolve: { extensions: [".jsx", ".js"] },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        loader: "esbuild-loader",
        options: { loader: "jsx", target: "es2022" },
      },
      { test: /\.css$/, type: "asset/source" },
    ],
  },
  plugins: [
    new container.ModuleFederationPlugin({
      name: "sk_fuel_usage_mgr_emulator",
      library: { type: "var", name: "sk_fuel_usage_mgr_emulator" },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel": "./src/Federated.jsx",
        "./AppPanel": "./src/Federated.jsx",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19", import: false },
        "react-dom": { singleton: true, requiredVersion: "^19", import: false },
      },
    }),
  ],
};
