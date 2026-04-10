/**
 * Receipt email formatting and sending.
 *
 * Responsible for:
 * - Loading session + user + billing snapshot data
 * - Checking eligibility (has email, has snapshot, session completed, not already sent)
 * - Formatting HTML + text receipt
 * - Sending via sendEmail()
 * - Setting receiptSentAt on snapshot
 */
import { prisma } from '@ev-charger/shared';
import { sendEmail } from './email';

// ── Types ────────────────────────────────────────────────────────────────

type ReceiptData = {
  driverName: string | null;
  driverEmail: string;
  sessionDate: string;       // formatted date string
  sessionTime: string;       // formatted time string
  siteName: string;
  chargerName: string;       // ocppId or charger name
  durationMinutes: number;
  kwhDelivered: number;
  pricingMode: string;       // 'flat' | 'tou'
  energyAmountUsd: number;
  idleAmountUsd: number;
  activationAmountUsd: number;
  grossAmountUsd: number;
  touSegments: TouSegment[];
  siteTimeZone: string;
};

type TouSegment = {
  windowLabel: string;
  kwh: number;
  ratePerKwh: number;
  amountUsd: number;
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
      connector: {
        include: {
          charger: {
            select: { id: true, ocppId: true, name: true },
            include: {
              site: { select: { name: true, timeZone: true } },
            },
          } as any,
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

  const sessionStart = snapshot.chargingStartedAt || session.startedAt;
  const receiptData: ReceiptData = {
    driverName: session.user?.name ?? null,
    driverEmail,
    sessionDate: sessionStart.toLocaleDateString('en-US', {
      timeZone: siteTimeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    sessionTime: sessionStart.toLocaleTimeString('en-US', {
      timeZone: siteTimeZone,
      hour: 'numeric',
      minute: '2-digit',
    }),
    siteName: site?.name || 'Unknown Site',
    chargerName: charger?.ocppId || charger?.name || 'Unknown Charger',
    durationMinutes: snapshot.durationMinutes ?? 0,
    kwhDelivered: snapshot.kwhDelivered ?? 0,
    pricingMode: snapshot.pricingMode || 'flat',
    energyAmountUsd: snapshot.energyAmountUsd ?? 0,
    idleAmountUsd: snapshot.idleAmountUsd ?? 0,
    activationAmountUsd: snapshot.activationAmountUsd ?? 0,
    grossAmountUsd: snapshot.grossAmountUsd ?? 0,
    touSegments: extractTouSegments(snapshot.billingBreakdownJson),
    siteTimeZone,
  };

  const html = formatReceiptHtml(receiptData);
  const text = formatReceiptText(receiptData);

  if (preview) {
    return { sent: false, reason: 'preview', html };
  }

  // Send
  const ok = await sendEmail({
    to: driverEmail,
    subject: `Lumeo Charging Receipt — ${receiptData.sessionDate}`,
    text,
    html,
  });

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

// ── TOU segment extraction ───────────────────────────────────────────────

function extractTouSegments(breakdownJson: unknown): TouSegment[] {
  if (!breakdownJson || typeof breakdownJson !== 'object') return [];
  const breakdown = breakdownJson as Record<string, unknown>;
  const energy = breakdown.energy as { segments?: Array<Record<string, unknown>> } | undefined;
  if (!energy?.segments?.length) return [];

  return energy.segments.map((seg) => ({
    windowLabel: seg.source === 'tou'
      ? `${formatTime(seg.startedAt as string)} – ${formatTime(seg.endedAt as string)}`
      : 'Flat rate',
    kwh: Number(seg.kwh) || 0,
    ratePerKwh: Number(seg.pricePerKwhUsd) || 0,
    amountUsd: Number(seg.energyAmountUsd) || 0,
  }));
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return 'Less than a minute';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ── HTML template ────────────────────────────────────────────────────────

function formatReceiptHtml(d: ReceiptData): string {
  const greeting = d.driverName ? `Hi ${d.driverName},` : 'Hi,';
  const hasTou = d.pricingMode === 'tou' && d.touSegments.length > 1;

  let touRows = '';
  if (hasTou) {
    touRows = d.touSegments.map((seg) =>
      `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#6b7280;">${seg.windowLabel}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;">${seg.kwh.toFixed(2)} kWh × ${usd(seg.ratePerKwh)}/kWh</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;font-weight:500;">${usd(seg.amountUsd)}</td>
      </tr>`
    ).join('\n');
  }

  const energyRow = hasTou ? '' : `
    <tr>
      <td style="padding:8px 12px;font-size:14px;">Energy</td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;">${d.kwhDelivered.toFixed(2)} kWh</td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;font-weight:500;">${usd(d.energyAmountUsd)}</td>
    </tr>`;

  const idleRow = d.idleAmountUsd > 0 ? `
    <tr>
      <td style="padding:8px 12px;font-size:14px;border-top:1px solid #f3f4f6;">Idle fee</td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;border-top:1px solid #f3f4f6;"></td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;font-weight:500;border-top:1px solid #f3f4f6;">${usd(d.idleAmountUsd)}</td>
    </tr>` : '';

  const activationRow = d.activationAmountUsd > 0 ? `
    <tr>
      <td style="padding:8px 12px;font-size:14px;border-top:1px solid #f3f4f6;">Activation fee</td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;border-top:1px solid #f3f4f6;"></td>
      <td style="padding:8px 12px;font-size:14px;text-align:right;font-weight:500;border-top:1px solid #f3f4f6;">${usd(d.activationAmountUsd)}</td>
    </tr>` : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0;">⚡ Lumeo Power</h1>
      <p style="font-size:13px;color:#9ca3af;margin:4px 0 0;">Charging Receipt</p>
    </div>

    <!-- Card -->
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

      <!-- Session info -->
      <div style="padding:20px 20px 16px;border-bottom:1px solid #f3f4f6;">
        <p style="margin:0 0 4px;font-size:14px;color:#374151;">${greeting}</p>
        <p style="margin:0;font-size:13px;color:#6b7280;">Thanks for charging with Lumeo. Here's your receipt.</p>
      </div>

      <div style="padding:16px 20px;border-bottom:1px solid #f3f4f6;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151;">
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Date</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${d.sessionDate}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Time</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${d.sessionTime}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Location</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${d.siteName}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Charger</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${d.chargerName}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Duration</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${formatDuration(d.durationMinutes)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;">Energy</td>
            <td style="padding:4px 0;text-align:right;font-weight:500;">${d.kwhDelivered.toFixed(2)} kWh</td>
          </tr>
        </table>
      </div>

      <!-- Billing breakdown -->
      <div style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Billing</p>
        <table style="width:100%;border-collapse:collapse;">
          ${hasTou ? `
          <thead>
            <tr>
              <th style="padding:6px 12px;font-size:11px;color:#9ca3af;text-align:left;font-weight:500;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Window</th>
              <th style="padding:6px 12px;font-size:11px;color:#9ca3af;text-align:right;font-weight:500;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Usage</th>
              <th style="padding:6px 12px;font-size:11px;color:#9ca3af;text-align:right;font-weight:500;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Amount</th>
            </tr>
          </thead>
          <tbody>${touRows}</tbody>` : energyRow}
          ${idleRow}
          ${activationRow}
        </table>
      </div>

      <!-- Total -->
      <div style="padding:16px 20px;background:#f9fafb;border-top:2px solid #e5e7eb;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="font-size:16px;font-weight:600;color:#111827;">Total</td>
            <td style="font-size:16px;font-weight:700;color:#111827;text-align:right;">${usd(d.grossAmountUsd)}</td>
          </tr>
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:24px;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        Questions? Contact <a href="mailto:support@lumeopower.com" style="color:#6366f1;">support@lumeopower.com</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
      <p style="font-size:11px;color:#d1d5db;margin:0;">
        Lumeo Power · <a href="https://lumeopower.com" style="color:#d1d5db;">lumeopower.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Plain text template ──────────────────────────────────────────────────

function formatReceiptText(d: ReceiptData): string {
  const greeting = d.driverName ? `Hi ${d.driverName},` : 'Hi,';
  const hasTou = d.pricingMode === 'tou' && d.touSegments.length > 1;

  const lines: string[] = [
    'LUMEO CHARGING RECEIPT',
    '======================',
    '',
    greeting,
    'Thanks for charging with Lumeo. Here\'s your receipt.',
    '',
    `Date:     ${d.sessionDate}`,
    `Time:     ${d.sessionTime}`,
    `Location: ${d.siteName}`,
    `Charger:  ${d.chargerName}`,
    `Duration: ${formatDuration(d.durationMinutes)}`,
    `Energy:   ${d.kwhDelivered.toFixed(2)} kWh`,
    '',
    'BILLING',
    '-------',
  ];

  if (hasTou) {
    for (const seg of d.touSegments) {
      lines.push(`  ${seg.windowLabel}: ${seg.kwh.toFixed(2)} kWh × ${usd(seg.ratePerKwh)}/kWh = ${usd(seg.amountUsd)}`);
    }
  } else {
    lines.push(`  Energy: ${d.kwhDelivered.toFixed(2)} kWh — ${usd(d.energyAmountUsd)}`);
  }

  if (d.idleAmountUsd > 0) {
    lines.push(`  Idle fee: ${usd(d.idleAmountUsd)}`);
  }
  if (d.activationAmountUsd > 0) {
    lines.push(`  Activation fee: ${usd(d.activationAmountUsd)}`);
  }

  lines.push('');
  lines.push(`TOTAL: ${usd(d.grossAmountUsd)}`);
  lines.push('');
  lines.push('Questions? Contact support@lumeopower.com');
  lines.push('');
  lines.push('Lumeo Power · lumeopower.com');

  return lines.join('\n');
}
