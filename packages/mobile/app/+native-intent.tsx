export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  // Normalize empty/host-only deep links like "evcharger:///" to app root.
  if (!path || path === '/' || path === '//') {
    return '/';
  }

  return path;
}
