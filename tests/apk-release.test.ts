/**
 * The Android APK's download address, as Settings -> Mobile shows it.
 *
 * The value under test is not string formatting — it is that the URL points at
 * the tag of the Helm that is RUNNING. A `latest` URL looks identical in the UI
 * and hands the user an APK from a different release, which protocol-version
 * negotiation would then refuse. That failure is invisible from here, so it is
 * pinned by a test instead.
 */
import { describe, it, expect } from 'vitest';
import {
  APK_REPO,
  apkAssetName,
  apkReleaseTag,
  apkReleaseUrl,
  describeApkRelease,
} from '../src/mobile/apk-release.js';

describe('apk-release URL derivation', () => {
  it('addresses the running version\'s tag, never `latest`', () => {
    const url = apkReleaseUrl('2.7.3');
    expect(url).toContain('/releases/download/v2.7.3/');
    expect(url).not.toContain('latest');
  });

  it('names the asset with the same version the tag carries', () => {
    // A single version-stamped asset name is what lets sendDeploy.py refuse a
    // release whose APK came from a different build.
    expect(apkAssetName('2.7.3')).toBe('helm-2.7.3.apk');
    expect(apkReleaseUrl('2.7.3')).toBe(
      `https://github.com/${APK_REPO}/releases/download/${apkReleaseTag('2.7.3')}/${apkAssetName('2.7.3')}`,
    );
  });

  it('accepts a prerelease suffix rather than silently truncating it', () => {
    expect(apkReleaseUrl('2.7.3-beta.1')).toContain('/download/v2.7.3-beta.1/helm-2.7.3-beta.1.apk');
  });

  it.each(['', '  ', 'latest', '2.7', 'v2.7.3', '2.7.3 ; rm -rf /'])(
    'refuses the unusable version %p instead of composing a broken URL',
    (version) => {
      // A half-formed URL behind a QR code is unreadable as a fault: the user
      // sees a code, scans it, and gets a 404 with nothing to report.
      expect(() => apkReleaseUrl(version)).toThrow(/version/i);
    },
  );

  it('produces a QR payload with no trailing whitespace', () => {
    // Some scanners carry a trailing newline straight into the browser's
    // address bar, where it becomes a 404 on a URL that looks correct.
    const { qrPayload, url } = describeApkRelease('2.7.3', 'available');
    expect(qrPayload).toBe(url);
    expect(qrPayload).toBe(qrPayload.trim());
  });
});

describe('apk-release availability note', () => {
  it('says nothing when the asset is there', () => {
    expect(describeApkRelease('2.7.3', 'available').note).toBe('');
  });

  it('names the version when no APK was published for it', () => {
    const { note } = describeApkRelease('2.7.3', 'missing');
    expect(note).toContain('2.7.3');
    expect(note).toMatch(/no apk/i);
  });

  it('distinguishes "could not check" from "not published"', () => {
    // Same distinction the permissions sheet draws: "we could not ask" and
    // "it is not there" are different claims, and collapsing them tells the
    // user their release is broken every time they are offline.
    const unknown = describeApkRelease('2.7.3', 'unknown').note;
    expect(unknown).not.toMatch(/no apk/i);
    expect(unknown).toMatch(/could not check/i);
  });

  it('carries the URL regardless of availability, so the link is always copyable', () => {
    for (const availability of ['available', 'missing', 'unknown'] as const) {
      expect(describeApkRelease('2.7.3', availability).url).toContain('helm-2.7.3.apk');
    }
  });
});
