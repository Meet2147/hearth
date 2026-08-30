#!/bin/bash
#
# Set every GitHub Actions secret Hearth's release pipeline needs, in one go.
#
# Secrets are read from your environment (and the certificate from a .p12 file),
# so nothing is ever hardcoded in this file or the repo. Run it once; re-run it
# any time a value rotates.
#
# Usage:
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
#   export APPLE_TEAM_ID="C9NLF34677"
#   export MAC_CSC_KEY_PASSWORD="the .p12 export password"
#   export MAC_CERT_P12="$HOME/Desktop/Certificates.p12"       # Developer ID cert
#   ./scripts/set-ci-secrets.sh
#
# The Developer ID certificate is exported from Keychain Access:
#   login keychain -> My Certificates -> right-click
#   "Developer ID Application: <you>" -> Export -> .p12 (set a password).
set -euo pipefail

REPO="${HEARTH_REPO:-Meet2147/hearth}"

MISSING=0
need() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "  missing: \$$name  (see the header of this script)" >&2
    MISSING=1
  fi
}

need APPLE_ID
need APPLE_APP_SPECIFIC_PASSWORD
need APPLE_TEAM_ID
need MAC_CSC_KEY_PASSWORD
need MAC_CERT_P12
[ "$MISSING" = "1" ] && { echo "Set the variables above and re-run." >&2; exit 1; }
[ -f "$MAC_CERT_P12" ] || { echo "Certificate not found at: $MAC_CERT_P12" >&2; exit 1; }

echo "==> setting secrets on $REPO"
base64 -i "$MAC_CERT_P12"                  | gh secret set MAC_CSC_LINK --repo "$REPO"
printf '%s' "$MAC_CSC_KEY_PASSWORD"        | gh secret set MAC_CSC_KEY_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_ID"                    | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_TEAM_ID"               | gh secret set APPLE_TEAM_ID --repo "$REPO"

echo ""
echo "done. current secrets:"
gh secret list --repo "$REPO"
echo ""
echo "Release: git tag vX.Y.Z && git push origin vX.Y.Z  (CI signs, notarizes, publishes)"
