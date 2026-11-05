#!/usr/bin/env node
// One-step setup: fetches the pre-event foundation at its pinned commit, lays it into this checkout, installs
// dependencies and creates .env. Safe to run again. It reads foundation.json; see the README for what that holds.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const skipInstall = process.argv.includes("--no-install");

// npm is a .cmd script on Windows, which needs a shell; the arguments here are all fixed strings.
const launch = (command, args) => (windows && command === "npm" ? [[command, ...args].join(" "), []] : [command, args]);

function run(command, args, options = {}) {
  const [program, rest] = launch(command, args);
  const result = spawnSync(program, rest, { cwd: root, stdio: "inherit", shell: windows && command === "npm", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ""}`);
  }
  return result;
}

function capture(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

function requireTool(command, hint) {
  const [program, rest] = launch(command, ["--version"]);
  const result = spawnSync(program, rest, { stdio: "ignore", shell: windows && command === "npm" });
  if (result.error || result.status !== 0) throw new Error(`${command} was not found. ${hint}`);
}

function fetchFoundation() {
  const pinFile = join(root, "foundation.json");
  if (!existsSync(pinFile)) {
    console.log("No foundation.json here, so there is nothing to fetch.");
    return;
  }
  const pin = JSON.parse(readFileSync(pinFile, "utf8"));
  const source = process.env.Y_FOUNDATION_URL || pin.repository;
  console.log(`Fetching the pre-event foundation: ${pin.repository} at ${pin.commit.slice(0, 12)}`);
  const work = mkdtempSync(join(tmpdir(), "y-foundation-"));
  try {
    capture(["init", "-q"], work);
    capture(["config", "core.autocrlf", "false"], work);
    capture(["fetch", "-q", "--depth", "1", source, `refs/tags/${pin.tag}`], work);
    const fetched = capture(["rev-parse", "FETCH_HEAD"], work).trim();
    if (fetched !== pin.commit) throw new Error(`the foundation is at ${fetched}, but foundation.json pins ${pin.commit}`);
    capture(["checkout", "-q", "FETCH_HEAD"], work);
    const files = capture(["ls-tree", "-r", "--name-only", "FETCH_HEAD"], work).split("\n").filter(Boolean);
    const tracked = new Set(capture(["ls-files"], root).split("\n").filter(Boolean));
    const clash = files.filter((file) => tracked.has(file));
    if (clash.length) throw new Error(`the foundation would replace files this repository owns: ${clash.slice(0, 5).join(", ")}`);
    for (const file of files) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(work, file), target);
    }
    console.log(`Laid in ${files.length} foundation files. They show as untracked in git status; that is expected.`);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function main() {
  requireTool("git", "Install git: https://git-scm.com/downloads");
  fetchFoundation();
  if (!existsSync(join(root, ".env"))) {
    copyFileSync(join(root, ".env.example"), join(root, ".env"));
    console.log("Created .env from .env.example.");
  }
  if (!skipInstall) {
    requireTool("uv", "Install uv: https://docs.astral.sh/uv/getting-started/installation/");
    requireTool("npm", "Install Node 20 or newer: https://nodejs.org/");
    console.log("Installing the API (uv fetches a supported Python if you need one).");
    run("uv", ["sync"], { cwd: join(root, "api") });
    console.log("Installing the web app.");
    run("npm", ["--prefix", "web", "ci", "--legacy-peer-deps"]);
  }
  console.log("\nDone. Put your two keys in .env, then run these in two terminals:\n  npm run api\n  npm run dev\nOpen http://localhost:3000/app");
}

try {
  main();
} catch (error) {
  console.error(`\nSetup stopped: ${error.message}`);
  process.exit(1);
}
