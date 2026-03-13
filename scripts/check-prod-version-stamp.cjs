#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {
    sha: process.env.GITHUB_SHA || 'HEAD',
    branch: process.env.PROD_BRANCH || 'main',
    portalVersion: process.env.VITE_APP_VERSION || '',
    mobileVersion: process.env.EXPO_PUBLIC_APP_VERSION || '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
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
    if (token === '--portal-version') {
      args.portalVersion = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--mobile-version') {
      args.mobileVersion = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function expectedStamp(sha, branch) {
  const output = execFileSync(
    process.execPath,
    ['scripts/prod-version-stamp.cjs', '--sha', sha, '--branch', branch, '--json'],
    { encoding: 'utf8' },
  ).trim();
  return JSON.parse(output);
}

function main() {
  const args = parseArgs(process.argv);
  const expected = expectedStamp(args.sha, args.branch);
  const mismatches = [];

  if (!args.portalVersion) {
    mismatches.push('portal version is empty');
  } else if (args.portalVersion !== expected.stamp) {
    mismatches.push(`portal version mismatch (got=${args.portalVersion}, expected=${expected.stamp})`);
  }

  if (!args.mobileVersion) {
    mismatches.push('mobile version is empty');
  } else if (args.mobileVersion !== expected.stamp) {
    mismatches.push(`mobile version mismatch (got=${args.mobileVersion}, expected=${expected.stamp})`);
  }

  if (args.portalVersion && args.mobileVersion && args.portalVersion !== args.mobileVersion) {
    mismatches.push(`portal/mobile version mismatch (${args.portalVersion} != ${args.mobileVersion})`);
  }

  if (mismatches.length > 0) {
    throw new Error(mismatches.join('; '));
  }

  process.stdout.write(
    `[prod-version-check] OK stamp=${expected.stamp} sha=${expected.sha} date=${expected.dateUtc} index=${expected.sameDayIndex}\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[prod-version-check] ${message}\n`);
  process.exit(1);
}
