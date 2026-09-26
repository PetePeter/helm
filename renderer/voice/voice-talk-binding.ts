/**
 * Hold tracking for the `voice-talk` binding action: press starts a talk,
 * release of the SAME button stops and sends it. A talk left held when input
 * is torn down (releaseAllHeldKeys) is stopped, never left recording.
 */
export interface VoiceTalkController {
  startTalk(): Promise<void>;
  stopTalk(): Promise<void>;
}

export function createVoiceTalkHolds(controller: VoiceTalkController) {
  const held = new Set<string>();

  function press(button: string): void {
    if (held.has(button)) return;
    held.add(button);
    void controller.startTalk();
  }

  /** Returns true when the release belonged to a talk. */
  function release(button: string): boolean {
    if (!held.delete(button)) return false;
    void controller.stopTalk();
    return true;
  }

  function releaseAll(): void {
    if (held.size === 0) return;
    held.clear();
    void controller.stopTalk();
  }

  return { press, release, releaseAll };
}
