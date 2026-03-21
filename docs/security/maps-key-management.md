# Google Maps Key Management (Prod/Dev Separation)

## Policy
- Never commit real Google API keys to git.
- Keep production and development keys separate for each platform.
- Restrict each key to its platform and app identity.

## Key naming convention

### Portal (Web)
- `VITE_GOOGLE_MAPS_API_KEY` (DEV/local only)
- Vercel production env var: `VITE_GOOGLE_MAPS_API_KEY` (PROD value)

### Mobile (Expo/EAS)
- DEV
  - `GOOGLE_MAPS_API_KEY_IOS_DEV`
  - `GOOGLE_MAPS_API_KEY_ANDROID_DEV`
  - `GOOGLE_MAPS_API_KEY_DEV` (optional shared fallback)
- PROD
  - `GOOGLE_MAPS_API_KEY_IOS_PROD`
  - `GOOGLE_MAPS_API_KEY_ANDROID_PROD`
  - `GOOGLE_MAPS_API_KEY_PROD` (optional shared fallback)

## Where to store secrets
- **Prod web key**: Vercel project env vars (Production scope)
- **Prod mobile keys**: EAS project secrets
- **Dev keys**: local `.env.local` files only (ignored by git)

## Verification checklist
1. `grep -R "AIza"` in repo returns no tracked source files with real keys.
2. `npm run security:secrets` passes.
3. Portal builds and map loads in both dev and prod.
4. Mobile app config resolves DEV keys for dev profile and PROD keys for production profile.
