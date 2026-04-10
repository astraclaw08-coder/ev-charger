/**
 * Lightweight email utility.
 *
 * Transport priority:
 * 1. RESEND_API_KEY → Resend HTTP API (recommended for Railway/cloud)
 * 2. SMTP_URL → nodemailer SMTP (for environments where SMTP ports are open)
 * 3. Neither → console log fallback (dev/staging)
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SMTP_URL = process.env.SMTP_URL; // e.g. smtps://user:pass@smtp.gmail.com
const EMAIL_FROM = process.env.EMAIL_FROM || 'Lumeo Power <no-reply@lumeopower.com>';

interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  // Prefer Resend HTTP API (works on Railway where SMTP is blocked)
  if (RESEND_API_KEY) {
    return sendViaResend(payload);
  }

  // Fallback: nodemailer SMTP
  if (SMTP_URL) {
    return sendViaSMTP(payload);
  }

  // Dev fallback: log only
  console.log(`[email] (no transport configured) Would send to=${payload.to} subject="${payload.subject}"`);
  console.log(`[email] body: ${payload.text.slice(0, 200)}`);
  return true;
}

async function sendViaResend(payload: EmailPayload): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] Resend API error (${res.status}): ${body}`);
      return false;
    }

    console.log(`[email] Sent via Resend to=${payload.to} subject="${payload.subject}"`);
    return true;
  } catch (err) {
    console.error(`[email] Resend send failed to=${payload.to}:`, err);
    return false;
  }
}

async function sendViaSMTP(payload: EmailPayload): Promise<boolean> {
  try {
    // Dynamic require so nodemailer is optional (not a hard dependency)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodemailer = require('nodemailer') as any;
    const transport = nodemailer.createTransport(SMTP_URL);
    await transport.sendMail({
      from: EMAIL_FROM,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    console.log(`[email] Sent via SMTP to=${payload.to} subject="${payload.subject}"`);
    return true;
  } catch (err) {
    console.error(`[email] SMTP send failed to=${payload.to}:`, err);
    return false;
  }
}

export function sendDeletionConfirmationEmail(email: string, deletionDate: Date): Promise<boolean> {
  const formattedDate = deletionDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // 30 days from now
  const permanentDate = new Date(deletionDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const formattedPermanent = permanentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return sendEmail({
    to: email,
    subject: 'Lumeo Power — Account Deletion Requested',
    text: [
      'Hi,',
      '',
      `You requested deletion of your Lumeo Power account on ${formattedDate}.`,
      '',
      `Your personal data will be permanently anonymized on ${formattedPermanent} (30 days from request).`,
      '',
      'If you did not request this, or want to cancel, contact us immediately at privacy@lumeopower.com.',
      '',
      'After the grace period:',
      '- Your name, email, phone, and address will be permanently removed',
      '- Anonymized charging records will be retained for billing compliance',
      '- This action cannot be undone',
      '',
      'Lumeo Power Team',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #374151;">
        <h2 style="color: #111827;">Account Deletion Requested</h2>
        <p>You requested deletion of your Lumeo Power account on <strong>${formattedDate}</strong>.</p>
        <p>Your personal data will be permanently anonymized on <strong>${formattedPermanent}</strong> (30 days from request).</p>
        <p style="color: #dc2626; font-weight: 600;">If you did not request this, contact us immediately at <a href="mailto:privacy@lumeopower.com">privacy@lumeopower.com</a>.</p>
        <p>After the grace period:</p>
        <ul>
          <li>Your name, email, phone, and address will be permanently removed</li>
          <li>Anonymized charging records will be retained for billing compliance</li>
          <li>This action cannot be undone</li>
        </ul>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #9ca3af; font-size: 13px;">Lumeo Power · <a href="https://portal.lumeopower.com/privacy">Privacy Policy</a></p>
      </div>
    `,
  });
}
