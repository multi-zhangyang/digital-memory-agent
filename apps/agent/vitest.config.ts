import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration suites each run durable SQLite writers and local HTTP services.
  // Unbounded worker counts contend for fsync and turn recovery checks into timeout tests.
  test: { maxWorkers: 1, testTimeout: 15000 },
});
