export type ChargerQrParseResult = {
  chargerId: string;
  source: 'deep-link' | 'redirect-url' | 'query-param' | 'json' | 'plain-id';
};

function clean(input: string): string {
  return input.trim().replace(/^['"]|['"]$/g, '');
}

function extractFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length >= 3 && parts[0] === 'charger' && parts[1] === 'detail') return parts[2];
  if (parts.length >= 3 && parts[0] === 'r' && parts[1] === 'charger') return parts[2];
  if (parts.length >= 2 && parts[0] === 'charger') return parts[1];
  return null;
}

function normalizeMaybeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function parseChargerQrPayload(rawPayload: string): ChargerQrParseResult | null {
  const value = clean(rawPayload);
  if (!value) return null;

  const parsedUrl = normalizeMaybeUrl(value);
  if (parsedUrl) {
    const fromPath = extractFromPath(parsedUrl.pathname || '/');
    if (fromPath) return { chargerId: fromPath, source: parsedUrl.pathname.includes('/r/charger/') ? 'redirect-url' : 'deep-link' };

    const q = parsedUrl.searchParams;
    const qId = q.get('chargerId') || q.get('charger_id') || q.get('id');
    if (qId) return { chargerId: qId.trim(), source: 'query-param' };
  }

  try {
    const obj = JSON.parse(value) as { chargerId?: string; charger_id?: string; id?: string };
    const id = obj.chargerId || obj.charger_id || obj.id;
    if (id && id.trim()) return { chargerId: id.trim(), source: 'json' };
  } catch {
    // not json
  }

  if (/^[A-Za-z0-9_-]{6,}$/.test(value)) {
    return { chargerId: value, source: 'plain-id' };
  }

  return null;
}
