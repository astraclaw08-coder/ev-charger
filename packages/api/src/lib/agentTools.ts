import { z } from 'zod';
import { prisma } from '@ev-charger/shared';
import { evaluatePolicy, type PolicyKey } from './policyMatrix';
import type { PortalAccessClaimsV1 } from './portalAccessClaims';
import { listSites, getSiteDetail, getSiteAnalytics } from '../services/siteService';
import { listChargers, getChargerStatus } from '../services/chargerService';
import { getPortfolioSummary } from '../services/analyticsService';

const MAX_RESULT_CHARS = 8192;

// ── OpenAI function-calling tool definitions ──────────────────────────────────

export const AGENT_TOOLS = [
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

// ── Policy map ────────────────────────────────────────────────────────────────

const TOOL_POLICIES: Record<string, PolicyKey> = {
  list_sites: 'site.list',
  get_site_detail: 'site.read',
  list_chargers: 'charger.status.read',
  get_charger_status: 'charger.status.read',
  get_site_analytics: 'site.analytics.read',
  get_portfolio_summary: 'site.analytics.read',
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
