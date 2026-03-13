/**
 * Favorites — server-backed favorites with one-time migration of legacy local IDs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api, getAuthIdentityKey, isGuestMode } from '@/lib/api';

const LEGACY_KEY = 'ev_favorites_v1';
const MIGRATION_KEY_PREFIX = 'ev_favorites_migrated_v1';
let migrationPromise: Promise<void> | null = null;

function migrationKeyForCurrentUser() {
  const identity = getAuthIdentityKey();
  if (!identity) return null;
  return `${MIGRATION_KEY_PREFIX}:${identity}`;
}

function sanitizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return Array.from(deduped);
}

async function readLegacyFavorites() {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_KEY);
    return sanitizeIds(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

async function ensureMigratedIfNeeded() {
  if (isGuestMode()) return;
  const key = migrationKeyForCurrentUser();
  if (!key) return;
  const already = await AsyncStorage.getItem(key);
  if (already === '1') return;

  const localFavorites = await readLegacyFavorites();
  if (localFavorites.length > 0) {
    await api.favorites.replace(localFavorites);
  }

  await AsyncStorage.setItem(key, '1');
  await AsyncStorage.removeItem(LEGACY_KEY);
}

async function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = ensureMigratedIfNeeded().finally(() => {
      migrationPromise = null;
    });
  }
  await migrationPromise;
}

export async function getFavorites(): Promise<string[]> {
  if (isGuestMode()) return [];
  try {
    await ensureMigrated();
    const res = await api.favorites.list();
    return sanitizeIds(res.chargerIds);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return [];
    }
    return [];
  }
}

export async function toggleFavorite(id: string): Promise<boolean> {
  if (isGuestMode()) return false;

  const chargerId = id.trim();
  if (!chargerId) return false;

  const favorites = await getFavorites();
  const alreadyFavorite = favorites.includes(chargerId);

  try {
    if (alreadyFavorite) {
      await api.favorites.remove(chargerId);
      return false;
    }
    await api.favorites.add(chargerId);
    return true;
  } catch {
    return alreadyFavorite;
  }
}

export async function clearFavorites(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore cleanup errors
  }
}
