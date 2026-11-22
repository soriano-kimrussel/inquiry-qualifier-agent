// load .env for entry points, shell vars win
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
