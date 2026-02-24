# Lessons Learned — ev-charger

> Updated after every correction. Claude Code reads this at session start.

## OCPP Rules
- OCPP messages are arrays: `[MessageTypeId, UniqueId, Action, Payload]` — never objects
- Always respond to every CALL with a CALLRESULT or CALLERROR — chargers will retry indefinitely otherwise
- Charger state is the source of truth — never infer connector status from API calls alone
- `transactionId` must be unique per session and returned in `StartTransaction` response — chargers track this
- MeterValues use OCPP `measurand` enums — don't invent field names

## Billing Rules
- Authorize a Stripe hold at `StartTransaction`, capture at `StopTransaction`
- kWh is from `StopTransaction.meterStop - StartTransaction.meterStart` (Wh units, divide by 1000)
- Never charge before `StopTransaction` is received — charger is the billing source of truth
