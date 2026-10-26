#!/usr/bin/env bash
# Local Android release build: arm64-v8a APK signed with the Hikaro release key.
# Pure build: no commit, push or publish. Output: artifacts/release/android/hikaro-release.apk
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SIGNING_DIR="${HIKARO_SIGNING_DIR:-$HOME/.local/share/hikaro-signing}"
BUILD_TOOLS="${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools/36.0.0"
APKSIGNER="$BUILD_TOOLS/apksigner"
ZIPALIGN="$BUILD_TOOLS/zipalign"
# The release certificate is fixed: a different key cannot update installed copies.
EXPECTED_CERT=9ee74690825efe6ecae984713cb87c0bc4d4b853953f5718a024f6e1ac417dd1
for file in release.p12 release-password.txt; do
  if [[ ! -s "$SIGNING_DIR/$file" ]]; then
    echo "Missing release signing file: $SIGNING_DIR/$file (never falls back to debug signing)." >&2
    exit 1
  fi
done
if [[ ! -x "$APKSIGNER" || ! -x "$ZIPALIGN" ]]; then
  echo "Android build-tools 36.0.0 (apksigner, zipalign) required." >&2
  exit 1
fi
cd "$REPO_DIR/apps/mobile"
pnpm exec expo prebuild --platform android --no-install
(
  cd android
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
)
OUT_DIR="$REPO_DIR/artifacts/release/android"
mkdir -p "$OUT_DIR"
OUTPUT="$OUT_DIR/hikaro-release.apk"
ALIGNED="$(mktemp "$OUT_DIR/aligned.XXXXXX")"
SIGNED="$(mktemp "$OUT_DIR/signed.XXXXXX")"
trap 'rm -f "$ALIGNED" "$SIGNED"' EXIT
"$ZIPALIGN" -f -P 16 4 android/app/build/outputs/apk/release/app-release.apk "$ALIGNED"
"$APKSIGNER" sign --ks "$SIGNING_DIR/release.p12" --ks-key-alias hikaro-release \
  --ks-pass "file:$SIGNING_DIR/release-password.txt" \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --v4-signing-enabled false --out "$SIGNED" "$ALIGNED"
CERTS="$("$APKSIGNER" verify --print-certs "$SIGNED")"
if ! printf '%s\n' "$CERTS" | grep -Fq "certificate SHA-256 digest: $EXPECTED_CERT"; then
  echo "APK is not signed with the Hikaro release certificate." >&2
  exit 1
fi
"$ZIPALIGN" -c -P 16 4 "$SIGNED"
mv "$SIGNED" "$OUTPUT"
shasum -a 256 "$OUTPUT"
ls -l "$OUTPUT"
