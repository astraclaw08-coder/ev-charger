import { Fragment, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GoogleMap,
  OverlayView,
  OverlayViewF,
  useJsApiLoader,
} from '@react-google-maps/api';
import { usePortalTheme } from '../theme/ThemeContext';

export type DashboardSiteMapItem = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  availableChargers: number;
  totalChargers: number;
  chargerTypes?: string[];
};

const libraries: ('places')[] = ['places'];
const mapContainerStyle = { width: '100%', height: '100%' };

// Google Maps styling arrays for light/dark
const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1f2937' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9ca3af' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1f2937' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#374151' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#111827' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#d1d5db' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4b5563' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f172a' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

function availabilityColor(available: number, total: number): string {
  if (total === 0) return '#6b7280';
  if (available === 0) return '#ef4444';
  if (available < total) return '#f59e0b';
  return '#10b981';
}

export default function DashboardSitesMap({ sites }: { sites: DashboardSiteMapItem[] }) {
  const navigate = useNavigate();
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';

  const { isLoaded } = useJsApiLoader({
    // Must be identical across app mounts; loader throws if options differ (including id)
    id: 'portal-google-maps-loader',
    googleMapsApiKey: apiKey,
    libraries,
  });

  const center = useMemo<{ lat: number; lng: number }>(() => {
    if (!sites.length) return { lat: 34.0522, lng: -118.2437 };
    const lat = sites.reduce((sum, s) => sum + s.lat, 0) / sites.length;
    const lng = sites.reduce((sum, s) => sum + s.lng, 0) / sites.length;
    return { lat, lng };
  }, [sites]);

  const openSite = useCallback((siteId: string) => {
    navigate(`/sites/${siteId}`);
  }, [navigate]);

  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedSiteId) ?? null,
    [selectedSiteId, sites],
  );

  const onMapLoad = useCallback((map: google.maps.Map) => {
    if (!sites.length) return;
    try {
      const g = (globalThis as any).google;
      if (!g?.maps?.LatLngBounds) return;
      const bounds = new g.maps.LatLngBounds();
      sites.forEach((site) => bounds.extend({ lat: site.lat, lng: site.lng }));
      if (typeof map.fitBounds === 'function') map.fitBounds(bounds, 48);
    } catch (err) {
      console.warn('[DashboardSitesMap] onMapLoad bounds fit skipped', err);
    }
  }, [sites]);

  return (
    <div className={`mt-4 rounded-xl border p-4 ${isDark ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-white'}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className={`text-sm font-semibold ${isDark ? 'text-gray-100' : 'text-gray-700'}`}>Sites Map</p>
        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Click a site to open</p>
      </div>

      <div className={`h-72 overflow-hidden rounded-lg border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        {!apiKey ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-gray-500">
            Missing <code className="mx-1">VITE_GOOGLE_MAPS_API_KEY</code>.
          </div>
        ) : !isLoaded ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">Loading map…</div>
        ) : (
          <GoogleMap
            mapContainerStyle={mapContainerStyle}
            center={center}
            zoom={11}
            onLoad={onMapLoad}
            options={{
              mapTypeControl: false,
              streetViewControl: false,
              fullscreenControl: false,
              clickableIcons: false,
              styles: isDark ? DARK_MAP_STYLES : [],
            }}
          >
            {sites.map((site) => {
              const color = availabilityColor(site.availableChargers, site.totalChargers);
              const isSelected = selectedSiteId === site.id;
              return (
                <Fragment key={site.id}>
                  <OverlayViewF
                    position={{ lat: site.lat, lng: site.lng }}
                    mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
                  >
                    <div className="relative" style={{ transform: 'translate(-50%, -50%)' }}>
                      {/* Availability badge */}
                      <button
                        type="button"
                        className="site-avail-marker"
                        style={{ '--marker-color': color, transform: 'none' } as React.CSSProperties}
                        onClick={() => openSite(site.id)}
                        onMouseEnter={() => setSelectedSiteId(site.id)}
                        onMouseLeave={() => setSelectedSiteId((c) => (c === site.id ? null : c))}
                        aria-label={`${site.name}: ${site.availableChargers}/${site.totalChargers} available`}
                      >
                        <span className="marker-available">{site.availableChargers}</span>
                        <span className="marker-total">/{site.totalChargers}</span>
                      </button>

                      {/* Hover tooltip — no X, no scroll, click navigates */}
                      {isSelected && (
                        <button
                          type="button"
                          onClick={() => openSite(site.id)}
                          onMouseEnter={() => setSelectedSiteId(site.id)}
                          onMouseLeave={() => setSelectedSiteId(null)}
                          className={`site-hover-card ${isDark ? 'site-hover-card--dark' : 'site-hover-card--light'}`}
                        >
                          <p className="site-hover-name">{site.name}</p>
                          <p className="site-hover-address">{site.address}</p>
                          <div className="site-hover-chips">
                            <span className="site-hover-chip site-hover-chip--avail">
                              <span className="site-hover-dot" style={{ background: color }} />
                              {site.availableChargers}/{site.totalChargers} available
                            </span>
                            {(site.chargerTypes ?? ['Level 2']).map((t) => (
                              <span key={t} className="site-hover-chip site-hover-chip--type">{t}</span>
                            ))}
                          </div>
                        </button>
                      )}
                    </div>
                  </OverlayViewF>
                </Fragment>
              );
            })}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}
