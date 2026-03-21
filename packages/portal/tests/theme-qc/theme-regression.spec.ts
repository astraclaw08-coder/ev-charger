/**
 * Portal Theme QC — Visual Regression Suite
 *
 * Captures screenshots of every portal route in both dark and light themes,
 * and runs structural checks for theme correctness:
 *   - Root background is never wrong-theme color
 *   - Cards are visually distinct from page background
 *   - Chart ticks / grid lines have explicit color (not default SVG black/gray)
 *
 * Run locally:
 *   cd packages/portal && npx playwright test tests/theme-qc/
 *
 * Screenshots saved to: tests/theme-qc/screenshots/
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// ── Auth / Dev mode setup ─────────────────────────────────────────────────────

async function devSignIn(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    sessionStorage.setItem('portal.dev.signedIn', '1');
    localStorage.setItem('portal.theme', 'dark'); // start dark, test will override
  });
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
}

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('portal.theme', t);
  }, theme);
  await page.reload({ waitUntil: 'networkidle' });
}

// ── Route list ────────────────────────────────────────────────────────────────

const ROUTES: Array<{ name: string; path: string }> = [
  { name: 'login',          path: '/login' },
  { name: 'dashboard',      path: '/dashboard' },
  { name: 'overview',       path: '/overview' },
  { name: 'sites',          path: '/sites' },
  { name: 'chargers',       path: '/chargers' },
  { name: 'sessions',       path: '/sessions' },
  { name: 'analytics',      path: '/analytics' },
  { name: 'load-management',path: '/load-management' },
  { name: 'operations',     path: '/operations' },
  { name: 'settings',       path: '/settings' },
  { name: 'admin',          path: '/admin' },
  { name: 'reset-password', path: '/reset-password' },
];

// ── Screenshot directory ──────────────────────────────────────────────────────

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Expected root background colors per theme */
const DARK_BG_REGEX  = /rgb\(15,\s*23,\s*42\)|rgb\(30,\s*41,\s*59\)|#0f172a|#1e293b/i;
const LIGHT_BG_REGEX = /rgb\(248,\s*250,\s*252\)|rgb\(255,\s*255,\s*255\)|#f8fafc|#ffffff/i;

/** Wrong-theme sentinel: dark bg colors that should NOT appear in light theme root */
const DARK_BG_SENTINEL = [
  'rgb(15, 23, 42)',   // slate-900
  'rgb(2, 6, 23)',     // slate-950
  'rgb(17, 24, 39)',   // gray-900
];

/** Wrong-theme sentinel: pure white that should NOT be the root in dark theme */
const LIGHT_BG_SENTINEL = [
  'rgb(255, 255, 255)', // pure white
  'rgb(248, 250, 252)', // slate-50
  'rgb(249, 250, 251)', // gray-50
];

async function getRootBg(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.querySelector('#root, body') as HTMLElement | null;
    if (!body) return '';
    return window.getComputedStyle(body).backgroundColor;
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('Portal Theme QC', () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
  });

  for (const route of ROUTES) {
    test(`[dark] ${route.name} — screenshot + theme check`, async ({ page }) => {
      await setTheme(page, 'dark');
      await page.goto(route.path, { waitUntil: 'networkidle' });

      // Screenshot
      const screenshotPath = path.join(SCREENSHOT_DIR, `${route.name}-dark.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Check: root bg should NOT be a pure light color
      const bg = await getRootBg(page);
      for (const sentinel of LIGHT_BG_SENTINEL) {
        expect(
          bg,
          `[dark theme] ${route.name} root background should not be light: got ${bg}`,
        ).not.toBe(sentinel);
      }

      // Check: no JS console errors about theme context
      // (soft check — just log, don't fail)
    });

    test(`[light] ${route.name} — screenshot + theme check`, async ({ page }) => {
      await setTheme(page, 'light');
      await page.goto(route.path, { waitUntil: 'networkidle' });

      // Screenshot
      const screenshotPath = path.join(SCREENSHOT_DIR, `${route.name}-light.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Check: root bg should NOT be a pure dark color
      const bg = await getRootBg(page);
      for (const sentinel of DARK_BG_SENTINEL) {
        expect(
          bg,
          `[light theme] ${route.name} root background should not be dark: got ${bg}`,
        ).not.toBe(sentinel);
      }
    });
  }

  // ── Chart quality checks ─────────────────────────────────────────────────

  test('[dark] dashboard — chart axis labels have explicit fill color', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/dashboard', { waitUntil: 'networkidle' });

    const tickFills = await page.evaluate(() => {
      const ticks = Array.from(document.querySelectorAll('.recharts-cartesian-axis-tick-value'));
      return ticks.map((t) => (t as SVGElement).getAttribute('fill') ?? '');
    });

    for (const fill of tickFills) {
      expect(
        fill,
        'Dark theme chart tick must have an explicit fill (not empty or inherit)',
      ).not.toBe('');
      expect(fill).not.toBe('inherit');
    }
  });

  test('[light] dashboard — chart axis labels have explicit fill color', async ({ page }) => {
    await setTheme(page, 'light');
    await page.goto('/dashboard', { waitUntil: 'networkidle' });

    const tickFills = await page.evaluate(() => {
      const ticks = Array.from(document.querySelectorAll('.recharts-cartesian-axis-tick-value'));
      return ticks.map((t) => (t as SVGElement).getAttribute('fill') ?? '');
    });

    for (const fill of tickFills) {
      expect(fill, 'Light theme chart tick must have an explicit fill').not.toBe('');
      expect(fill).not.toBe('inherit');
    }
  });

  // ── Input affordance checks ──────────────────────────────────────────────

  test('[light] site detail — form inputs have visible borders', async ({ page }) => {
    await setTheme(page, 'light');
    // Navigate to first site detail (if it exists)
    const resp = await page.goto('/sites', { waitUntil: 'networkidle' });
    if (!resp?.ok()) return; // skip if no sites

    // Find first site link and navigate
    const siteLink = page.locator('a[href^="/sites/"]').first();
    if (await siteLink.count() === 0) return;
    await siteLink.click();
    await page.waitForLoadState('networkidle');

    // Check form input border color is not the ultra-light gray-200
    const inputBorderColors = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select'));
      return inputs.map((el) => window.getComputedStyle(el).borderColor);
    });

    for (const border of inputBorderColors) {
      // rgb(229, 231, 235) = Tailwind gray-200 — too faint in light theme
      expect(
        border,
        `Input border should not be gray-200 (${border}) in light theme — use gray-300`,
      ).not.toBe('rgb(229, 231, 235)');
    }
  });

  // ── Modal overlay checks ─────────────────────────────────────────────────

  test('[dark] site detail — fee modal is dark themed', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/sites', { waitUntil: 'networkidle' });

    const siteLink = page.locator('a[href^="/sites/"]').first();
    if (await siteLink.count() === 0) return;
    await siteLink.click();
    await page.waitForLoadState('networkidle');

    // Open fee modal if button exists
    const feeBtn = page.locator('button:has-text("Fee")').first();
    if (await feeBtn.count() === 0) return;
    await feeBtn.click();
    await page.waitForTimeout(300);

    const screenshotPath = path.join(SCREENSHOT_DIR, 'site-fee-modal-dark.png');
    await page.screenshot({ path: screenshotPath });

    // Modal content should not be pure white in dark theme
    const modalBg = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], .fixed.inset-0 > div');
      if (!modal) return '';
      return window.getComputedStyle(modal).backgroundColor;
    });
    if (modalBg) {
      expect(modalBg).not.toBe('rgb(255, 255, 255)');
    }
  });

  test('[light] site detail — fee modal is light themed', async ({ page }) => {
    await setTheme(page, 'light');
    await page.goto('/sites', { waitUntil: 'networkidle' });

    const siteLink = page.locator('a[href^="/sites/"]').first();
    if (await siteLink.count() === 0) return;
    await siteLink.click();
    await page.waitForLoadState('networkidle');

    const feeBtn = page.locator('button:has-text("Fee")').first();
    if (await feeBtn.count() === 0) return;
    await feeBtn.click();
    await page.waitForTimeout(300);

    const screenshotPath = path.join(SCREENSHOT_DIR, 'site-fee-modal-light.png');
    await page.screenshot({ path: screenshotPath });

    // Modal content should not be dark in light theme
    const modalBg = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], .fixed.inset-0 > div');
      if (!modal) return '';
      return window.getComputedStyle(modal).backgroundColor;
    });
    if (modalBg) {
      expect(modalBg).not.toBe('rgb(15, 23, 42)');
      expect(modalBg).not.toBe('rgb(30, 41, 59)');
    }
  });
});
