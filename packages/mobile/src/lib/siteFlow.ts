/**
 * Site-level aggregation helpers for the site detail screen.
 *
 * Groups chargers by their site, counts available connectors, and identifies
 * the first "ready" (AVAILABLE) connector on a charger.
 */

type Connector = {
  connectorId: number;
  status?: string;
  // TASK-0208 Phase 3 Slice D — Fleet-Auto connectors are excluded from
  // driver-facing availability counts and the "first ready connector"
  // selection. Absence of this field is treated as PUBLIC.
  chargingMode?: 'PUBLIC' | 'FLEET_AUTO';
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
 * Returns the connectorId (1-based) of the first AVAILABLE connector that
 * is also publicly start-able (i.e. not a Fleet-Auto connector — those are
 * server-initiated only and never selectable from the driver app).
 */
export function getFirstReadyConnectorId(charger: ChargerLike): number | null {
  const connectors = charger.connectors ?? [];
  const ready = connectors.find(
    (c) => (c.status ?? '').toUpperCase() === 'AVAILABLE' && c.chargingMode !== 'FLEET_AUTO',
  );
  return ready ? ready.connectorId : null;
}

/**
 * True iff the charger has at least one Fleet-Auto connector. Used by the
 * driver UI to surface a "Fleet only" / informational treatment.
 */
export function hasFleetAutoConnector(charger: ChargerLike): boolean {
  const connectors = charger.connectors ?? [];
  return connectors.some((c) => c.chargingMode === 'FLEET_AUTO');
}

/**
 * True iff EVERY connector on the charger is Fleet-Auto (i.e. no public
 * connector exists at all). The driver UI uses this to badge the whole
 * charger as fleet-only rather than showing partial availability.
 */
export function isAllFleetAutoCharger(charger: ChargerLike): boolean {
  const connectors = charger.connectors ?? [];
  if (connectors.length === 0) return false;
  return connectors.every((c) => c.chargingMode === 'FLEET_AUTO');
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
    // Phase 3 Slice D: only count public AVAILABLE connectors. Fleet-Auto
    // connectors are visible to drivers but never reservable / start-able
    // from the mobile app, so they shouldn't inflate the "X/Y ports
    // available" badge on the map / site detail.
    agg.availablePorts += connectors.filter(
      (c) => (c.status ?? '').toUpperCase() === 'AVAILABLE' && c.chargingMode !== 'FLEET_AUTO',
    ).length;

    const typeLabel = charger.connectorType || charger.model || charger.vendor || null;
    if (typeLabel && !agg.chargerTypes.includes(String(typeLabel))) {
      agg.chargerTypes.push(String(typeLabel));
    }
  }

  return Array.from(bySite.values());
}
