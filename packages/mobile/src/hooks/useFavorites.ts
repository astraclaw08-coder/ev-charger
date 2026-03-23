import { useCallback, useEffect, useState } from 'react';
import { getFavorites, toggleFavorite } from '@/lib/favorites';

type Listener = (ids: string[]) => void;
const listeners = new Set<Listener>();
let cached: string[] | null = null;

function notify(ids: string[]) {
  cached = ids;
  listeners.forEach((l) => l(ids));
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<string[]>(cached ?? []);

  useEffect(() => {
    let mounted = true;

    // Fast paint from in-memory cache, then always refresh from server/cache source of truth.
    if (cached !== null) {
      setFavorites(cached);
    }

    getFavorites().then((ids) => {
      if (!mounted) return;
      cached = ids;
      setFavorites(ids);
    });

    const listener: Listener = (ids) => { if (mounted) setFavorites(ids); };
    listeners.add(listener);
    return () => { mounted = false; listeners.delete(listener); };
  }, []);

  const toggle = useCallback(async (id: string) => {
    await toggleFavorite(id);
    const updated = await getFavorites();
    notify(updated);
  }, []);

  const isFav = useCallback((id: string) => favorites.includes(id), [favorites]);

  return { favorites, toggle, isFav };
}
