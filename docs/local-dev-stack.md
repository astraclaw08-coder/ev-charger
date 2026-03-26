# Local Dev Stack

Use the supervisor — it now boots Docker infra too.

## Start everything

```bash
cd ~/projects/ev-charger
npm run dev:stack:start
```

This now ensures:
- Postgres via Docker (`5432`)
- Keycloak via Docker (`8090`)
- pgAdmin via Docker (`5050`)
- API (`3001`)
- OCPP server (`9000`)
- Portal (`5175` in supervisor mode)

## Stop everything

```bash
cd ~/projects/ev-charger
npm run dev:stack:stop
```

## Status / health

```bash
npm run dev:stack:status
npm run dev:stack:health
```

## Login

Local dev login is seeded through the Keycloak realm import:
- Username/email: `sdang3209@gmail.com`
- Password: `DevPass#2026`

## Notes

- `docker-compose.yml` now includes persistent Keycloak storage (`keycloak_data` volume).
- Realm import lives at `scripts/auth/keycloak-dev-import.json`.
- First boot imports the dev realm automatically.
- If you intentionally want a fresh Keycloak state, remove the volume:

```bash
docker volume rm ev-charger_keycloak_data
```
