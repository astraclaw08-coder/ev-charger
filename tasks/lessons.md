# Lessons Learned — ev-charger

> **Canonical source:** `~/.openclaw/workspace/lessons-learned/ev-charger.md`
> **Coding agent subset:** See `CLAUDE.md` in repo root (⚠️ Hard Rules section)
>
> This file is a pointer. The full lessons with incident dates and context live in the workspace file.
> CLAUDE.md contains the subset that coding agents (Codex, Claude Code) need at session start.

## 2026-04-16 — Smart Charging: Merged-Profile Model

**Incident:** Charger 1A32 (LOOP EX-1762) started sessions at 6kW target but drifted to 7.68kW.

**Root cause chain (3 bugs, each masking the next):**
1. `alreadyEquivalent` check compared only `profileFingerprint` (definition hash), not the resolved effective limit. When the active schedule window changed, the code skipped the push because the fingerprint hadn't changed. *Fixed: added `effectiveLimitKw` comparison.*
2. After fix #1 pushed profiles, firmware accepted Recurring Weekly profiles but miscomputed schedule period offsets. `GetCompositeSchedule` returned wrong limits. *Fixed: switched to Absolute profiles with heartbeat-driven re-push.*
3. After fix #2, two Absolute profiles at the same stackLevel=60 caused the firmware to keep both and apply the HIGHER limit (32A) instead of replacing per OCPP spec. *Fixed: merged all active profiles into a single Absolute profile with min(effectiveLimits).*

**Additional fix:** When a contributing profile is disabled, the stale-clear removed the merged OCPP profile but the equivalence check falsely skipped re-pushing (remaining profile's individual fingerprint unchanged). *Fixed: force re-push whenever staleStates.length > 0.*

**Verification:** Both directions tested on production — disable profile (6kW→7.68kW) and re-enable (7.68kW→6kW) — with log evidence of explicit merged re-push, not accidental uncapping.

**Rules added:** CLAUDE.md rules 8-11 under "Smart Charging (Firmware)".
