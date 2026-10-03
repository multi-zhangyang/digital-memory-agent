import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Only the service address is needed by Next; provider secrets stay in the Agent.
const rootEnv = resolve(process.cwd(), "../../.env");
if (!process.env.AGENT_ORIGIN && existsSync(rootEnv)) {
  const agentOrigin = parseEnv(readFileSync(rootEnv, "utf8")).AGENT_ORIGIN;
  if (agentOrigin) process.env.AGENT_ORIGIN = agentOrigin;
}

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@memory/contracts"],
};

export default config;
