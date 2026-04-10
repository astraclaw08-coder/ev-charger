/**
 * Receipt email formatting and sending.
 *
 * Responsible for:
 * - Loading session + user + billing snapshot data
 * - Checking eligibility (has email, has snapshot, session completed, not already sent)
 * - Formatting HTML + text receipt matching the in-app receipt layout
 * - Sending via sendEmail()
 * - Setting receiptSentAt on snapshot
 */
import { prisma } from '@ev-charger/shared';
import { sendEmail } from './email';

// ── Types ────────────────────────────────────────────────────────────────

type EnergySegment = {
  startTime: string;
  endTime: string;
  ratePerKwh: number;
  kwh: number;
  amountUsd: number;
};

type IdleSegment = {
  startTime: string;
  endTime: string;
  ratePerMin: number;
  minutes: number;
  amountUsd: number;
  graceNote: string | null;
};

type ReceiptData = {
  driverName: string | null;
  driverEmail: string;
  transactionId: number | null;
  siteName: string;
  chargerLabel: string;        // serialNumber or ocppId
  plugInAt: string;            // formatted full datetime
  plugOutAt: string | null;    // formatted full datetime
  energySegments: EnergySegment[];
  energySubtotalUsd: number;
  idleSegments: IdleSegment[];
  idleSubtotalUsd: number;
  activationAmountUsd: number;
  grossAmountUsd: number;
  paymentStatus: string | null;
  siteTimeZone: string;
};

type ReceiptResult = {
  sent: boolean;
  reason?: string;
  html?: string;        // populated for preview mode
};

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Load session data, check eligibility, format and send receipt email.
 * @param preview If true, return rendered HTML without sending or mutating.
 */
export async function processReceiptEmail(
  sessionId: string,
  opts?: { preview?: boolean },
): Promise<ReceiptResult> {
  const preview = opts?.preview ?? false;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      billingSnapshot: true,
      payment: { select: { status: true } },
      connector: {
        include: {
          charger: {
            include: {
              site: { select: { name: true, timeZone: true } },
            },
          },
        },
      },
    },
  });

  if (!session) {
    console.log(`[Receipt] skipped: session not found sessionId=${sessionId}`);
    return { sent: false, reason: 'session_not_found' };
  }

  if (session.status !== 'COMPLETED') {
    console.log(`[Receipt] skipped: session not completed sessionId=${sessionId} status=${session.status}`);
    return { sent: false, reason: 'session_not_completed' };
  }

  const snapshot = session.billingSnapshot;
  if (!snapshot) {
    console.log(`[Receipt] skipped: no billing snapshot sessionId=${sessionId}`);
    return { sent: false, reason: 'no_billing_snapshot' };
  }

  // Dedupe guard — skip if already sent (unless preview)
  if (!preview && snapshot.receiptSentAt) {
    console.log(`[Receipt] skipped: already sent sessionId=${sessionId} sentAt=${snapshot.receiptSentAt.toISOString()}`);
    return { sent: false, reason: 'already_sent' };
  }

  const driverEmail = session.user?.email;
  if (!driverEmail) {
    console.log(`[Receipt] skipped: no driver email sessionId=${sessionId} userId=${session.userId}`);
    return { sent: false, reason: 'no_driver_email' };
  }

  // Build receipt data from snapshot
  const charger = session.connector?.charger as any;
  const site = charger?.site;
  const siteTimeZone = snapshot.siteTimeZone || site?.timeZone || 'America/Los_Angeles';
  const breakdown = snapshot.billingBreakdownJson as Record<string, any> | null;
  const gracePeriodMin = breakdown?.gracePeriodMin ?? snapshot.gracePeriodMin ?? 0;

  const receiptData: ReceiptData = {
    driverName: session.user?.name ?? null,
    driverEmail,
    transactionId: session.transactionId,
    siteName: site?.name || 'Unknown Site',
    chargerLabel: charger?.serialNumber || charger?.ocppId || charger?.name || 'Unknown Charger',
    plugInAt: formatDateTime(snapshot.chargingStartedAt || session.startedAt, siteTimeZone),
    plugOutAt: snapshot.plugOutAt ? formatDateTime(snapshot.plugOutAt, siteTimeZone) : null,
    energySegments: extractEnergySegments(breakdown, siteTimeZone),
    energySubtotalUsd: breakdown?.totals?.energyUsd ?? breakdown?.energy?.totalUsd ?? snapshot.energyAmountUsd ?? 0,
    idleSegments: extractIdleSegments(breakdown, siteTimeZone, gracePeriodMin),
    idleSubtotalUsd: breakdown?.totals?.idleUsd ?? breakdown?.idle?.totalUsd ?? snapshot.idleAmountUsd ?? 0,
    activationAmountUsd: breakdown?.totals?.activationUsd ?? breakdown?.activation?.totalUsd ?? snapshot.activationAmountUsd ?? 0,
    grossAmountUsd: snapshot.grossAmountUsd ?? 0,
    paymentStatus: session.payment?.status ?? null,
    siteTimeZone,
  };

  const html = formatReceiptHtml(receiptData);
  const text = formatReceiptText(receiptData);
  const subject = receiptData.transactionId
    ? `Lumeo Charging Receipt #${receiptData.transactionId}`
    : `Lumeo Charging Receipt`;

  if (preview) {
    return { sent: false, reason: 'preview', html };
  }

  // Send
  const ok = await sendEmail({ to: driverEmail, subject, text, html });

  if (ok) {
    // Mark as sent (dedupe guard for future triggers)
    try {
      await prisma.sessionBillingSnapshot.update({
        where: { sessionId },
        data: { receiptSentAt: new Date() },
      });
    } catch (err) {
      console.error(`[Receipt] failed to set receiptSentAt sessionId=${sessionId}:`, err);
    }
    console.log(`[Receipt] sent sessionId=${sessionId} to=${driverEmail}`);
    return { sent: true };
  }

  console.error(`[Receipt] failed sessionId=${sessionId} to=${driverEmail}`);
  return { sent: false, reason: 'send_failed' };
}

// ── Segment extraction ───────────────────────────────────────────────────

function extractEnergySegments(breakdown: Record<string, any> | null, tz: string): EnergySegment[] {
  const segments = breakdown?.energy?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return [];
  return segments.map((seg: any) => ({
    startTime: formatTime(seg.startedAt, tz),
    endTime: formatTime(seg.endedAt, tz),
    ratePerKwh: Number(seg.pricePerKwhUsd) || 0,
    kwh: Number(seg.kwh) || 0,
    amountUsd: Number(seg.energyAmountUsd) || 0,
  }));
}

function extractIdleSegments(breakdown: Record<string, any> | null, tz: string, gracePeriodMin: number): IdleSegment[] {
  const segments = breakdown?.idle?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return [];
  // Filter out zero-minute segments (matches portal logic)
  return segments
    .filter((seg: any) => (Number(seg.minutes) || 0) > 0)
    .map((seg: any, idx: number) => ({
      startTime: formatTime(seg.startedAt, tz),
      endTime: formatTime(seg.endedAt, tz),
      ratePerMin: Number(seg.idleFeePerMinUsd) || 0,
      minutes: Number(seg.minutes) || 0,
      amountUsd: Number(seg.amountUsd) || 0,
      graceNote: idx === 0 && gracePeriodMin > 0 ? `(${gracePeriodMin} min grace)` : null,
    }));
}

// ── Formatting helpers ───────────────────────────────────────────────────

function formatTime(iso: string | Date | null | undefined, tz: string): string {
  if (!iso) return '--';
  try {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

function formatDateTime(date: string | Date | null | undefined, tz: string): string {
  if (!date) return '--';
  try {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString('en-US', {
      timeZone: tz,
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(date);
  }
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ── HTML receipt line helper ─────────────────────────────────────────────

function receiptLineHtml(label: string, value: string, opts?: { emphasize?: boolean; emphasizeValue?: boolean }): string {
  const labelStyle = opts?.emphasize
    ? 'font-size:14px;font-weight:600;color:#111827;'
    : 'font-size:13px;color:#6b7280;';
  const valueStyle = opts?.emphasize
    ? 'font-size:14px;font-weight:700;color:#111827;text-align:right;'
    : opts?.emphasizeValue
      ? 'font-size:13px;font-weight:600;color:#374151;text-align:right;'
      : 'font-size:13px;color:#374151;text-align:right;';
  return `<tr>
    <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;${labelStyle}">${label}</td>
    <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;${valueStyle}">${value}</td>
  </tr>`;
}

// TODO: host logo at a stable URL — the Vite-hashed filename changes on portal rebuild
const LOGO_URL = 'https://portal.lumeopower.com/assets/lumeo-logo-user-transparent-B55TR_6w.png';

// ── HTML template ────────────────────────────────────────────────────────

function formatReceiptHtml(d: ReceiptData): string {
  const txLabel = d.transactionId ? `#${d.transactionId}` : '';

  // Energy segment rows
  const energyRows = d.energySegments.length > 0
    ? d.energySegments.map((seg) =>
        receiptLineHtml(
          `${seg.startTime} to ${seg.endTime} @ ${usd(seg.ratePerKwh)}/kWh &times; ${seg.kwh.toFixed(3)} kWh`,
          usd(seg.amountUsd),
        )
      ).join('\n')
    : receiptLineHtml('Energy', usd(d.energySubtotalUsd));

  // Idle segment rows
  const idleRows = d.idleSegments.map((seg) => {
    const graceNote = seg.graceNote ? ` ${seg.graceNote}` : '';
    return receiptLineHtml(
      `${seg.startTime} to ${seg.endTime} &times; ${usd(seg.ratePerMin)}/min${graceNote}`,
      usd(seg.amountUsd),
    );
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">

    <!-- Logo -->
    <div style="text-align:center;margin-bottom:24px;">
      <img src="${LOGO_URL}" alt="Lumeo Power" width="140" style="display:block;margin:0 auto;" />
      <p style="font-size:13px;color:#9ca3af;margin:8px 0 0;">Charging Receipt</p>
    </div>

    <!-- Card -->
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

      <!-- Header info -->
      <div style="padding:20px 20px 16px;border-bottom:1px solid #f3f4f6;">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827;">${d.siteName}</p>
        <p style="margin:0 0 2px;font-size:13px;color:#6b7280;">Charger: <span style="font-weight:600;color:#374151;">${d.chargerLabel}</span></p>
        ${txLabel ? `<p style="margin:0;font-size:13px;color:#6b7280;">Transaction: <span style="font-weight:600;color:#374151;">${txLabel}</span></p>` : ''}
      </div>

      <!-- Session Detail -->
      <div style="border-bottom:1px solid #e5e7eb;padding:0;">
        <div style="padding:8px 20px;text-align:center;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Session Detail</div>
        <div style="padding:12px 20px;">
          <table style="width:100%;border-collapse:collapse;">
            ${receiptLineHtml('Plug in', d.plugInAt)}
            ${receiptLineHtml('Plug out', d.plugOutAt ?? '--')}

            ${energyRows}
            ${receiptLineHtml('Energy Subtotal', usd(d.energySubtotalUsd), { emphasizeValue: true })}

            ${idleRows}
            ${receiptLineHtml('Idle Subtotal', usd(d.idleSubtotalUsd), { emphasizeValue: true })}

            ${receiptLineHtml('Activation fee', usd(d.activationAmountUsd), { emphasizeValue: true })}
            ${receiptLineHtml('Total', usd(d.grossAmountUsd), { emphasize: true })}
            ${d.paymentStatus ? receiptLineHtml('Payment', d.paymentStatus) : ''}
          </table>

          <p style="text-align:center;font-size:13px;font-weight:500;color:#6b7280;margin:16px 0 4px;">Thank you for charging with us!</p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:24px;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        Questions? Contact <a href="mailto:support@lumeopower.com" style="color:#6366f1;">support@lumeopower.com</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
      <p style="font-size:11px;color:#d1d5db;margin:0;">
        Lumeo Power &middot; <a href="https://lumeopower.com" style="color:#d1d5db;">lumeopower.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Plain text template ──────────────────────────────────────────────────

function formatReceiptText(d: ReceiptData): string {
  const txLabel = d.transactionId ? ` #${d.transactionId}` : '';

  const lines: string[] = [
    `LUMEO CHARGING RECEIPT${txLabel}`,
    '='.repeat(24 + txLabel.length),
    '',
    d.siteName,
    `Charger: ${d.chargerLabel}`,
    ...(d.transactionId ? [`Transaction: #${d.transactionId}`] : []),
    '',
    '--- Session Detail ---',
    `Plug in:  ${d.plugInAt}`,
    `Plug out: ${d.plugOutAt ?? '--'}`,
    '',
  ];

  // Energy segments
  if (d.energySegments.length > 0) {
    for (const seg of d.energySegments) {
      lines.push(`  ${seg.startTime} to ${seg.endTime} @ ${usd(seg.ratePerKwh)}/kWh x ${seg.kwh.toFixed(3)} kWh = ${usd(seg.amountUsd)}`);
    }
  } else {
    lines.push(`  Energy: ${usd(d.energySubtotalUsd)}`);
  }
  lines.push(`Energy Subtotal: ${usd(d.energySubtotalUsd)}`);
  lines.push('');

  // Idle segments
  if (d.idleSegments.length > 0) {
    for (const seg of d.idleSegments) {
      const graceNote = seg.graceNote ? ` ${seg.graceNote}` : '';
      lines.push(`  ${seg.startTime} to ${seg.endTime} x ${usd(seg.ratePerMin)}/min${graceNote} = ${usd(seg.amountUsd)}`);
    }
  }
  lines.push(`Idle Subtotal: ${usd(d.idleSubtotalUsd)}`);
  lines.push('');

  lines.push(`Activation fee: ${usd(d.activationAmountUsd)}`);
  lines.push('');
  lines.push(`TOTAL: ${usd(d.grossAmountUsd)}`);
  if (d.paymentStatus) {
    lines.push(`Payment: ${d.paymentStatus}`);
  }
  lines.push('');
  lines.push('Thank you for charging with us!');
  lines.push('');
  lines.push('Questions? Contact support@lumeopower.com');
  lines.push('');
  lines.push('Lumeo Power · lumeopower.com');

  return lines.join('\n');
}
