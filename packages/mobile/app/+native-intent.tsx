export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  // Normalize empty/host-only deep links like "evcharger:///" to app root.
  if (!path || path === '/' || path === '//' || path === '/--/' || path === '--') {
    return '/';
  }

  // Some platforms pass full URL string; parse + collapse root URLs.
  if (path.startsWith('evcharger://')) {
    try {
      const url = new URL(path);
      const normalizedPath = (url.pathname || '/').replace(/^\/--\//, '/');
      if (normalizedPath === '/' || normalizedPath === '//') return '/';
      return `${normalizedPath}${url.search || ''}${url.hash || ''}`;
    } catch {
      return '/';
    }
  }

  return path;
}
