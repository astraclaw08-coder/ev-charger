/**
 * Site-level aggregation helpers for the site detail screen.
 *
 * Groups chargers by their site, counts available connectors, and identifies
 * the first "ready" (AVAILABLE) connector on a charger.
 */

type Connector = {
  connectorId: number;
  status?: string;
};

type ChargerLike = {
  id: string;
  ocppId: string;
  serialNumber?: string | null;
  model?: string | null;
  vendor?: string | null;
  connectorType?: string | null;
  site?: {
    id: string;
    name?: string;
    address?: string;
    [k: string]: unknown;
  } | null;
  connectors?: Connector[];
  [k: string]: unknown;
};

export type SiteAggregate = {
  siteId: string;
  siteName: string;
  siteAddress: string;
  totalPorts: number;
  availablePorts: number;
  chargerTypes: string[];
  chargers: ChargerLike[];
};

/**
 * Returns the connectorId (1-based) of the first AVAILABLE connector on the
 * charger, or null if none is available.
 */
export function getFirstReadyConnectorId(charger: ChargerLike): number | null {
  const connectors = charger.connectors ?? [];
  const ready = connectors.find((c) => (c.status ?? '').toUpperCase() === 'AVAILABLE');
  return ready ? ready.connectorId : null;
}

/**
 * Group a flat charger list into per-site aggregates. Chargers with no site
 * are skipped.
 */
export function buildSiteAggregates(chargers: ChargerLike[]): SiteAggregate[] {
  const bySite = new Map<string, SiteAggregate>();

  for (const charger of chargers) {
    const site = charger.site;
    if (!site?.id) continue;

    let agg = bySite.get(site.id);
    if (!agg) {
      agg = {
        siteId: site.id,
        siteName: String(site.name ?? ''),
        siteAddress: String(site.address ?? ''),
        totalPorts: 0,
        availablePorts: 0,
        chargerTypes: [],
        chargers: [],
      };
      bySite.set(site.id, agg);
    }

    agg.chargers.push(charger);

    const connectors = charger.connectors ?? [];
    agg.totalPorts += connectors.length;
    agg.availablePorts += connectors.filter(
      (c) => (c.status ?? '').toUpperCase() === 'AVAILABLE',
    ).length;

    const typeLabel = charger.connectorType || charger.model || charger.vendor || null;
    if (typeLabel && !agg.chargerTypes.includes(String(typeLabel))) {
      agg.chargerTypes.push(String(typeLabel));
    }
  }

  return Array.from(bySite.values());
}
