/**
 * SiteFleetPolicies — Operator UI for managing FleetPolicy rows scoped to a
 * single site. TASK-0208 Phase 2.5 PR-B.
 *
 * Features:
 *   - List policies (any status) for the site
 *   - Create / edit via single modal form (edit blocked while ENABLED — UI
 *     shows tooltip "Disable policy before editing.")
 *   - Enable / disable / delete row actions
 *   - "Preview now" button in the form → calls advisory preview endpoint
 *   - Field-level validation errors from API surfaced inline
 *   - Top-level blocking error banner on failed enable
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createApiClient,
  type FleetPolicy,
  type FleetPolicyFieldError,
  type FleetPolicyPreview,
  type FleetWindow,
} from '../../api/client';
import { useToken } from '../../auth/TokenContext';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type FormState = {
  name: string;
  idTagPrefix: string;
  maxAmps: string;
  ocppStackLevel: string;
  windows: FleetWindow[];
  notes: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  idTagPrefix: '',
  maxAmps: '32',
  ocppStackLevel: '90',
  windows: [{ day: 1, start: '09:00', end: '17:00' }],
  notes: '',
};

function policyToForm(p: FleetPolicy): FormState {
  const raw = (p.windowsJson as { windows?: FleetWindow[] })?.windows ?? [];
  return {
    name: p.name,
    idTagPrefix: p.idTagPrefix,
    maxAmps: String(p.maxAmps),
    ocppStackLevel: String(p.ocppStackLevel),
    windows: raw.length > 0 ? raw : [{ day: 1, start: '09:00', end: '17:00' }],
    notes: p.notes ?? '',
  };
}

function summarizeWindows(p: FleetPolicy): string {
  const raw = (p.windowsJson as { windows?: FleetWindow[] })?.windows ?? [];
  if (raw.length === 0) return '—';
  if (raw.length === 1) {
    const w = raw[0];
    return `${DAY_NAMES[w.day]} ${w.start}–${w.end}`;
  }
  return `${raw.length} windows`;
}

function statusPill(s: FleetPolicy['status']): JSX.Element {
  const cls = s === 'ENABLED'
    ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
    : s === 'DRAFT'
      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300'
      : 'bg-gray-200 text-gray-700 dark:bg-slate-700 dark:text-slate-300';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{s}</span>;
}

export default function SiteFleetPolicies({ siteId }: { siteId: string }) {
  const getToken = useToken();
  const [policies, setPolicies] = useState<FleetPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [modalMode, setModalMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [editing, setEditing] = useState<FleetPolicy | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formBlockingError, setFormBlockingError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<FleetPolicyPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FleetPolicy | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = await getToken();
      const rows = await createApiClient(token).listFleetPolicies(siteId);
      setPolicies(rows);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load fleet policies');
    } finally {
      setLoading(false);
    }
  }, [getToken, siteId]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormBlockingError(null);
    setPreview(null);
    setPreviewError(null);
    setModalMode('create');
  };

  const openEdit = (p: FleetPolicy) => {
    if (p.status === 'ENABLED') return; // guarded at button level, double-check here
    setEditing(p);
    setForm(policyToForm(p));
    setFieldErrors({});
    setFormBlockingError(null);
    setPreview(null);
    setPreviewError(null);
    setModalMode('edit');
  };

  const closeModal = () => {
    setModalMode('closed');
    setEditing(null);
    setFieldErrors({});
    setFormBlockingError(null);
    setPreview(null);
    setPreviewError(null);
  };

  const buildBody = () => ({
    name: form.name.trim(),
    idTagPrefix: form.idTagPrefix.trim().toUpperCase(),
    maxAmps: Number(form.maxAmps),
    ocppStackLevel: Number(form.ocppStackLevel),
    windowsJson: { windows: form.windows },
    notes: form.notes.trim() || null,
  });

  const handleApiErrors = (e: unknown): { fieldErrors: Record<string, string>; blocking: string | null } => {
    const err = e as { payload?: { errors?: FleetPolicyFieldError[]; message?: string; error?: string }; message?: string };
    const payload = err?.payload;
    const fe: Record<string, string> = {};
    if (payload?.errors && Array.isArray(payload.errors)) {
      for (const item of payload.errors) {
        if (item.field && !fe[item.field]) fe[item.field] = item.message;
      }
    }
    const blocking = (payload?.message ?? payload?.error ?? err?.message) ?? null;
    return { fieldErrors: fe, blocking };
  };

  const saveForm = async () => {
    setSaving(true);
    setFieldErrors({});
    setFormBlockingError(null);
    try {
      const token = await getToken();
      const api = createApiClient(token);
      const body = buildBody();
      if (modalMode === 'create') {
        await api.createFleetPolicy(siteId, body);
      } else if (editing) {
        await api.updateFleetPolicy(editing.id, body);
      }
      closeModal();
      await load();
    } catch (e: unknown) {
      const { fieldErrors: fe, blocking } = handleApiErrors(e);
      setFieldErrors(fe);
      // Only surface top-level blocking when there are no field-level errors,
      // otherwise it's redundant noise.
      setFormBlockingError(Object.keys(fe).length === 0 ? blocking : null);
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    // Preview against the CURRENTLY SAVED policy — we don't preview unsaved
    // drafts because the endpoint is tied to a stored row. If the operator is
    // still editing, we say so.
    setPreview(null);
    setPreviewError(null);
    if (!editing) {
      setPreviewError('Save the policy first to preview windows against the site timezone.');
      return;
    }
    try {
      const token = await getToken();
      const result = await createApiClient(token).previewFleetPolicy(editing.id);
      setPreview(result);
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? e.message : 'Preview failed');
    }
  };

  const doEnable = async (p: FleetPolicy) => {
    setRowBusy(p.id);
    setListError(null);
    try {
      const token = await getToken();
      await createApiClient(token).enableFleetPolicy(p.id);
      await load();
    } catch (e: unknown) {
      const { fieldErrors: fe, blocking } = handleApiErrors(e);
      // If enable failed validation, open the edit modal with the field errors
      // surfaced and a top-level blocking banner.
      if (Object.keys(fe).length > 0) {
        setEditing(p);
        setForm(policyToForm(p));
        setFieldErrors(fe);
        setFormBlockingError(blocking ?? 'Cannot enable — policy fails validation. Fix the highlighted fields and try again.');
        setPreview(null);
        setPreviewError(null);
        setModalMode('edit');
        // NOTE: server rejected DRAFT/DISABLED state change, policy is NOT enabled.
        // We force-open the edit modal instead of just flashing an error because
        // validation failures always require a field edit to resolve.
      } else {
        setListError(blocking ?? (e instanceof Error ? e.message : 'Enable failed'));
      }
    } finally {
      setRowBusy(null);
    }
  };

  const doDisable = async (p: FleetPolicy) => {
    setRowBusy(p.id);
    setListError(null);
    try {
      const token = await getToken();
      await createApiClient(token).disableFleetPolicy(p.id);
      await load();
    } catch (e: unknown) {
      setListError(e instanceof Error ? e.message : 'Disable failed');
    } finally {
      setRowBusy(null);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setRowBusy(deleteTarget.id);
    setListError(null);
    try {
      const token = await getToken();
      await createApiClient(token).deleteFleetPolicy(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (e: unknown) {
      const err = e as { payload?: { message?: string; code?: string } };
      setListError(err?.payload?.message ?? (e instanceof Error ? e.message : 'Delete failed'));
      setDeleteTarget(null);
    } finally {
      setRowBusy(null);
    }
  };

  const modalOpen = modalMode !== 'closed';

  const canSave = useMemo(() => {
    if (saving) return false;
    if (!form.name.trim()) return false;
    if (!form.idTagPrefix.trim()) return false;
    if (!form.maxAmps) return false;
    return true;
  }, [saving, form.name, form.idTagPrefix, form.maxAmps]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Fleet Policies</h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Drivers whose idTag matches a policy prefix will be gated to 0 A outside the allowed window and
            capped at <code className="rounded bg-gray-100 px-1 text-xs dark:bg-slate-800">maxAmps</code> inside it.
            Requires <code className="rounded bg-gray-100 px-1 text-xs dark:bg-slate-800">FLEET_GATED_SESSIONS_ENABLED</code> at runtime.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + New Policy
        </button>
      </div>

      {listError && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {listError}
        </div>
      )}

      {loadError && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-slate-400">Loading…</div>
      ) : policies.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-slate-700 dark:text-slate-400">
          No fleet policies yet. Create one to gate drivers by idTag prefix.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900/50">
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Prefix</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Max A</th>
                <th className="px-4 py-2">Windows</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {policies.map((p) => {
                const editLocked = p.status === 'ENABLED';
                const busy = rowBusy === p.id;
                return (
                  <tr key={p.id} className="bg-white dark:bg-slate-900">
                    <td className="px-4 py-2 font-medium text-gray-900 dark:text-slate-100">{p.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-slate-300">{p.idTagPrefix}</td>
                    <td className="px-4 py-2">{statusPill(p.status)}</td>
                    <td className="px-4 py-2 text-gray-700 dark:text-slate-300">{p.maxAmps}</td>
                    <td className="px-4 py-2 text-gray-600 dark:text-slate-400">{summarizeWindows(p)}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-slate-500">
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => openEdit(p)}
                          disabled={editLocked || busy}
                          title={editLocked ? 'Disable policy before editing.' : 'Edit'}
                          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        {p.status === 'ENABLED' ? (
                          <button
                            onClick={() => doDisable(p)}
                            disabled={busy}
                            className="rounded border border-amber-400 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                          >
                            {busy ? '…' : 'Disable'}
                          </button>
                        ) : (
                          <button
                            onClick={() => doEnable(p)}
                            disabled={busy}
                            className="rounded border border-green-500 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-700 dark:text-green-300 dark:hover:bg-green-900/30"
                          >
                            {busy ? '…' : 'Enable'}
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteTarget(p)}
                          disabled={busy}
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                        >
                          Delete
                        </button>
                      </div>
                      {editLocked && (
                        <div className="mt-1 text-[10px] italic text-gray-400 dark:text-slate-500">
                          Disable policy before editing.
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Edit / Create Modal ── */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-gray-300 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-slate-100">
              {modalMode === 'create' ? 'New Fleet Policy' : `Edit: ${editing?.name ?? ''}`}
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">
              Status transitions are handled from the list view. Creates land as DRAFT; edits apply immediately.
            </p>

            {formBlockingError && (
              <div className="mt-4 rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
                <div className="font-semibold">Request blocked</div>
                <div className="mt-1">{formBlockingError}</div>
              </div>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField label="Name" error={fieldErrors.name}>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  maxLength={80}
                />
              </FormField>
              <FormField
                label="idTag Prefix"
                error={fieldErrors.idTagPrefix}
                help="Uppercase only. E.g. FLEET-ACME-"
              >
                <input
                  type="text"
                  value={form.idTagPrefix}
                  onChange={(e) => setForm({ ...form, idTagPrefix: e.target.value.toUpperCase() })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  maxLength={32}
                />
              </FormField>
              <FormField label="Max Amps (6–80)" error={fieldErrors.maxAmps}>
                <input
                  type="number"
                  value={form.maxAmps}
                  min={6}
                  max={80}
                  onChange={(e) => setForm({ ...form, maxAmps: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </FormField>
              <FormField label="OCPP Stack Level (51–98)" error={fieldErrors.ocppStackLevel}>
                <input
                  type="number"
                  value={form.ocppStackLevel}
                  min={51}
                  max={98}
                  onChange={(e) => setForm({ ...form, ocppStackLevel: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </FormField>
            </div>

            <div className="mt-4">
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Windows (site-local time)</label>
              {fieldErrors.windowsJson && (
                <div className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.windowsJson}</div>
              )}
              <div className="mt-2 space-y-2">
                {form.windows.map((w, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      value={w.day}
                      onChange={(e) => {
                        const next = [...form.windows];
                        next[i] = { ...w, day: Number(e.target.value) };
                        setForm({ ...form, windows: next });
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    >
                      {DAY_NAMES.map((n, d) => <option key={d} value={d}>{n}</option>)}
                    </select>
                    <input
                      type="time"
                      value={w.start}
                      onChange={(e) => {
                        const next = [...form.windows];
                        next[i] = { ...w, start: e.target.value };
                        setForm({ ...form, windows: next });
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    />
                    <span className="text-sm text-gray-500">–</span>
                    <input
                      type="time"
                      value={w.end}
                      onChange={(e) => {
                        const next = [...form.windows];
                        next[i] = { ...w, end: e.target.value };
                        setForm({ ...form, windows: next });
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = form.windows.filter((_, idx) => idx !== i);
                        setForm({ ...form, windows: next });
                      }}
                      className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setForm({ ...form, windows: [...form.windows, { day: 1, start: '09:00', end: '17:00' }] })}
                  className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  + Add Window
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">
                Overnight windows are not supported — split into two adjacent days.
              </p>
            </div>

            <div className="mt-4">
              <FormField label="Notes (optional)" error={fieldErrors.notes}>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  maxLength={2000}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </FormField>
            </div>

            {/* Preview section (edit mode only — preview hits saved row) */}
            {modalMode === 'edit' && (
              <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/50">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-gray-700 dark:text-slate-300">Preview (advisory)</div>
                  <button
                    type="button"
                    onClick={runPreview}
                    className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    Preview now
                  </button>
                </div>
                {previewError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{previewError}</div>}
                {preview && (
                  <div className="mt-2 text-xs text-gray-700 dark:text-slate-300">
                    At <span className="font-mono">{new Date(preview.at).toLocaleString()}</span>
                    {preview.timeZone && <> (site tz <span className="font-mono">{preview.timeZone}</span>)</>}
                    {': '}
                    <span className={preview.active ? 'font-semibold text-green-700 dark:text-green-400' : 'font-semibold text-amber-700 dark:text-amber-400'}>
                      {preview.intendedMode === 'ALLOW' ? 'Would ALLOW' : 'Would GATE'}
                    </span>
                    {preview.matchedWindow && (
                      <> — matched {DAY_NAMES[preview.matchedWindow.day]} {preview.matchedWindow.start}–{preview.matchedWindow.end}</>
                    )}
                    {preview.nextTransitionAt && (
                      <div className="mt-1 text-gray-500">
                        Next transition: {new Date(preview.nextTransitionAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={closeModal}
                disabled={saving}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={saveForm}
                disabled={!canSave}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : modalMode === 'create' ? 'Create' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-300 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Delete Fleet Policy</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-slate-400">
              Delete <span className="font-semibold text-gray-900 dark:text-slate-100">{deleteTarget.name}</span>?
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">
              The API rejects deletion if any past session referenced this policy — disable it instead.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={rowBusy === deleteTarget.id}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={rowBusy === deleteTarget.id}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rowBusy === deleteTarget.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FormField({
  label,
  error,
  help,
  children,
}: {
  label: string;
  error?: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-slate-300">{label}</label>
      {children}
      {help && !error && (
        <div className="mt-1 text-xs text-gray-500 dark:text-slate-500">{help}</div>
      )}
      {error && (
        <div className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}
    </div>
  );
}
