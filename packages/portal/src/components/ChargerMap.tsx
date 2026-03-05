import L from 'leaflet';
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

const siteIcon = L.divIcon({
  className: '',
  html: '<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))">📍</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -34],
});

export default function ChargerMap({ lat, lng, siteName, chargers }: Props) {
  return (
    <div className="h-72 w-full overflow-hidden rounded-lg border border-gray-200 shadow-sm">
      <MapContainer center={[lat, lng]} zoom={15} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://stadiamaps.com/">Stadia Maps</a>'
          url="https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png"
        />
        <Marker position={[lat, lng]} icon={siteIcon}>
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
              {chargers.length > 0 && (
                <Link to={`/chargers/${chargers[0].id}`} className="mt-2 block text-xs text-blue-400 hover:underline">View chargers →</Link>
              )}
            </div>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
