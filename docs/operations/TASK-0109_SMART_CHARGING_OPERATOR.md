# TASK-0109 Smart Charging Operator Controls

This release introduces smart charging limits with precedence at `CHARGER > GROUP > SITE` and automatic fallback behavior.

## Operator API Surface

- `GET /smart-charging/config`
- `GET|POST|PUT|DELETE /smart-charging/groups`
- `POST|DELETE /smart-charging/groups/:id/chargers/:chargerId`
- `GET|POST /smart-charging/profiles`
- `PUT|DELETE /smart-charging/profiles/:id`
- `GET /smart-charging/chargers/:chargerId/effective`
- `POST /smart-charging/chargers/:chargerId/reconcile`
- `GET /smart-charging/states`

## Schedule Format

`schedule` is an array of windows:

```json
[
  {
    "id": "weekday-peak",
    "daysOfWeek": [1, 2, 3, 4, 5],
    "startTime": "16:00",
    "endTime": "21:00",
    "limitKw": 18
  }
]
```

Rules:

- `daysOfWeek`: integers `0-6` (`0 = Sunday`)
- `startTime`, `endTime`: `HH:mm` (24h)
- `limitKw`: positive number
- evaluation timezone: UTC

## Effective Limit Resolution

1. Resolve active profile in scope precedence order: charger, then group, then site.
2. Within a scope, highest `priority` wins, with `updatedAt` as tiebreaker.
3. If no active window is matched, use profile `defaultLimitKw` when provided.
4. If profile data is invalid or no profile is active, apply safe fallback limit (`SMART_CHARGING_SAFE_LIMIT_KW`, default `7.2`).

## OCPP Apply Path

- API and OCPP server use `SetChargingProfile` with:
  - `connectorId: 0`
  - `chargingProfilePurpose: ChargePointMaxProfile`
  - `chargingProfileKind: Absolute`
  - one schedule period starting at `0`
  - limit converted from kW to W

On profile/group updates, affected chargers are reconciled immediately. On charger reconnect (`BootNotification`) and heartbeat recovery, OCPP server re-applies the current effective limit.

## Portal Integration Hooks

`packages/portal/src/api/client.ts` now exposes:

- `getSmartChargingConfig`
- `listSmartChargingGroups`, `createSmartChargingGroup`, `updateSmartChargingGroup`, `deleteSmartChargingGroup`
- `assignChargerToSmartGroup`, `unassignChargerFromSmartGroup`
- `listSmartChargingProfiles`, `createSmartChargingProfile`, `updateSmartChargingProfile`, `deleteSmartChargingProfile`
- `getSmartChargingEffectiveLimit`, `reconcileSmartChargingForCharger`, `listSmartChargingStates`

These hooks are intended for operator UI integration in Network Ops / Charger Detail workflows.
