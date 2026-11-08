/**
 * A profile switch reloads the window: chat entries, notifications, flight
 * badges and previews are renderer-side caches of the previous profile, and a
 * reload is the one reset that cannot miss a store added later.
 */
export function installProfileReload(
  client: { profileOnChanged: (callback: () => void) => () => void },
  reload: () => void,
): () => void {
  return client.profileOnChanged(() => reload());
}
