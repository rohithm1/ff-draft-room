const { defineConfig } = require("@playwright/test");

/* Served over HTTP rather than file:// so the test environment matches how you
   actually run it (npm start) and so localStorage behaves normally. */
const PORT = 8777;
module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [["list"]],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ${__dirname}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20000
  },
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
