#!/usr/bin/env node
// Starts the learning API on the port the web proxy expects, on any platform. Never prints key values.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = join(root, "api", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const envFile = join(root, ".env");
const port = process.env.API_PORT || "8101";

if (!existsSync(python)) {
  console.error("The API is not installed yet. Run: npm run setup");
  process.exit(1);
}
if (!existsSync(envFile)) {
  console.error("There is no .env yet. Run: npm run setup, then put your two keys in .env");
  process.exit(1);
}
const text = readFileSync(envFile, "utf8");
for (const name of ["MODEL_API_KEY", "BASETEN_API_KEY"]) {
  const line = text.split(/\r?\n/).find((row) => row.trim().startsWith(`${name}=`));
  if (!line || !line.slice(line.indexOf("=") + 1).trim()) console.warn(`Warning: ${name} is empty in .env`);
}
const child = spawn(python, ["-m", "uvicorn", "learning.app:app", "--app-dir", "api", "--env-file", ".env", "--port", port],
  { cwd: root, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
