import { useRef, useEffect, useState, useCallback } from 'react';

export interface AddressComponents {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

interface Props {
  value: string;
  onChange: (address: string, lat: number, lng: number, components: AddressComponents) => void;
  onRawChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function extractComponents(place: google.maps.places.PlaceResult): AddressComponents {
  const get = (type: string, useShort = false) => {
    const c = place.address_components?.find((ac) => ac.types.includes(type));
    return c ? (useShort ? c.short_name : c.long_name) : '';
  };
  const streetNumber = get('street_number');
  const route = get('route');
  return {
    street: [streetNumber, route].filter(Boolean).join(' '),
    city: get('locality') || get('sublocality') || get('administrative_area_level_2'),
    state: get('administrative_area_level_1', true),
    zipCode: get('postal_code'),
    country: get('country', true),
  };
}

export default function AddressAutocomplete({ value, onChange, onRawChange, placeholder, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [error, setError] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handlePlaceChanged = useCallback(() => {
    const ac = autocompleteRef.current;
    if (!ac) return;
    const place = ac.getPlace();
    if (!place.geometry?.location) {
      setError('Could not validate this address. Please select from the suggestions.');
      return;
    }
    setError('');
    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();
    const formatted = place.formatted_address ?? '';
    const components = extractComponents(place);
    onChangeRef.current(formatted, lat, lng, components);
  }, []);

  useEffect(() => {
    function tryInit() {
      const input = inputRef.current;
      if (!input || autocompleteRef.current) return true; // already initialized or no input
      if (!window.google?.maps?.places) return false; // API not loaded yet

      const ac = new google.maps.places.Autocomplete(input, {
        types: ['address'],
        fields: ['formatted_address', 'geometry', 'address_components'],
      });
      ac.addListener('place_changed', handlePlaceChanged);
      autocompleteRef.current = ac;
      return true;
    }

    // Try immediately — if API is already loaded, init right away
    if (tryInit()) return () => {
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };

    // API not loaded yet — poll until it is (useJsApiLoader loads it async)
    const interval = setInterval(() => {
      if (tryInit()) clearInterval(interval);
    }, 200);

    return () => {
      clearInterval(interval);
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };
  }, [handlePlaceChanged]);

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          setError('');
          onRawChange?.(e.target.value);
        }}
        placeholder={placeholder ?? 'Start typing an address…'}
        className={className}
      />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
