import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isIos(ua: string) {
  return /iphone|ipad|ipod/i.test(ua);
}

function isAndroid(ua: string) {
  return /android/i.test(ua);
}

export async function qrRedirectRoutes(app: FastifyInstance) {
  app.get<{ Params: { chargerId: string } }>('/r/charger/:chargerId', async (req, reply) => {
    const chargerId = req.params.chargerId?.trim();
    if (!chargerId) return reply.status(400).type('text/plain').send('Invalid charger id');

    const charger = await prisma.charger.findUnique({
      where: { id: chargerId },
      select: { id: true },
    });

    if (!charger) {
      return reply.status(404).type('text/plain').send('Charger not found');
    }

    const scheme = (process.env.EV_APP_DEEP_LINK_SCHEME ?? 'evcharger').trim();
    const androidPackage = (process.env.EV_APP_ANDROID_PACKAGE_NAME ?? 'app.evcharger.app').trim();
    const iosStoreUrl = (process.env.EV_APP_IOS_APP_STORE_URL ?? 'https://apps.apple.com').trim();
    const androidStoreUrl = (process.env.EV_APP_ANDROID_PLAY_STORE_URL ?? 'https://play.google.com/store/apps/details?id=app.evcharger.app').trim();
    const webDownloadUrl = (process.env.EV_APP_DOWNLOAD_WEB_URL ?? iosStoreUrl).trim();

    const deepLinkPath = `charger/detail/${encodeURIComponent(charger.id)}`;
    const deepLinkUrl = `${scheme}://${deepLinkPath}`;

    const ua = req.headers['user-agent'] ?? '';
    const platform = isIos(ua) ? 'ios' : isAndroid(ua) ? 'android' : 'other';
    const fallbackStoreUrl = platform === 'ios' ? iosStoreUrl : platform === 'android' ? androidStoreUrl : webDownloadUrl;

    const androidIntentUrl = `intent://${deepLinkPath}#Intent;scheme=${encodeURIComponent(scheme)};package=${encodeURIComponent(androidPackage)};S.browser_fallback_url=${encodeURIComponent(androidStoreUrl)};end`;
    const launchUrl = platform === 'android' ? androidIntentUrl : deepLinkUrl;

    reply
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      .type('text/html; charset=utf-8')
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open EV Charger App</title>
    <meta http-equiv="refresh" content="6;url=${escapeHtml(fallbackStoreUrl)}" />
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;max-width:640px;margin:0 auto;color:#111827}
      .muted{color:#6b7280;font-size:14px}
      .btn{display:inline-block;margin-right:8px;margin-top:10px;padding:10px 14px;border-radius:8px;text-decoration:none;border:1px solid #d1d5db;color:#111827}
      .btn.primary{background:#2563eb;color:white;border-color:#2563eb}
      code{background:#f3f4f6;padding:2px 6px;border-radius:6px}
    </style>
  </head>
  <body>
    <h1>Opening EV Charger app…</h1>
    <p class="muted">If the app does not open automatically, use the buttons below.</p>
    <div>
      <a class="btn primary" href="${escapeHtml(deepLinkUrl)}">Open app</a>
      <a class="btn" href="${escapeHtml(fallbackStoreUrl)}">Get the app</a>
    </div>
    <p class="muted">Charger ID: <code>${escapeHtml(charger.id)}</code></p>
    <script>
      (function() {
        var launchUrl = ${JSON.stringify(launchUrl)};
        var fallbackUrl = ${JSON.stringify(fallbackStoreUrl)};
        var redirected = false;
        var start = Date.now();

        function tryOpenApp() {
          window.location.href = launchUrl;
        }

        function goToFallback() {
          if (redirected) return;
          redirected = true;
          window.location.href = fallbackUrl;
        }

        setTimeout(tryOpenApp, 60);
        setTimeout(function() {
          if (document.visibilityState === 'visible' && Date.now() - start > 1200) {
            goToFallback();
          }
        }, 1400);
      })();
    </script>
  </body>
</html>`);
  });
}
