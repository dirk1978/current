#!/bin/sh
# Builds current.apk. Needs only Docker: the Android SDK runs in a container (android/Dockerfile).
# No Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
#
#   ./build.sh            personal build: your server's addresses and access key built in (from ../.env)
#   ./build.sh --generic  the published app: asks for a server on first run (or scan the Connect phone QR code)
#
# Settings (from ../.env, or the environment, which wins):
#   ACCESS_TOKEN               baked into a personal build so it can talk to your server
#   PUBLIC_URL                 your server's internet address, e.g. https://current.example.com
#   LAN_URL                    optional fallback on your home network, e.g. http://192.168.1.20:8092
#   APP_ID                     Android application id (default uk.dirk1978.current)
#   ANDROID_KEYSTORE_PASSWORD  signing key password; generated and saved to .env the first time
#   KEYSTORE_FILE              signing key (default android/release.keystore, created if missing)
#   ANDROID_BUILD_IMAGE        Docker image with the SDK (default current-android-build, built from Dockerfile)
#   VERSION                    version name shown in Android (default dev); the version code is the build time
# Keep the keystore and its password: updates only install over an app signed with the same key.
set -e
cd "$(dirname "$0")"
GENERIC=; [ "${1:-}" = "--generic" ] && GENERIC=1
ENV=../.env
[ -n "$GENERIC" ] && ENV=/dev/null/none   # the published app takes nothing from your .env
[ -f "$ENV" ] || [ -n "$GENERIC" ] || { echo "No .env found. Run ./setup.sh first, or build the generic app with --generic."; exit 1; }
# environment first, then .env
get() { eval "v=\${$1:-}"; [ -n "$v" ] && { echo "$v"; return; }; [ -f "$ENV" ] && sed -n "s/^$1=//p" "$ENV" | tail -1 | sed "s/^['\"]\(.*\)['\"]\$/\1/"; true; }

APP_ID=$(get APP_ID); APP_ID=${APP_ID:-uk.dirk1978.current}
IMAGE=$(get ANDROID_BUILD_IMAGE); IMAGE=${IMAGE:-current-android-build}
KEYSTORE=$(get KEYSTORE_FILE); KEYSTORE=${KEYSTORE:-release.keystore}
PASS=$(get ANDROID_KEYSTORE_PASSWORD)
VERSION=$(get VERSION); VERSION=${VERSION:-dev}
CODE=$(( ($(date +%s) - 1704067200) / 60 ))   # minutes since 2024: always increases, fits Android's limit
if [ -n "$GENERIC" ]; then
  KEY=; PUBLIC_URL=; LAN_URL=
else
  KEY=$(get ACCESS_TOKEN); PUBLIC_URL=$(get PUBLIC_URL); LAN_URL=$(get LAN_URL)
  [ -n "$KEY" ] || { echo "ACCESS_TOKEN missing from .env"; exit 1; }
  [ -n "$PUBLIC_URL$LAN_URL" ] || { echo "Set PUBLIC_URL and/or LAN_URL in .env so the app knows where your server is"; exit 1; }
fi
if [ -z "$PASS" ]; then
  [ -f "$KEYSTORE" ] && { echo "$KEYSTORE exists but ANDROID_KEYSTORE_PASSWORD is not set"; exit 1; }
  PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  [ -f "$ENV" ] && printf '\nANDROID_KEYSTORE_PASSWORD=%s\n' "$PASS" >> "$ENV" && echo "Generated a signing key password and saved it to .env"
fi

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
if ! $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building the Android SDK image $IMAGE (first time only, takes a few minutes)..."
  $DOCKER build -t "$IMAGE" .
fi

# Server list: internet first, then the LAN address
BASES=""
for u in $PUBLIC_URL $LAN_URL; do BASES="$BASES${BASES:+, }\"${u%/}\""; done

rm -rf build && mkdir -p build/assets build/gen/uk/dirk1978/current build/res-src
cp -r app/assets/. build/assets/
cp -r ../web build/assets/web
printf 'window.CURRENT_CONFIG = { bases: [%s], key: "%s" };\n' "$BASES" "$KEY" > build/assets/web/config.js
cat > build/gen/uk/dirk1978/current/Config.java <<JAVA
package uk.dirk1978.current;
final class Config {
    static final String[] BASES = { $BASES };
    static final String KEY = "$KEY";
}
JAVA

# Cleartext HTTP: only the http:// addresses above, or (generic build) any server the user points it at
cp -r app/res/. build/res-src/
mkdir -p build/res-src/xml
{
  echo '<?xml version="1.0" encoding="utf-8"?>'
  echo '<network-security-config>'
  [ -n "$GENERIC" ] && echo '    <base-config cleartextTrafficPermitted="true" />'
  for u in $PUBLIC_URL $LAN_URL; do
    case "$u" in http://*)
      host=$(echo "$u" | sed 's|^http://||; s|[:/].*$||')
      echo "    <domain-config cleartextTrafficPermitted=\"true\"><domain includeSubdomains=\"false\">$host</domain></domain-config>";;
    esac
  done
  echo '</network-security-config>'
} > build/res-src/xml/network.xml

KS_DIR=$(cd "$(dirname "$KEYSTORE")" && pwd); KS_NAME=$(basename "$KEYSTORE")
$DOCKER run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e APP_ID="$APP_ID" -e PASS="$PASS" -e KS="/ks/$KS_NAME" \
  -e VERSION="$VERSION" -e CODE="$CODE" -v "$PWD":/w -v "$KS_DIR":/ks -w /w "$IMAGE" sh -euc '
  JAR=/opt/android/platforms/android-34/android.jar
  mkdir -p build/res build/classes build/dex
  aapt2 compile --dir build/res-src -o build/res/res.zip
  aapt2 link -o build/unsigned.apk -I $JAR --manifest app/AndroidManifest.xml -A build/assets \
        --rename-manifest-package "$APP_ID" --version-name "$VERSION" --version-code "$CODE" --replace-version --custom-package uk.dirk1978.current --java build/gen build/res/res.zip
  javac --release 8 -Xlint:-options -nowarn -classpath $JAR -d build/classes $(find app/src build/gen -name "*.java")
  d8 --release --min-api 28 --lib $JAR --output build/dex $(find build/classes -name "*.class")
  (cd build/dex && zip -q ../unsigned.apk classes.dex)
  zipalign -f -p 4 build/unsigned.apk build/aligned.apk
  [ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" \
        -alias current -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Current" 2>/dev/null
  apksigner sign --ks "$KS" --ks-pass "pass:$PASS" --out current.apk build/aligned.apk
  apksigner verify current.apk
'
echo "Built android/current.apk ($APP_ID $VERSION${GENERIC:+, generic}). Copy it to your phone and open it to install."
