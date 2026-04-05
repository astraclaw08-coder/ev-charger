import { useMemo } from 'react';
import { GoogleMap, OverlayView, OverlayViewF, useJsApiLoader } from '@react-google-maps/api';
import type { ChargerInfo } from '../api/client';
import { usePortalTheme } from '../theme/ThemeContext';

interface Props {
  lat: number;
  lng: number;
  siteName: string;
  chargers: ChargerInfo[];
}

const mapContainerStyle = { width: '100%', height: '100%' };
const libraries: ('places')[] = ['places'];

// Minimal map styles: keep street / city / state labels, hide nearly everything else.
const CLEAN_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.local', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
];

const LIGHT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  ...CLEAN_MAP_STYLES,
];

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
  ...CLEAN_MAP_STYLES,
];

export default function ChargerMap({ lat, lng, siteName, chargers }: Props) {
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';
  const center = useMemo(() => ({ lat, lng }), [lat, lng]);
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';

  const { isLoaded } = useJsApiLoader({
    // Must match DashboardSitesMap loader id to avoid duplicate-loader option mismatch
    id: 'portal-google-maps-loader',
    googleMapsApiKey: apiKey,
    libraries,
  });

  const available = chargers.filter((c) => c.status === 'AVAILABLE').length;

  if (!apiKey) {
    return (
      <div className="flex h-72 w-full items-center justify-center rounded-lg border border-gray-200 bg-white px-4 text-center text-xs text-gray-500 shadow-sm">
        Missing <code className="mx-1">VITE_GOOGLE_MAPS_API_KEY</code>.
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className={`flex h-72 w-full items-center justify-center rounded-lg border text-sm shadow-sm ${isDark ? 'border-gray-700 bg-gray-900 text-gray-400' : 'border-gray-200 bg-white text-gray-500'}`}>
        Loading map…
      </div>
    );
  }

  return (
    <div className={`h-72 w-full overflow-hidden rounded-lg border shadow-sm ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={15}
        options={{
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          styles: isDark ? DARK_MAP_STYLES : LIGHT_MAP_STYLES,
        }}
      >
        <OverlayViewF
          position={center}
          mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
        >
          <div className="relative" style={{ transform: 'translate(-50%, -50%)' }}>
            {/* Badge */}
            <div
              className="site-avail-marker"
              style={{ '--marker-color': available > 0 ? '#10b981' : '#ef4444', transform: 'none' } as React.CSSProperties}
              aria-label={`${siteName}: ${available}/${chargers.length} available`}
            >
              <span className="marker-available">{available}</span>
              <span className="marker-total">/{chargers.length}</span>
            </div>

            {/* Site summary card (matches overview style) */}
            <div className={`site-hover-card ${isDark ? 'site-hover-card--dark' : 'site-hover-card--light'}`} style={{ cursor: 'default', pointerEvents: 'none' }}>
              <p className="site-hover-name">{siteName}</p>
              <div className="site-hover-chips" style={{ marginBottom: 0 }}>
                <span className="site-hover-chip site-hover-chip--avail">
                  <span className="site-hover-dot" style={{ background: available > 0 ? '#10b981' : '#ef4444' }} />
                  {available}/{chargers.length} available
                </span>
                <span className="site-hover-chip site-hover-chip--type">
                  {chargers.some((c) => `${c.model ?? ''} ${c.vendor ?? ''}`.toLowerCase().match(/dc|ccs|chademo|fast|dcfc|supercharger/)) ? 'DCFC' : 'Level 2'}
                </span>
              </div>
            </div>
          </div>
        </OverlayViewF>
      </GoogleMap>
    </div>
  );
}
