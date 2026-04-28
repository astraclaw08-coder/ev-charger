/**
 * Charger Fleet-Auto config panel (TASK-0208 Phase 3 Slice B).
 *
 * Per-connector operator controls for:
 *   - chargingMode: PUBLIC | FLEET_AUTO
 *   - fleetPolicyId: assignment from same-site policies
 *   - fleetAutoRolloutEnabled: per-connector override of Site rollout flag
 *
 * Mounts inside `ChargerDetail` as a small panel under the existing controls.
 * No runtime side-effects — wires straight to PATCH /chargers/:id/connectors/:n.
 * Slice C reads these fields at runtime via the two-tier rollout gate.
 *
 * UX shortcuts (kept deliberately minimal — Slice B scope is "operator/API
 * config UX only"; we don't go beyond what's needed for validation):
 *   - Each connector row is independent (own Save button + per-row error).
 *   - Reload on success keeps the panel in sync with backend writes.
 *   - "Inherit site" appears as the default for the rollout-override
 *     dropdown when the connector value is null.
 *   - DRAFT/DISABLED policies are listed alongside ENABLED so an operator
 *     can pre-assign a policy that's still being authored. Slice C will
 *     refuse to auto-start unless the assigned policy is ENABLED, so this
 *     pre-assignment is safe.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToken } from '../../auth/TokenContext';
import {
  createApiClient,
  type ChargingMode,
  type ConnectorFleetConfig as ConnectorFleetRow,
  type FleetPolicy,
} from '../../api/client';

type RolloutChoice = 'inherit' | 'enabled' | 'disabled';

function toRolloutChoice(v: boolean | null | undefined): RolloutChoice {
  if (v === true) return 'enabled';
  if (v === false) return 'disabled';
  return 'inherit';
}

function fromRolloutChoice(c: RolloutChoice): boolean | null {
  if (c === 'enabled') return true;
  if (c === 'disabled') return false;
  return null;
}

type RowState = {
  chargingMode: ChargingMode;
  fleetPolicyId: string | null;
  rollout: RolloutChoice;
};

function rowFromConnector(c: ConnectorFleetRow): RowState {
  return {
    chargingMode: c.chargingMode,
    fleetPolicyId: c.fleetPolicyId,
    rollout: toRolloutChoice(c.fleetAutoRolloutEnabled),
  };
}

export interface ChargerFleetConfigProps {
  chargerId: string;
  siteId: string | null;
  connectors: ConnectorFleetRow[];
  /** Called after a successful save so the parent can re-fetch. */
  onSaved?: () => void;
}

export default function ChargerFleetConfig(props: ChargerFleetConfigProps) {
  const { chargerId, siteId, connectors, onSaved } = props;
  const getToken = useToken();

  const [policies, setPolicies] = useState<FleetPolicy[]>([]);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const sortedConnectors = useMemo(
    () => [...connectors].sort((a, b) => a.connectorId - b.connectorId),
    [connectors],
  );

  // Re-seed local edits whenever the upstream connector list changes
  // (e.g. after a parent reload from a sibling save).
  useEffect(() => {
    const seeded: Record<string, RowState> = {};
    for (const c of sortedConnectors) seeded[c.id] = rowFromConnector(c);
    setRows(seeded);
  }, [sortedConnectors]);

  const loadPolicies = useCallback(async () => {
    if (!siteId) {
      setPolicies([]);
      return;
    }
    setPoliciesError(null);
    try {
      const token = await getToken();
      const list = await createApiClient(token).listFleetPolicies(siteId);
      setPolicies(list);
    } catch (e) {
      setPoliciesError(e instanceof Error ? e.message : 'Failed to load fleet policies');
    }
  }, [getToken, siteId]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const updateRow = (connectorRowId: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [connectorRowId]: { ...prev[connectorRowId], ...patch } }));
  };

  const save = async (c: ConnectorFleetRow) => {
    const row = rows[c.id];
    if (!row) return;

    // Confirmation gate when the operator is enabling rollout for this
    // connector (false/inherit → true). Once Slice C ships and the
    // global env kill switch is ON, this flips runtime behavior — make
    // sure it isn't an accidental click.
    const enablingRollout =
      row.rollout === 'enabled' && c.fleetAutoRolloutEnabled !== true;
    if (enablingRollout) {
      const confirmed = window.confirm(
        'Enabling this rollout flag may allow Fleet-Auto sessions to auto-start ' +
        'on this connector when the global kill switch is ON.\n\n' +
        'Continue?',
      );
      if (!confirmed) return;
    }

    setSavingId(c.id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[c.id];
      return next;
    });
    try {
      const token = await getToken();
      // Only include fields that actually changed vs the upstream connector
      // — keeps audit log clean and avoids no-op AdminAuditEvent rows.
      const body: {
        chargingMode?: ChargingMode;
        fleetPolicyId?: string | null;
        fleetAutoRolloutEnabled?: boolean | null;
      } = {};
      if (row.chargingMode !== c.chargingMode) {
        body.chargingMode = row.chargingMode;
      }
      if (row.fleetPolicyId !== c.fleetPolicyId) {
        body.fleetPolicyId = row.fleetPolicyId;
      }
      const desiredRollout = fromRolloutChoice(row.rollout);
      if (c.fleetAutoRolloutEnabled !== desiredRollout) {
        body.fleetAutoRolloutEnabled = desiredRollout;
      }
      if (Object.keys(body).length === 0) {
        // Nothing changed; treat as success.
        return;
      }
      await createApiClient(token).updateConnectorFleetConfig(chargerId, c.connectorId, body);
      onSaved?.();
    } catch (e) {
      const err = e as { payload?: { errors?: Array<{ field: string; message: string }>; message?: string }; message?: string };
      const fieldMsg = err.payload?.errors?.[0]?.message;
      setRowError((prev) => ({
        ...prev,
        [c.id]: fieldMsg ?? err.payload?.message ?? err.message ?? 'Save failed',
      }));
    } finally {
      setSavingId(null);
    }
  };

  if (sortedConnectors.length === 0) {
    return (
      <div className="rounded-md border border-gray-200 dark:border-slate-700 p-3 text-xs text-gray-500 dark:text-slate-400">
        No connectors on this charger.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
          Fleet-Auto config
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">
          Connector-level Fleet-Auto activation. Slice C will read these fields at runtime
          and auto-start fleet sessions on plug-in when the two-tier rollout gate is satisfied.
          Today these settings are persisted only — no runtime auto-start yet.
        </p>
        {policiesError && (
          <div className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300">
            {policiesError}
          </div>
        )}
      </div>

      <div className="space-y-2">
        {sortedConnectors.map((c) => {
          const row = rows[c.id] ?? rowFromConnector(c);
          const err = rowError[c.id];
          const saving = savingId === c.id;
          return (
            <div
              key={c.id}
              className="rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3"
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="text-sm font-medium text-gray-700 dark:text-slate-200">
                  Connector #{c.connectorId}
                </div>
                <div className="grid grow grid-cols-1 gap-2 md:grid-cols-3">
                  <label className="block text-xs">
                    <span className="text-gray-600 dark:text-slate-400">Charging mode</span>
                    <select
                      value={row.chargingMode}
                      onChange={(e) => updateRow(c.id, { chargingMode: e.target.value as ChargingMode })}
                      disabled={saving}
                      className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    >
                      <option value="PUBLIC">Public</option>
                      <option value="FLEET_AUTO">Fleet auto-start</option>
                    </select>
                  </label>
                  <label className="block text-xs">
                    <span className="text-gray-600 dark:text-slate-400">Fleet policy</span>
                    <select
                      value={row.fleetPolicyId ?? ''}
                      onChange={(e) =>
                        updateRow(c.id, {
                          fleetPolicyId: e.target.value === '' ? null : e.target.value,
                        })
                      }
                      disabled={saving || row.chargingMode !== 'FLEET_AUTO'}
                      className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 disabled:opacity-50"
                    >
                      <option value="">(none)</option>
                      {policies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs">
                    <span className="text-gray-600 dark:text-slate-400">Rollout override</span>
                    <select
                      value={row.rollout}
                      onChange={(e) => updateRow(c.id, { rollout: e.target.value as RolloutChoice })}
                      disabled={saving}
                      className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    >
                      <option value="inherit">Inherit site</option>
                      <option value="enabled">Enabled (override)</option>
                      <option value="disabled">Disabled (override)</option>
                    </select>
                  </label>
                </div>
                <button
                  onClick={() => void save(c)}
                  disabled={saving}
                  className="h-9 whitespace-nowrap rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
              {err && (
                <div className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300">
                  {err}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
