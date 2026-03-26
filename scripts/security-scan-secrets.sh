#!/usr/bin/env bash
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not found. Install with: brew install gitleaks"
  exit 2
fi

# Scan tracked history + working tree (staged/unstaged)
gitleaks git --redact --verbose --config .gitleaks.toml

echo "✅ gitleaks scan passed"
