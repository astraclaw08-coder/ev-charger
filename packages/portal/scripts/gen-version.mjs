#!/usr/bin/env node
// Generates yyyy.mm.dd.N version string for Vite/Vercel builds.
// N = count of git commits on this branch today (UTC).
import { execSync } from "child_process";

const today = new Date();
const yyyy = today.getUTCFullYear();
const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
const dd = String(today.getUTCDate()).padStart(2, "0");

let patch = 0;
try {
  const since = `${yyyy}-${mm}-${dd}T00:00:00Z`;
  const out = execSync(`git log --oneline --after="${since}" 2>/dev/null | wc -l`, { encoding: "utf8" }).trim();
  patch = parseInt(out, 10) || 0;
} catch {
  patch = 0;
}

const version = `${yyyy}.${mm}.${dd}.${patch}`;
process.stdout.write(version);
