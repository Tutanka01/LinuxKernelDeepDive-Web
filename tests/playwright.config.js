/* Tier 2: the browser smoke test.

   The site is served exactly the way a reader gets it — `python3 -m http.server`
   over the repository root, no build, no bundler — on an ephemeral port so a
   run never collides with a dev server the author already has up. */

"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { defineConfig, devices } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");

/* Ask the OS for a free port. Playwright's `webServer` needs the port in the
   config, before any hook runs, so this has to be synchronous. */
function freePort() {
  if (process.env.SITE_PORT) return Number(process.env.SITE_PORT);
  const out = execFileSync(process.execPath, ["-e", `
    const net = require("net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });
  `], { encoding: "utf8" });
  return Number(out.trim());
}

const PORT = freePort();
/* Playwright re-loads this file in every worker process. Without pinning the
   choice into the environment, each worker would pick its *own* free port and
   talk to a server that is not there. */
process.env.SITE_PORT = String(PORT);

const BASE = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: "./tier2",
  testMatch: /.*\.spec\.js/,
  /* 93 chapters × three assertions each is a lot of navigations; they are
     fully independent, so run them wide. */
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: BASE,
    /* a chapter that fails is worth a screenshot; a passing one is not */
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ${JSON.stringify(ROOT)}`,
    url: BASE,
    reuseExistingServer: false,
    /* python's http.server logs every request to stderr; piping it drowns the
       test output. Set SITE_SERVER_LOG=1 when the server itself is suspect. */
    stdout: "ignore",
    stderr: process.env.SITE_SERVER_LOG ? "pipe" : "ignore",
    timeout: 30_000,
  },
});

module.exports.BASE = BASE;
