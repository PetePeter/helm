import type { LoopDriver } from '../session/hooks/loop-driver.js';

/** Return the completion driver owned by the configured admin profile. */
export function getAdminLoopDriver(
  loopDrivers: ReadonlyMap<string, Pick<LoopDriver, 'noteCompletion'>>,
  adminProfileId: string,
): Pick<LoopDriver, 'noteCompletion'> {
  const loopDriver = loopDrivers.get(adminProfileId);
  if (!loopDriver) throw new Error(`No loop driver configured for admin profile ${adminProfileId}`);
  return loopDriver;
}
