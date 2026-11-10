#!/usr/bin/env bash
# Compila o APK sem Gradle: aapt2 + javac + d8 + zipalign + apksigner.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
OUT=build
KEYSTORE="${PET_KEYSTORE:-$HOME/.android/pet-debug.keystore}"

rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/gen"

"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLATFORM" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34 --java "$OUT/gen"
javac -source 17 -target 17 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --lib "$PLATFORM" --min-api 26 --output "$OUT" $(find "$OUT/classes" -name '*.class')

cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q -j unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias pet -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android -dname "CN=pet-debug"
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --out "$OUT/pet.apk" "$OUT/aligned.apk"
echo "APK: $(pwd)/$OUT/pet.apk"
