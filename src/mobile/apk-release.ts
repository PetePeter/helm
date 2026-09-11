/**
 * Where the phone gets the app.
 *
 * Helm does NOT host the APK. `PetePeter/helm` is public, so a release asset is
 * a plain HTTPS URL a phone can fetch with no server, no token and no TTL on
 * this side. Downloading it grants nothing: a fresh install is an unpaired
 * stranger until SAS pairing completes and MobileGate lets it through.
 *
 * The one rule this module exists to hold: the URL addresses the tag of the
 * Helm that is RUNNING, never `latest`. A `latest` URL renders identically and
 * hands over an APK from a different release, which protocol-version
 * negotiation then refuses — a support problem that looks like a broken radio.
 */

/** The public repo that carries the release assets. */
export const APK_REPO = 'PetePeter/helm';

/** What a lookup of the asset concluded. `unknown` is not `missing`. */
export type ApkAvailability = 'available' | 'missing' | 'unknown';

export interface ApkReleaseInfo {
  version: string;
  tag: string;
  assetName: string;
  url: string;
  /** Exactly the URL. Named separately because a QR payload must not be padded. */
  qrPayload: string;
  availability: ApkAvailability;
  /** Empty when there is nothing to warn about. */
  note: string;
}

/**
 * Semver as prepareDeploy.py writes it: three numeric parts, optional
 * prerelease suffix. Validated rather than interpolated blindly — everything
 * downstream is a URL and a shell argument, and a half-formed URL behind a QR
 * code is unreadable as a fault.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function requireVersion(version: string): string {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`Not a releasable Helm version: ${JSON.stringify(version)}`);
  }
  return version;
}

/** `2.7.3` -> `v2.7.3`, matching the tags sendDeploy.py pushes. */
export function apkReleaseTag(version: string): string {
  return `v${requireVersion(version)}`;
}

/** Version-stamped so a release can never carry an APK from another build. */
export function apkAssetName(version: string): string {
  return `helm-${requireVersion(version)}.apk`;
}

export function apkReleaseUrl(version: string): string {
  return `https://github.com/${APK_REPO}/releases/download/${apkReleaseTag(version)}/${apkAssetName(version)}`;
}

function availabilityNote(version: string, availability: ApkAvailability): string {
  switch (availability) {
    case 'available':
      return '';
    case 'missing':
      return `No APK was published for v${version}. This link will not work until a release carries one.`;
    case 'unknown':
      // "We could not ask" and "it is not there" are different claims. Merging
      // them tells the user their release is broken every time they are offline.
      return `Could not check whether v${version} has an APK — the link is shown anyway.`;
  }
}

export function describeApkRelease(version: string, availability: ApkAvailability): ApkReleaseInfo {
  const url = apkReleaseUrl(version);
  return {
    version,
    tag: apkReleaseTag(version),
    assetName: apkAssetName(version),
    url,
    qrPayload: url,
    availability,
    note: availabilityNote(version, availability),
  };
}
