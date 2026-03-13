#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {
    sha: process.env.GITHUB_SHA || 'HEAD',
    branch: process.env.PROD_BRANCH || 'main',
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--sha') {
      args.sha = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--branch') {
      args.branch = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.sha) {
    throw new Error('Missing --sha value');
  }
  if (!args.branch) {
    throw new Error('Missing --branch value');
  }
  return args;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function toUtcDateParts(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid commit date: ${isoString}`);
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return { year, month, day };
}

function main() {
  const args = parseArgs(process.argv);
  const commitSha = git(['rev-parse', args.sha]);
  const commitIso = git(['show', '-s', '--format=%cI', commitSha]);
  const { year, month, day } = toUtcDateParts(commitIso);
  const dayStart = `${year}-${month}-${day}T00:00:00Z`;
  const dayEnd = `${year}-${month}-${day}T23:59:59Z`;

  const commitsText = git([
    'rev-list',
    '--first-parent',
    '--reverse',
    args.branch,
    '--since',
    dayStart,
    '--until',
    dayEnd,
  ]);
  const commits = commitsText ? commitsText.split('\n').filter(Boolean) : [];
  const sameDayIndex = commits.indexOf(commitSha);

  if (sameDayIndex < 0) {
    throw new Error(
      `Commit ${commitSha} is not on first-parent history of ${args.branch} for ${year}-${month}-${day}.`,
    );
  }

  const stamp = `${year}.${month}.${day}.${sameDayIndex}`;
  const payload = {
    stamp,
    dateUtc: `${year}-${month}-${day}`,
    sameDayIndex,
    branch: args.branch,
    sha: commitSha,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${payload.stamp}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[prod-version-stamp] ${message}\n`);
  process.exit(1);
}
