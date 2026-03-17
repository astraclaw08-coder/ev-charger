/**
 * Returns a short, URL-safe identifier for display and linking.
 * - UUID-style (8-4-4-4-12): returns first 8 hex chars
 * - Slug-style (charger-001, site-hawthorne-001): returns as-is (already short)
 */
export function shortId(id: string): string {
  if (!id) return id;
  // UUID pattern: 8-4-4-4-12 hex + dashes = 36 chars
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id.slice(0, 8);
  }
  return id;
}
