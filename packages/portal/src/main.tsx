import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App';

// Fix default Leaflet marker icons when bundled with Vite
// Use new URL(..., import.meta.url) to resolve asset paths without TS import issues
import L from 'leaflet';
const iconUrl = new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href;
const shadowUrl = new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href;
L.Icon.Default.mergeOptions({ iconUrl, shadowUrl, iconRetinaUrl: iconUrl });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
