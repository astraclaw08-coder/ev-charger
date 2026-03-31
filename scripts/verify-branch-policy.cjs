#!/usr/bin/env node

/**
 * Enforce dev/main GitFlow PR policy in CI.
 *
 * Rules:
 * - PR base=main must come from head=dev, hotfix/*, or release/*
 * - PR base=dev must come from feature/*, fix/*, chore/*, hotfix/*, or dependabot/*
 */

const fs = require('node:fs');

function fail(message) {
  console.error(`❌ Branch policy violation: ${message}`);
  process.exit(1);
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !fs.existsSync(eventPath)) {
  fail('GITHUB_EVENT_PATH is missing or unreadable.');
}

const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const pr = payload.pull_request;
if (!pr) {
  console.log('No pull_request payload found; skipping branch policy check.');
  process.exit(0);
}

const base = pr.base?.ref;
const head = pr.head?.ref;

if (!base || !head) {
  fail(`Missing base/head refs (base=${base}, head=${head}).`);
}

const allowedForMain = [/^dev$/, /^hotfix\/.+/, /^release\/.+/];
const allowedForDev = [/^feature\/.+/, /^fix\/.+/, /^chore\/.+/, /^hotfix\/.+/, /^dependabot\/.+/];

if (base === 'main') {
  if (!allowedForMain.some((re) => re.test(head))) {
    fail(`PRs into main must come from dev or hotfix/* (got ${head} -> ${base}).`);
  }
} else if (base === 'dev') {
  if (!allowedForDev.some((re) => re.test(head))) {
    fail(`PRs into dev must come from feature/*, fix/*, chore/*, hotfix/*, or dependabot/* (got ${head} -> ${base}).`);
  }
} else {
  console.log(`Base branch ${base} is outside protected set (dev/main); no policy applied.`);
  process.exit(0);
}

if (base === head) {
  fail(`Source and target branches must differ (${head} -> ${base}).`);
}

console.log(`✅ Branch policy check passed (${head} -> ${base}).`);
