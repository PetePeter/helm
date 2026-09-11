# Helm for Android

The phone client for Helm. It pairs over Bluetooth LE and gives full session
control away from the desk.

> **Role:** the phone is the BLE **peripheral** — it advertises and serves the
> GATT server; Helm on Windows is the **central** and connects in. See
> [`../docs/mobile-ble-transport.md`](../docs/mobile-ble-transport.md).

## ⚠️ The release keystore must never be regenerated

An APK signed with a different key **refuses to install** over an existing one.
The only recovery is uninstall-and-repair, which loses the user's pairing.

- Generate the release keystore **once**.
- **Back it up outside this repository**, along with its passwords.
- Never commit it. `*.keystore`, `*.jks` and `android/local.properties` are
  gitignored.

Likewise `applicationId` is fixed at `com.potatomotato.helm` **forever**.
Changing it is not an update — Android installs it as a second, separate app.

```bash
keytool -genkeypair -v -keystore helm-release.jks -alias helm \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then point the build at it via `android/local.properties` (gitignored):

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
helm.keystore.file=C\:\\path\\outside\\repo\\helm-release.jks
helm.keystore.password=...
helm.key.alias=helm
helm.key.password=...
```

CI reads the same values from `HELM_KEYSTORE_FILE`, `HELM_KEYSTORE_PASSWORD`,
`HELM_KEY_ALIAS`, `HELM_KEY_PASSWORD`.

If none are set, `assembleRelease` still produces an installable APK — signed
with the **debug** key and a loud warning. That is for local work only; it must
never be published.

## Build

Requires JDK 17 and the Android SDK (platform 35). **No Node tooling.**

```bash
cd android
./gradlew assembleRelease     # -> app/build/outputs/apk/release/app-release.apk
./gradlew assembleDebug
./gradlew installDebug        # build + install onto the attached device
adb install -r app/build/outputs/apk/release/app-release.apk
```

## Versioning

`versionName` and `versionCode` are **derived from the repo's `package.json`**
at configure time and must not be hand-edited. `prepareDeploy.py` already bumps
that file on every release, so the Android version follows automatically —
Android refuses to install an APK whose `versionCode` went backwards, and a
forgotten manual bump only surfaces on a user's phone.

`versionCode = major * 10000 + minor * 100 + patch`.

## Toolchain boundary

The Node and Android toolchains never touch each other:

```mermaid
graph LR
    subgraph "Node — needs no JVM"
      A[npm run build] --> A1[vite root=renderer/]
      A --> A2[esbuild src/electron]
      B[npm test] --> B1["vitest — excludes **/android/**"]
      C[tsc] --> C1["tsconfig include src/** · exclude android"]
    end
    subgraph "Android — needs no Node"
      D["android/gradlew"] --> D1[":app — reads ../package.json as text"]
    end
```

- `vite.renderer.config.ts` is rooted at `renderer/`, so it cannot see `android/`.
- esbuild bundles from explicit `src/electron` entry points.
- `tsconfig.json` includes only `src/**` and now excludes `android` explicitly.
- `vitest.config.ts` excludes `**/android/**`.
- Gradle reads `../package.json` as **plain text** — no Node process is spawned.

A contributor with no Android SDK can still run `npm test` and `npm run build`;
a contributor with no Node can still build the APK.
