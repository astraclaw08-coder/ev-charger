import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { ChargerInfo } from '../api/client';
import StatusBadge from './StatusBadge';

interface Props {
  lat: number;
  lng: number;
  siteName: string;
  chargers: ChargerInfo[];
}

export default function ChargerMap({ lat, lng, siteName, chargers }: Props) {
  return (
    <div className="h-72 w-full overflow-hidden rounded-lg border border-gray-200 shadow-sm">
      <MapContainer center={[lat, lng]} zoom={15} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <Marker position={[lat, lng]}>
          <Popup>
            <div className="min-w-[180px]">
              <p className="font-semibold">{siteName}</p>
              <div className="mt-2 space-y-1">
                {chargers.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono">{c.ocppId}</span>
                    <StatusBadge status={c.status} type="charger" />
                  </div>
                ))}
              </div>
            </div>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
