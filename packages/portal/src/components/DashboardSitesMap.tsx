import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';

export type DashboardSiteMapItem = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  availableChargers: number;
  totalChargers: number;
};

function iconFor(availableChargers: number) {
  const safe = Math.max(0, availableChargers);
  return L.divIcon({
    className: 'site-count-marker-wrap',
    html: `<div class="site-count-marker">${safe}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function FitToSites({ sites }: { sites: DashboardSiteMapItem[] }) {
  const map = useMap();
  useEffect(() => {
    if (!sites.length) return;
    const bounds = L.latLngBounds(sites.map((s) => [s.lat, s.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
  }, [map, sites]);
  return null;
}

export default function DashboardSitesMap({ sites }: { sites: DashboardSiteMapItem[] }) {
  const center = useMemo<[number, number]>(() => {
    if (!sites.length) return [34.0522, -118.2437];
    const lat = sites.reduce((sum, s) => sum + s.lat, 0) / sites.length;
    const lng = sites.reduce((sum, s) => sum + s.lng, 0) / sites.length;
    return [lat, lng];
  }, [sites]);

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700">Sites Map</p>
        <p className="text-xs text-gray-500">Marker number = available chargers</p>
      </div>

      <div className="h-72 overflow-hidden rounded-lg border border-gray-200">
        <MapContainer center={center} zoom={11} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitToSites sites={sites} />
          {sites.map((site) => (
            <Marker
              key={site.id}
              position={[site.lat, site.lng]}
              icon={iconFor(site.availableChargers)}
              eventHandlers={{
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup(),
              }}
            >
              <Popup>
                <div className="min-w-[220px]">
                  <p className="text-sm font-semibold">{site.name}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{site.address}</p>
                  <p className="mt-2 text-xs">
                    Available chargers: <span className="font-semibold">{site.availableChargers}</span>
                    {' / '}
                    <span className="font-semibold">{site.totalChargers}</span>
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
