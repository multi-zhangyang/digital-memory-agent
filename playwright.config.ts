import { defineConfig, devices } from "@playwright/test";

const env = {
  AGENT_PORT: "4311",
  AGENT_ORIGIN: "http://127.0.0.1:4311",
  MEMORY_ALLOWED_ORIGINS: "http://127.0.0.1:3001,http://localhost:3001",
  MEMORY_DATA_DIR: ".data/e2e-" + Date.now(),
  MEMORY_OPENAI_API_KEY: "",
  MEMORY_OPENAI_MODEL: "",
  MEMORY_ANTHROPIC_API_KEY: "",
  MEMORY_ANTHROPIC_MODEL: "",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node tests/e2e/provider.mjs",
      url: "http://127.0.0.1:4312/health",
      reuseExistingServer: false,
      timeout: 30000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
    {
      command: "node --import tsx src/main.ts",
      cwd: "apps/agent",
      url: "http://127.0.0.1:4311/api/health",
      env,
      reuseExistingServer: false,
      timeout: 30000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
    {
      command: `node node_modules/next/dist/bin/next ${process.env.E2E_PRODUCTION ? "start" : "dev"} --hostname 127.0.0.1 --port 3001`,
      cwd: "apps/web",
      url: "http://127.0.0.1:3001/api/health",
      env,
      reuseExistingServer: false,
      timeout: 120000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
  ],
});
