#!/usr/bin/env bash
# Decide whether a desktop build is Developer ID signed and notarized (Phase 3b).
# All six Apple secrets set: signed=true. None: signed=false (ad-hoc build).
# Anything in between is a misconfiguration and fails the job.
set -euo pipefail
NAMES=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8)
set_count=0
missing=()
for n in "${NAMES[@]}"; do
  if [ -n "${!n:-}" ]; then set_count=$((set_count + 1)); else missing+=("$n"); fi
done
if [ "$set_count" -eq 0 ]; then
  echo "No Apple signing secrets: building ad-hoc signed, not notarized."
  signed=false
elif [ "$set_count" -eq "${#NAMES[@]}" ]; then
  if ! [[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "::error::APPLE_TEAM_ID should be the 10-character Team ID from developer.apple.com/account."
    exit 1
  fi
  echo "Apple signing secrets present: Developer ID signing and notarization."
  signed=true
else
  echo "::error::Apple signing is partly configured. Missing secrets: ${missing[*]} (see desktop/README.md)."
  exit 1
fi
echo "signed=$signed" >> "${GITHUB_OUTPUT:-/dev/null}"
