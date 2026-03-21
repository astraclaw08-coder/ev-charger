/**
 * Portal Theme QC — WCAG Contrast Utilities
 *
 * Used by theme-regression.spec.ts to enforce minimum contrast ratios
 * on critical UI elements in both light and dark themes.
 */

/** Convert 8-bit channel to relative luminance component */
function toLinear(c: number): number {
  const sRGB = c / 255;
  return sRGB <= 0.03928 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
}

/** Relative luminance of an RGB colour (0–1) */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio between two RGB colours */
export function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA requires ≥ 4.5:1 for normal text, ≥ 3:1 for large text */
export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;

/**
 * CSS selectors for critical portal elements that must maintain
 * readable contrast in both themes. Checked in the Playwright suite.
 */
export const CRITICAL_SELECTORS = {
  /** Main navigation links */
  navLinks: 'nav a',
  /** Active nav item */
  navActive: 'nav a[aria-current="page"], nav a.active',
  /** KPI value text */
  kpiValues: '[data-testid*="kpi"] p, .kpi-value',
  /** Status badges */
  statusBadges: '[class*="badge"], [class*="status-"]',
  /** Chart axis labels — Recharts generates these */
  chartAxisLabels: '.recharts-cartesian-axis-tick-value',
  /** Chart tooltip */
  chartTooltip: '.recharts-tooltip-wrapper',
  /** Form input borders */
  formInputs: 'input, select, textarea',
  /** Card containers */
  cards: '[class*="rounded-xl"]',
  /** Page headings */
  headings: 'h1, h2',
  /** Breadcrumb trail */
  breadcrumbs: '[aria-label="breadcrumb"] a, [aria-label="breadcrumb"] span',
} as const;

/**
 * Known theme violation patterns to grep for in source.
 * Running: grep -rn <pattern> packages/portal/src should return 0 results
 * after the theme audit fixes are applied.
 */
export const BANNED_HARDCODED_COLORS = [
  // Pure black/white without dark: variants in meaningful containers
  /className="[^"]*bg-white[^"]*"(?!.*dark:)/,
  /className="[^"]*text-black[^"]*"(?!.*dark:)/,
  // Recharts without explicit tick fill (chart label invisible in dark)
  /<XAxis(?![^>]*tick)/,
  /<YAxis(?![^>]*tick)/,
];

/** Theme tokens reference — use these, never raw hex in components */
export const THEME_TOKENS = {
  dark: {
    pageBg: '#0f172a',        // slate-900
    surfaceBg: '#1e293b',     // slate-800
    cardBg: '#1e293b',        // slate-800
    border: '#334155',        // slate-700
    textPrimary: '#f1f5f9',   // slate-100
    textSecondary: '#94a3b8', // slate-400
    textMuted: '#64748b',     // slate-500
    chartGrid: '#334155',
    chartTick: '#94a3b8',
  },
  light: {
    pageBg: '#f8fafc',        // slate-50
    surfaceBg: '#ffffff',
    cardBg: '#ffffff',
    border: '#d1d5db',        // gray-300
    textPrimary: '#111827',   // gray-900
    textSecondary: '#4b5563', // gray-600
    textMuted: '#6b7280',     // gray-500
    chartGrid: '#e2e8f0',
    chartTick: '#64748b',
  },
} as const;
