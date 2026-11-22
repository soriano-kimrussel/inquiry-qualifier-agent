import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { BusinessConfigSchema, type BusinessConfig } from "./types.js";

const cache = new Map<string, BusinessConfig>();

export function listBusinessIds(): string[] {
  return readdirSync(paths.configDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadBusinessConfig(id: string): BusinessConfig {
  const cached = cache.get(id);
  if (cached) return cached;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid business id "${id}"`);
  const file = path.join(paths.configDir(), `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`No config for business "${id}". Available: ${listBusinessIds().join(", ")}`);
  }
  const config = BusinessConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (config.id !== id) throw new Error(`config/${id}.json has mismatched id "${config.id}"`);
  cache.set(id, config);
  return config;
}
