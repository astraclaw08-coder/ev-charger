import { z } from 'zod';
import { prisma } from '@ev-charger/shared';
import { evaluatePolicy, type PolicyKey } from './policyMatrix';
import type { PortalAccessClaimsV1 } from './portalAccessClaims';
import { listSites, getSiteDetail, getSiteAnalytics } from '../services/siteService';
import { listChargers, getChargerStatus } from '../services/chargerService';
import { getPortfolioSummary } from '../services/analyticsService';
import { listTransactions, listSessionsByCharger, getSessionDetail } from '../services/sessionService';
import { lookupDriver, getDriverDetail, getDriverSessions } from '../services/supportService';
import {
  getChargerUptimeMetrics, getSiteUptimeMetrics, getChargerConnectionEvents,
  searchChargers, getSmartChargingStatus, getAuditLog, getSitePricing,
} from '../services/chargerDiagService';

const MAX_RESULT_CHARS = 8192;

// ── OpenAI function-calling tool definitions ──────────────────────────────────

export const AGENT_TOOLS = [
  // ─── Existing: Sites & Chargers ───
  {
    type: 'function' as const,
    function: {
      name: 'list_sites',
      description: 'List all EV charging sites accessible to the current operator',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (1-50, default 20)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_site_detail',
      description: 'Get detailed information about a specific site including its chargers',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'The site UUID' },
        },
        required: ['siteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_chargers',
      description: 'List chargers, optionally filtered by site',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'Filter by site UUID' },
          limit: { type: 'number', description: 'Max results (1-50, default 20)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_charger_status',
      description: 'Get real-time status of a specific charger including connector states and active sessions',
      parameters: {
        type: 'object',
        properties: {
          chargerId: { type: 'string', description: 'The charger UUID' },
        },
        required: ['chargerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_site_analytics',
      description: 'Get analytics for a specific site: sessions, energy, revenue, utilization over a period',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'The site UUID' },
          periodDays: { type: 'number', description: 'Number of days to look back (1-120, default 30)' },
        },
        required: ['siteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_portfolio_summary',
      description: 'Get portfolio-level analytics summary across all accessible sites',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          siteId: { type: 'string', description: 'Optional: filter to a specific site' },
        },
      },
    },
  },

  // ─── NEW: Sessions & Transactions ───
  {
    type: 'function' as const,
    function: {
      name: 'list_transactions',
      description: 'List charging transactions/sessions with billing details. Filterable by site, charger, status, and date range. Returns transaction IDs, energy, amounts, and payment status.',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'Filter by site UUID' },
          chargerId: { type: 'string', description: 'Filter by charger UUID' },
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'FAILED'], description: 'Filter by session status' },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD), default last 30 days' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max results (1-200, default 50)' },
          offset: { type: 'number', description: 'Skip first N results for pagination' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_sessions_by_charger',
      description: 'List recent charging sessions for a specific charger, including user info and billing',
      parameters: {
        type: 'object',
        properties: {
          chargerId: { type: 'string', description: 'The charger UUID' },
          limit: { type: 'number', description: 'Max results (1-100, default 20)' },
        },
        required: ['chargerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_session_detail',
      description: 'Get full detail of a single charging session including billing breakdown, payment info, user, and charger',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session UUID' },
        },
        required: ['sessionId'],
      },
    },
  },

  // ─── NEW: Charger Diagnostics ───
  {
    type: 'function' as const,
    function: {
      name: 'get_charger_uptime',
      description: 'Get uptime metrics for a charger: 24h, 7d, 30d uptime percentages and recent incidents',
      parameters: {
        type: 'object',
        properties: {
          chargerId: { type: 'string', description: 'The charger UUID' },
        },
        required: ['chargerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_site_uptime',
      description: 'Get aggregated uptime metrics for all chargers at a site, with per-charger breakdown',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'The site UUID' },
        },
        required: ['siteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_charger_connection_events',
      description: 'Get WebSocket connection/disconnection events for a charger — useful for diagnosing network issues',
      parameters: {
        type: 'object',
        properties: {
          chargerId: { type: 'string', description: 'The charger UUID' },
          limit: { type: 'number', description: 'Max results (1-200, default 50)' },
        },
        required: ['chargerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_chargers',
      description: 'Search chargers by OCPP ID, serial number, model, or vendor name across all accessible sites',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (min 2 chars)' },
        },
        required: ['query'],
      },
    },
  },

  // ─── NEW: Driver Support ───
  {
    type: 'function' as const,
    function: {
      name: 'lookup_driver',
      description: 'Search for a driver/user by email or phone number. Returns matching drivers with session counts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Email address or phone number (min 3 chars)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_driver_detail',
      description: 'Get full profile of a driver including session and payment counts',
      parameters: {
        type: 'object',
        properties: {
          driverId: { type: 'string', description: 'The driver/user UUID' },
        },
        required: ['driverId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_driver_sessions',
      description: 'Get paginated session history for a specific driver with charger and site context',
      parameters: {
        type: 'object',
        properties: {
          driverId: { type: 'string', description: 'The driver/user UUID' },
          page: { type: 'number', description: 'Page number (default 1)' },
          limit: { type: 'number', description: 'Results per page (1-100, default 20)' },
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'FAILED'], description: 'Filter by status' },
          from: { type: 'string', description: 'Start date filter (YYYY-MM-DD)' },
          to: { type: 'string', description: 'End date filter (YYYY-MM-DD)' },
        },
        required: ['driverId'],
      },
    },
  },

  // ─── NEW: Smart Charging ───
  {
    type: 'function' as const,
    function: {
      name: 'get_smart_charging_status',
      description: 'Get current smart charging states — effective power limits per charger, applied profiles, and errors',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'Filter by site UUID' },
          status: { type: 'string', description: 'Filter by status (e.g. APPLIED, PENDING, ERROR)' },
        },
      },
    },
  },

  // ─── NEW: Audit & Admin ───
  {
    type: 'function' as const,
    function: {
      name: 'get_audit_log',
      description: 'Get recent admin audit events — user management, security, settings changes, agent tool calls',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (1-200, default 50)' },
          action: { type: 'string', description: 'Filter by action name (partial match, e.g. "keycloak" or "security")' },
        },
      },
    },
  },

  // ─── NEW: Pricing ───
  {
    type: 'function' as const,
    function: {
      name: 'get_site_pricing',
      description: 'Get pricing configuration for a site: rate per kWh, idle fees, activation fee, TOU windows, vendor fees',
      parameters: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'The site UUID' },
        },
        required: ['siteId'],
      },
    },
  },
];

// ── Zod input schemas ─────────────────────────────────────────────────────────

const ListSitesInput = z.object({
  limit: z.number().min(1).max(50).optional().default(20),
});

const GetSiteDetailInput = z.object({
  siteId: z.string().min(1),
});

const ListChargersInput = z.object({
  siteId: z.string().optional(),
  limit: z.number().min(1).max(50).optional().default(20),
});

const GetChargerStatusInput = z.object({
  chargerId: z.string().min(1),
});

const GetSiteAnalyticsInput = z.object({
  siteId: z.string().min(1),
  periodDays: z.number().min(1).max(120).optional().default(30),
});

const GetPortfolioSummaryInput = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  siteId: z.string().optional(),
});

// New schemas
const ListTransactionsInput = z.object({
  siteId: z.string().optional(),
  chargerId: z.string().optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'FAILED']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.number().min(1).max(200).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

const ListSessionsByChargerInput = z.object({
  chargerId: z.string().min(1),
  limit: z.number().min(1).max(100).optional().default(20),
});

const GetSessionDetailInput = z.object({
  sessionId: z.string().min(1),
});

const GetChargerUptimeInput = z.object({
  chargerId: z.string().min(1),
});

const GetSiteUptimeInput = z.object({
  siteId: z.string().min(1),
});

const GetChargerConnectionEventsInput = z.object({
  chargerId: z.string().min(1),
  limit: z.number().min(1).max(200).optional().default(50),
});

const SearchChargersInput = z.object({
  query: z.string().min(2),
});

const LookupDriverInput = z.object({
  query: z.string().min(3),
});

const GetDriverDetailInput = z.object({
  driverId: z.string().min(1),
});

const GetDriverSessionsInput = z.object({
  driverId: z.string().min(1),
  page: z.number().min(1).optional().default(1),
  limit: z.number().min(1).max(100).optional().default(20),
  status: z.enum(['ACTIVE', 'COMPLETED', 'FAILED']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const GetSmartChargingStatusInput = z.object({
  siteId: z.string().optional(),
  status: z.string().optional(),
});

const GetAuditLogInput = z.object({
  limit: z.number().min(1).max(200).optional().default(50),
  action: z.string().optional(),
});

const GetSitePricingInput = z.object({
  siteId: z.string().min(1),
});

// ── Policy map ────────────────────────────────────────────────────────────────

const TOOL_POLICIES: Record<string, PolicyKey> = {
  // Existing
  list_sites: 'site.list',
  get_site_detail: 'site.read',
  list_chargers: 'charger.status.read',
  get_charger_status: 'charger.status.read',
  get_site_analytics: 'site.analytics.read',
  get_portfolio_summary: 'site.analytics.read',
  // Sessions & Transactions
  list_transactions: 'charger.sessions.read',
  list_sessions_by_charger: 'charger.sessions.read',
  get_session_detail: 'charger.sessions.read',
  // Charger Diagnostics
  get_charger_uptime: 'charger.uptime.read',
  get_site_uptime: 'site.uptime.read',
  get_charger_connection_events: 'charger.uptime.read',
  search_chargers: 'charger.status.read',
  // Driver Support
  lookup_driver: 'admin.users.read',
  get_driver_detail: 'admin.users.read',
  get_driver_sessions: 'admin.users.read',
  // Smart Charging
  get_smart_charging_status: 'charger.status.read',
  // Audit & Admin
  get_audit_log: 'admin.audit.read',
  // Pricing
  get_site_pricing: 'site.read',
};

// ── Result truncation ─────────────────────────────────────────────────────────

function truncateResult(result: unknown): string {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= MAX_RESULT_CHARS) return str;

  // If it's an array-like result, try to truncate the array
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        const arr = obj[key] as unknown[];
        // Binary search for a length that fits
        let lo = 1;
        let hi = arr.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = JSON.stringify({ ...obj, [key]: arr.slice(0, mid), _truncated: true, _totalCount: arr.length });
          if (candidate.length <= MAX_RESULT_CHARS) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        const truncated = { ...obj, [key]: arr.slice(0, lo), _truncated: true, _totalCount: arr.length };
        return JSON.stringify(truncated);
      }
    }
  }

  return str.slice(0, MAX_RESULT_CHARS) + '... [truncated]';
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function auditToolCall(operatorId: string, toolName: string, input: unknown, requestId: string) {
  try {
    await prisma.adminAuditEvent.create({
      data: {
        operatorId,
        action: `agent.tool.${toolName}`,
        metadata: { toolName, input: input as any, requestId },
      },
    });
  } catch {
    // Non-blocking — audit failures should not break the agent loop
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────

export async function executeAgentTool(
  name: string,
  input: unknown,
  claims: PortalAccessClaimsV1,
  requestId: string,
): Promise<unknown> {
  // 1. Check policy
  const policyKey = TOOL_POLICIES[name];
  if (!policyKey) {
    return { error: `Unknown tool: ${name}` };
  }

  const policyResult = evaluatePolicy({ key: policyKey, claims });
  if (!policyResult.allowed) {
    return {
      error: `Permission denied for ${name}`,
      code: policyResult.code,
      reason: policyResult.reason,
    };
  }

  // 2. Resolve operator ID for audit
  const operatorId = claims.orgId ?? 'unknown';

  // 3. Validate input and execute
  let result: unknown;

  try {
    switch (name) {
      // ─── Existing tools ───
      case 'list_sites': {
        const parsed = ListSitesInput.parse(input);
        const sites = await listSites(claims);
        result = (sites as any[]).slice(0, parsed.limit);
        break;
      }
      case 'get_site_detail': {
        const parsed = GetSiteDetailInput.parse(input);
        result = await getSiteDetail(parsed.siteId, claims);
        break;
      }
      case 'list_chargers': {
        const parsed = ListChargersInput.parse(input);
        result = await listChargers({ siteId: parsed.siteId, limit: parsed.limit }, claims);
        break;
      }
      case 'get_charger_status': {
        const parsed = GetChargerStatusInput.parse(input);
        result = await getChargerStatus(parsed.chargerId);
        break;
      }
      case 'get_site_analytics': {
        const parsed = GetSiteAnalyticsInput.parse(input);
        result = await getSiteAnalytics(parsed.siteId, parsed.periodDays);
        break;
      }
      case 'get_portfolio_summary': {
        const parsed = GetPortfolioSummaryInput.parse(input);
        result = await getPortfolioSummary(
          { startDate: parsed.startDate, endDate: parsed.endDate, siteId: parsed.siteId },
          claims,
        );
        break;
      }

      // ─── Sessions & Transactions ───
      case 'list_transactions': {
        const parsed = ListTransactionsInput.parse(input);
        result = await listTransactions(parsed, claims);
        break;
      }
      case 'list_sessions_by_charger': {
        const parsed = ListSessionsByChargerInput.parse(input);
        result = await listSessionsByCharger(parsed.chargerId, { limit: parsed.limit }, claims);
        break;
      }
      case 'get_session_detail': {
        const parsed = GetSessionDetailInput.parse(input);
        result = await getSessionDetail(parsed.sessionId, claims);
        break;
      }

      // ─── Charger Diagnostics ───
      case 'get_charger_uptime': {
        const parsed = GetChargerUptimeInput.parse(input);
        result = await getChargerUptimeMetrics(parsed.chargerId, claims);
        break;
      }
      case 'get_site_uptime': {
        const parsed = GetSiteUptimeInput.parse(input);
        result = await getSiteUptimeMetrics(parsed.siteId, claims);
        break;
      }
      case 'get_charger_connection_events': {
        const parsed = GetChargerConnectionEventsInput.parse(input);
        result = await getChargerConnectionEvents(parsed.chargerId, { limit: parsed.limit }, claims);
        break;
      }
      case 'search_chargers': {
        const parsed = SearchChargersInput.parse(input);
        result = await searchChargers(parsed.query, claims);
        break;
      }

      // ─── Driver Support ───
      case 'lookup_driver': {
        const parsed = LookupDriverInput.parse(input);
        result = await lookupDriver(parsed.query);
        break;
      }
      case 'get_driver_detail': {
        const parsed = GetDriverDetailInput.parse(input);
        result = await getDriverDetail(parsed.driverId);
        break;
      }
      case 'get_driver_sessions': {
        const parsed = GetDriverSessionsInput.parse(input);
        result = await getDriverSessions(parsed.driverId, {
          page: parsed.page,
          limit: parsed.limit,
          status: parsed.status,
          from: parsed.from,
          to: parsed.to,
        });
        break;
      }

      // ─── Smart Charging ───
      case 'get_smart_charging_status': {
        const parsed = GetSmartChargingStatusInput.parse(input);
        result = await getSmartChargingStatus(parsed, claims);
        break;
      }

      // ─── Audit & Admin ───
      case 'get_audit_log': {
        const parsed = GetAuditLogInput.parse(input);
        result = await getAuditLog(parsed);
        break;
      }

      // ─── Pricing ───
      case 'get_site_pricing': {
        const parsed = GetSitePricingInput.parse(input);
        result = await getSitePricing(parsed.siteId, claims);
        break;
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return { error: 'Invalid tool input', details: err.issues };
    }
    throw err;
  }

  // 4. Audit
  await auditToolCall(operatorId, name, input, requestId);

  // 5. Truncate if needed
  return JSON.parse(truncateResult(result));
}
