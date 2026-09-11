/**
 * useMobileDevices — the reactive contract the Mobile tab and its dialog rely on.
 *
 * The behaviours worth guarding are the ones that leave the UI lying: a
 * successful pairing must dismiss its own dialog (the peers equivalent once left
 * the six digits on screen forever), a refused start must surface the reason
 * rather than spinning, and a dialog opened mid-flow must adopt the real state.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Captured event handlers, so a test can fire a real main-process event. */
const handlers: Record<string, (payload: any) => void> = {};
const on = (name: string) => (cb: (payload: any) => void) => { handlers[name] = cb; };

let devicesFromMain: any[] = [];
let startResult: { ok: boolean; reason?: string } = { ok: true };
let stateFromMain: any = { status: 'idle' };
let apkResult: any = {
  ok: true,
  version: '2.7.3',
  tag: 'v2.7.3',
  assetName: 'helm-2.7.3.apk',
  url: 'https://github.com/PetePeter/helm/releases/download/v2.7.3/helm-2.7.3.apk',
  qrPayload: 'https://github.com/PetePeter/helm/releases/download/v2.7.3/helm-2.7.3.apk',
  availability: 'available',
  note: '',
};
const calls: Array<[string, ...any[]]> = [];

vi.mock('../renderer/ipc/clients.js', () => ({
  mobileClient: {
    mobileList: async () => devicesFromMain,
    mobileStartPairing: async () => { calls.push(['start']); return startResult; },
    mobileConfirmPairing: async (accepted: boolean) => { calls.push(['confirm', accepted]); return { ok: true }; },
    mobileCancelPairing: async () => { calls.push(['cancel']); return { ok: true }; },
    mobilePairingState: async () => stateFromMain,
    mobileSetAllowList: async (id: string, allow: string[]) => { calls.push(['allow', id, allow]); return { ok: true }; },
    mobileSetEnabled: async (id: string, on2: boolean) => { calls.push(['enabled', id, on2]); return { ok: true }; },
    mobileRevoke: async (id: string) => { calls.push(['revoke', id]); return { ok: true }; },
    mobileApkRelease: async () => { calls.push(['apk']); return apkResult; },
  },
  eventsClient: {
    onMobileDevicesChanged: on('devices'),
    onMobilePairingState: on('state'),
  },
}));

const { useMobileDevices, resetMobileDevicesStateForTesting, PAIRED_DISMISS_MS } =
  await import('../renderer/composables/useMobileDevices.js');

describe('useMobileDevices', () => {
  beforeEach(() => {
    resetMobileDevicesStateForTesting();
    devicesFromMain = [];
    startResult = { ok: true };
    stateFromMain = { status: 'idle' };
    apkResult = {
      ok: true,
      version: '2.7.3',
      tag: 'v2.7.3',
      assetName: 'helm-2.7.3.apk',
      url: 'https://github.com/PetePeter/helm/releases/download/v2.7.3/helm-2.7.3.apk',
      qrPayload: 'https://github.com/PetePeter/helm/releases/download/v2.7.3/helm-2.7.3.apk',
      availability: 'available',
      note: '',
    };
    calls.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the paired devices on first subscribe', async () => {
    devicesFromMain = [{
      id: 'd1', machineId: 'm1', name: 'Pixel 8',
      allow: [], enabled: true, online: false, createdAt: 1,
    }];
    const mobile = useMobileDevices();

    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();

    expect(mobile.devices.value).toHaveLength(1);
    expect(mobile.devices.value[0].name).toBe('Pixel 8');
  });

  it('subscribes only once however many components mount', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    const first = handlers.state;
    mobile.ensureSubscribed();

    expect(handlers.state).toBe(first);
  });

  it('opens the dialog and shows the code as the flow advances', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();

    void mobile.startPairing();
    expect(mobile.dialogOpen.value).toBe(true);
    expect(mobile.pairing.value.status).toBe('scanning');

    handlers.state({ status: 'awaiting-sas', sas: '123456', deviceName: 'Pixel 8' });
    expect(mobile.pairing.value.sas).toBe('123456');
  });

  it('dismisses its own dialog once pairing succeeds', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();
    void mobile.startPairing();
    await vi.advanceTimersByTimeAsync(0);

    handlers.state({ status: 'paired', deviceName: 'Pixel 8' });
    expect(mobile.dialogOpen.value).toBe(true); // still up, briefly, to confirm

    await vi.advanceTimersByTimeAsync(PAIRED_DISMISS_MS + 1);
    expect(mobile.dialogOpen.value).toBe(false);
  });

  it('surfaces the reason when the main process refuses to start', async () => {
    startResult = { ok: false, reason: 'Too many failed attempts' };
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();

    await mobile.startPairing();

    expect(mobile.pairing.value.status).toBe('failed');
    expect(mobile.pairing.value.reason).toBe('Too many failed attempts');
  });

  it('adopts a flow already in progress when it subscribes late', async () => {
    stateFromMain = { status: 'awaiting-sas', sas: '654321', deviceName: 'Pixel 8' };
    const mobile = useMobileDevices();

    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();

    expect(mobile.pairing.value.sas).toBe('654321');
  });

  it('cancelling closes the dialog and tells the main process', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();
    void mobile.startPairing();
    await vi.advanceTimersByTimeAsync(0);

    await mobile.cancelPairing();

    expect(mobile.dialogOpen.value).toBe(false);
    expect(mobile.pairing.value.status).toBe('idle');
    expect(calls.some(([name]) => name === 'cancel')).toBe(true);
  });

  it('does not cancel a pairing that already succeeded when the dialog closes', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();
    void mobile.startPairing();
    await vi.advanceTimersByTimeAsync(0);
    handlers.state({ status: 'paired', deviceName: 'Pixel 8' });

    mobile.closePairing();

    expect(mobile.dialogOpen.value).toBe(false);
    expect(calls.some(([name]) => name === 'cancel')).toBe(false);
  });

  it('re-reads the registry after every mutating action', async () => {
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await vi.runAllTimersAsync();

    await mobile.setEnabled('d1', false);
    await mobile.setAllowList('d1', ['session_*']);
    await mobile.revoke('d1');

    expect(calls).toEqual([
      ['enabled', 'd1', false],
      ['allow', 'd1', ['session_*']],
      ['revoke', 'd1'],
    ]);
  });

  it('does not re-ask GitHub for the APK on every registry event', async () => {
    // The answer only changes across releases. Folding it into refresh() would
    // hit the network on every online/offline flip of a paired phone.
    const mobile = useMobileDevices();
    mobile.ensureSubscribed();
    await mobile.loadApkRelease();
    handlers.devices(undefined);
    await vi.runAllTimersAsync();

    expect(calls.filter(([name]) => name === 'apk')).toHaveLength(1);
    expect(mobile.apkRelease.value?.availability).toBe('available');
    expect(mobile.apkError.value).toBeNull();
  });

  it('surfaces a reason instead of an empty panel when there is no download to offer', async () => {
    apkResult = { ok: false, reason: 'Not a releasable Helm version: "dev"' };
    const mobile = useMobileDevices();

    await mobile.loadApkRelease();

    expect(mobile.apkRelease.value).toBeNull();
    expect(mobile.apkError.value).toContain('dev');
  });
});
