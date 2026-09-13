module.exports = {
  testDir: "./test",
  testMatch: "ui.spec.cjs",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3107", headless: true },
  webServer: {
    command: "node test/ui-server.cjs",
    url: "http://127.0.0.1:3107/fuel-usage-calculator/",
    reuseExistingServer: false,
  },
};
