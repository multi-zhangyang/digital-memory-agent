import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = buildApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(
    "Memory Agent ready at http://" + config.host + ":" + config.port,
  );
} catch {
  console.error("Agent 服务启动失败，请检查端口与配置。");
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
