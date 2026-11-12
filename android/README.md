# Galería para Android

Envoltorio nativo (WebView) de la galería web que vive en la raíz del repositorio.
Los archivos web (`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js`)
no se duplican: Gradle los sincroniza a `app/build/generated/webAssets/www` antes de cada build.

## Compilar

Requisitos: JDK 17+ y Android SDK (plataforma 35, build-tools 35.0.0).

```sh
cd android
echo "sdk.dir=/ruta/al/android-sdk" > local.properties   # o: export ANDROID_HOME=/ruta/al/android-sdk
./gradlew assembleDebug     # APK de depuración
./gradlew assembleRelease   # APK firmado
```

## Dónde está el APK

- Depuración: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release firmado: `android/app/build/outputs/apk/release/app-release.apk`
- Copia lista para instalar: `dist/Galeria.apk`

## Firma

`keystore/galeria-release.jks` (contraseñas en `keystore.properties`) es una clave de
**demostración** y se incluye en el repositorio a propósito. No la uses para publicar en tiendas;
genera tu propia clave y no la subas al repositorio.
