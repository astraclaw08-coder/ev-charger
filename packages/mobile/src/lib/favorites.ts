/**
 * Favorites — AsyncStorage-backed store for favorited charger IDs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'ev_favorites_v1';

export async function getFavorites(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function toggleFavorite(id: string): Promise<boolean> {
  const favs = await getFavorites();
  const idx = favs.indexOf(id);
  const next = idx === -1 ? [...favs, id] : favs.filter((f) => f !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return idx === -1;
}

export async function clearFavorites(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore cleanup errors
  }
}
