const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8000",
    headless: true,
    channel: "chrome",
  },
  webServer: {
    command: "python3 -m http.server 8000",
    url: "http://127.0.0.1:8000/game/index.html",
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
