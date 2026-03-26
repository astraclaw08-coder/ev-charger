import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type AdminInAppNotificationCampaign } from '../api/client';
import { useToken } from '../auth/TokenContext';

type TargetMode = 'all' | 'user_ids' | 'emails';

export default function Notifications() {
  const { token } = useToken();
  const api = useMemo(() => createApiClient(token), [token]);

  const [targetMode, setTargetMode] = useState<TargetMode>('all');
  const [userIdsRaw, setUserIdsRaw] = useState('');
  const [emailsRaw, setEmailsRaw] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [actionLabel, setActionLabel] = useState('');
  const [actionUrl, setActionUrl] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [audit, setAudit] = useState<AdminInAppNotificationCampaign[]>([]);
  const [error, setError] = useState<string | null>(null);

  const userIds = userIdsRaw.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  const emails = emailsRaw.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);

  const isValid = title.trim().length > 0
    && message.trim().length > 0
    && (targetMode === 'all' || (targetMode === 'user_ids' ? userIds.length > 0 : emails.length > 0));

  async function loadAudit() {
    setError(null);
    try {
      const rows = await api.listInAppNotificationAudit(50);
      setAudit(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notification audit');
    }
  }

  useEffect(() => {
    void loadAudit();
  }, []);

  async function send() {
    if (!isValid || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await api.sendInAppNotification({
        targetMode,
        userIds: targetMode === 'user_ids' ? userIds : undefined,
        emails: targetMode === 'emails' ? emails : undefined,
        title: title.trim(),
        message: message.trim(),
        actionLabel: actionLabel.trim() || undefined,
        actionUrl: actionUrl.trim() || undefined,
        deepLink: deepLink.trim() || undefined,
        reason: reason.trim() || undefined,
      });

      window.alert(`Notification sent to ${response.deliveryCount} user(s).`);
      setTitle('');
      setMessage('');
      setActionLabel('');
      setActionUrl('');
      setDeepLink('');
      setReason('');
      setUserIdsRaw('');
      setEmailsRaw('');
      setTargetMode('all');
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send notification');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <a href="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</a>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Notifications</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-gray-900 dark:text-slate-100">Notifications</h1>
      </div>

      <section className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-slate-100">In-app notifications</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Compose and send custom push-style in-app messages to EV users.</p>

        {error ? <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Targeting
            <select className="mt-1 w-full rounded border px-3 py-2" value={targetMode} onChange={(e) => setTargetMode(e.target.value as TargetMode)}>
              <option value="all">All users</option>
              <option value="user_ids">Specific user IDs</option>
              <option value="emails">Specific emails</option>
            </select>
          </label>

          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Reason (optional)
            <input className="mt-1 w-full rounded border px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. planned maintenance alert" />
          </label>
        </div>

        {targetMode === 'user_ids' ? (
          <label className="mt-4 block text-sm text-gray-700 dark:text-slate-300">
            User IDs (comma or newline separated)
            <textarea className="mt-1 h-24 w-full rounded border px-3 py-2" value={userIdsRaw} onChange={(e) => setUserIdsRaw(e.target.value)} />
          </label>
        ) : null}

        {targetMode === 'emails' ? (
          <label className="mt-4 block text-sm text-gray-700 dark:text-slate-300">
            Emails (comma or newline separated)
            <textarea className="mt-1 h-24 w-full rounded border px-3 py-2" value={emailsRaw} onChange={(e) => setEmailsRaw(e.target.value)} />
          </label>
        ) : null}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Title
            <input className="mt-1 w-full rounded border px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </label>
          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Action label (optional)
            <input className="mt-1 w-full rounded border px-3 py-2" value={actionLabel} onChange={(e) => setActionLabel(e.target.value)} maxLength={50} placeholder="View details" />
          </label>
        </div>

        <label className="mt-4 block text-sm text-gray-700 dark:text-slate-300">
          Message
          <textarea className="mt-1 h-28 w-full rounded border px-3 py-2" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
        </label>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Action URL (optional)
            <input className="mt-1 w-full rounded border px-3 py-2" value={actionUrl} onChange={(e) => setActionUrl(e.target.value)} placeholder="https://example.com/help" />
          </label>
          <label className="block text-sm text-gray-700 dark:text-slate-300">
            Deep link (optional)
            <input className="mt-1 w-full rounded border px-3 py-2" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="evcharger://sessions" />
          </label>
        </div>

        <button className="mt-4 rounded border px-4 py-2 text-sm font-medium disabled:opacity-60" disabled={!isValid || sending} onClick={send}>
          {sending ? 'Sending…' : 'Send notification'}
        </button>
      </section>

      <section className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Send audit trail</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Most recent campaigns and recipient counts.</p>

        <div className="mt-3 space-y-2">
          {audit.length === 0 ? (
            <div className="rounded border border-dashed px-3 py-4 text-sm text-gray-500 dark:text-slate-400">No campaigns sent yet.</div>
          ) : audit.map((row) => (
            <div key={row.id} className="rounded border border-gray-300 dark:border-slate-700 px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-gray-900 dark:text-slate-100">{row.title}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400">{new Date(row.sentAt).toLocaleString()} · {row.deliveryCount} recipients</div>
              </div>
              <div className="mt-1 text-gray-700 dark:text-slate-300">{row.message}</div>
              <div className="mt-2 text-xs text-gray-500 dark:text-slate-400">mode={row.targetMode} · operator={row.createdByOperatorId}</div>
              {row.actionLabel || row.actionUrl || row.deepLink ? (
                <div className="mt-1 text-xs text-gray-500 dark:text-slate-400">actionLabel={row.actionLabel || '-'} · actionUrl={row.actionUrl || '-'} · deepLink={row.deepLink || '-'}</div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
