import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// functions so tests can swap dirs
const outRoot = () => path.resolve(process.env.OUT_DIR ?? path.join(ROOT, "out"));

export const paths = {
  configDir: () => path.join(ROOT, "config"),
  inquiriesDir: () => path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data", "inquiries")),
  evalCases: () => path.join(ROOT, "evals", "cases.json"),
  evalResultsDir: () => path.resolve(process.env.EVAL_OUT_DIR ?? path.join(ROOT, "evals", "results")),
  pending: () => path.join(outRoot(), "pending"),
  approved: () => path.join(outRoot(), "approved"),
  rejected: () => path.join(outRoot(), "rejected"),
  integrations: (name: "ghl" | "calendar" | "email") => path.join(outRoot(), "integrations", name),
};
