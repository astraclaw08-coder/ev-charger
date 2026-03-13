#!/usr/bin/env bash
set -euo pipefail

# Harden branch protections for dev/main according to project GitFlow policy.
# Requires: gh CLI authenticated with repo admin permissions.
# Usage: scripts/harden-branch-protections.sh [owner/repo]

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

if [[ -z "$REPO" ]]; then
  echo "Unable to resolve repository. Pass owner/repo explicitly." >&2
  exit 1
fi

echo "Applying hardened branch protections to $REPO"

apply_protection() {
  local branch="$1"

  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/branches/$branch/protection" \
    --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "required-checks-always-report",
      "branch-policy-guard",
      "Build + validate with env-scoped DATABASE_URL"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": true,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON

  echo "✅ $branch protection updated"
}

apply_protection "dev"
apply_protection "main"

echo "Done. Verify in GitHub Settings > Branches."
