import { defineConfig, devices } from "@playwright/test";

// Smoke tests in a real browser. Reads go to the live Onyx testnet, so the
// reference apps must be deployed there.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5179", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: { command: "npx vite --port 5179 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:5179", reuseExistingServer: true },
});
