import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasSiteAccess(siteId: string, siteIds: string[] | undefined) {
  if (!siteIds || siteIds.length === 0) return true;
  if (siteIds.includes('*')) return true;
  return siteIds.includes(siteId);
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function escapeCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const MAX_DATE_RANGE_DAYS = 90;
const MAX_SAVED_REPORTS = 50;

// ─── Route Registration ─────────────────────────────────────────────────────

export async function reportRoutes(app: FastifyInstance) {

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /reports/interval-usage/csv — export interval usage data as CSV
  // ═══════════════════════════════════════════════════════════════════════════
  app.get<{
    Querystring: {
      siteId?: string;
      chargerIds?: string;   // comma-separated charger IDs
      startDate: string;     // ISO date YYYY-MM-DD
      endDate: string;       // ISO date YYYY-MM-DD
      intervalMinutes?: string; // 15, 30, or 60
    };
  }>('/reports/interval-usage/csv', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const { siteId, chargerIds, startDate, endDate } = req.query;
    const intervalMinutes = parseInt(req.query.intervalMinutes ?? '15', 10);

    // Validate dates
    if (!startDate || !endDate) {
      return reply.status(400).send({ error: 'startDate and endDate are required' });
    }
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return reply.status(400).send({ error: 'Invalid date range' });
    }
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > MAX_DATE_RANGE_DAYS) {
      return reply.status(400).send({ error: `Date range exceeds ${MAX_DATE_RANGE_DAYS} days` });
    }
    if (![15, 30, 60].includes(intervalMinutes)) {
      return reply.status(400).send({ error: 'intervalMinutes must be 15, 30, or 60' });
    }

    // Scope check
    const scopedSiteIds = req.currentOperator?.claims?.siteIds ?? [];
    if (siteId && !hasSiteAccess(siteId, scopedSiteIds)) {
      return reply.status(403).send({ error: 'Forbidden', denyReason: { code: 'SITE_OUT_OF_SCOPE' } });
    }

    // Build where clause
    const chargerIdList = chargerIds ? chargerIds.split(',').filter(Boolean) : [];
    const where: any = {
      intervalStart: { gte: start, lte: end },
      ...(siteId ? { siteId } : {}),
      ...(chargerIdList.length > 0 ? { chargerId: { in: chargerIdList } } : {}),
      ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
    };

    // Fetch all matching rows (no pagination — streaming CSV)
    const rows = await prisma.rebateInterval15m.findMany({
      where,
      orderBy: [{ intervalStart: 'asc' }, { chargerId: 'asc' }, { connectorId: 'asc' }],
      include: {
        site: { select: { name: true } },
        charger: { select: { ocppId: true } },
      },
    });

    // Aggregate if needed (30m or 60m intervals)
    let outputRows: Array<{
      intervalStart: string;
      intervalEnd: string;
      siteName: string;
      chargerOcppId: string;
      connectorId: number;
      energyKwh: number;
      avgPowerKw: number;
      maxPowerKw: number | null;
      portStatus: string;
      vehicleConnected: string;
      dataQualityFlag: string;
    }>;

    if (intervalMinutes === 15) {
      outputRows = rows.map((r: any) => ({
        intervalStart: r.intervalStart.toISOString(),
        intervalEnd: r.intervalEnd.toISOString(),
        siteName: r.site?.name ?? '',
        chargerOcppId: r.charger?.ocppId ?? '',
        connectorId: r.connectorId,
        energyKwh: toNumber(r.energyKwh),
        avgPowerKw: toNumber(r.avgPowerKw),
        maxPowerKw: r.maxPowerKw != null ? toNumber(r.maxPowerKw) : null,
        portStatus: r.portStatus ?? '',
        vehicleConnected: r.vehicleConnected != null ? String(r.vehicleConnected) : '',
        dataQualityFlag: r.dataQualityFlag ?? '',
      }));
    } else {
      // Aggregate to 30m or 60m buckets
      const bucketMs = intervalMinutes * 60 * 1000;
      const bucketMap = new Map<string, {
        intervalStart: Date;
        intervalEnd: Date;
        siteName: string;
        chargerOcppId: string;
        connectorId: number;
        totalEnergy: number;
        avgPowerSum: number;
        maxPower: number | null;
        count: number;
        portStatuses: Set<string>;
        vehicleConnected: Set<string>;
        dataFlags: Set<string>;
      }>();

      for (const r of rows as any[]) {
        const bucketStart = new Date(Math.floor(r.intervalStart.getTime() / bucketMs) * bucketMs);
        const bucketEnd = new Date(bucketStart.getTime() + bucketMs);
        const key = `${r.chargerId}:${r.connectorId}:${bucketStart.getTime()}`;

        const existing = bucketMap.get(key);
        if (existing) {
          existing.totalEnergy += toNumber(r.energyKwh);
          existing.avgPowerSum += toNumber(r.avgPowerKw);
          existing.count++;
          if (r.maxPowerKw != null) {
            existing.maxPower = Math.max(existing.maxPower ?? 0, toNumber(r.maxPowerKw));
          }
          if (r.portStatus) existing.portStatuses.add(r.portStatus);
          if (r.vehicleConnected != null) existing.vehicleConnected.add(String(r.vehicleConnected));
          if (r.dataQualityFlag) existing.dataFlags.add(r.dataQualityFlag);
        } else {
          bucketMap.set(key, {
            intervalStart: bucketStart,
            intervalEnd: bucketEnd,
            siteName: r.site?.name ?? '',
            chargerOcppId: r.charger?.ocppId ?? '',
            connectorId: r.connectorId,
            totalEnergy: toNumber(r.energyKwh),
            avgPowerSum: toNumber(r.avgPowerKw),
            maxPower: r.maxPowerKw != null ? toNumber(r.maxPowerKw) : null,
            count: 1,
            portStatuses: new Set(r.portStatus ? [r.portStatus] : []),
            vehicleConnected: new Set(r.vehicleConnected != null ? [String(r.vehicleConnected)] : []),
            dataFlags: new Set(r.dataQualityFlag ? [r.dataQualityFlag] : []),
          });
        }
      }

      outputRows = Array.from(bucketMap.values())
        .sort((a, b) => a.intervalStart.getTime() - b.intervalStart.getTime()
          || a.chargerOcppId.localeCompare(b.chargerOcppId)
          || a.connectorId - b.connectorId)
        .map((b) => ({
          intervalStart: b.intervalStart.toISOString(),
          intervalEnd: b.intervalEnd.toISOString(),
          siteName: b.siteName,
          chargerOcppId: b.chargerOcppId,
          connectorId: b.connectorId,
          energyKwh: Math.round(b.totalEnergy * 1e6) / 1e6,
          avgPowerKw: Math.round((b.avgPowerSum / b.count) * 1e6) / 1e6,
          maxPowerKw: b.maxPower != null ? Math.round(b.maxPower * 1e6) / 1e6 : null,
          portStatus: Array.from(b.portStatuses).join(';'),
          vehicleConnected: Array.from(b.vehicleConnected).join(';'),
          dataQualityFlag: Array.from(b.dataFlags).join(';'),
        }));
    }

    // Build CSV
    const headers = [
      'interval_start', 'interval_end', 'site_name', 'charger_ocpp_id', 'connector_id',
      'energy_kwh', 'avg_power_kw', 'max_power_kw', 'port_status', 'vehicle_connected', 'data_quality_flag',
    ];
    const csvLines = [headers.join(',')];
    for (const row of outputRows) {
      csvLines.push([
        escapeCell(row.intervalStart),
        escapeCell(row.intervalEnd),
        escapeCell(row.siteName),
        escapeCell(row.chargerOcppId),
        escapeCell(row.connectorId),
        escapeCell(row.energyKwh),
        escapeCell(row.avgPowerKw),
        escapeCell(row.maxPowerKw ?? ''),
        escapeCell(row.portStatus),
        escapeCell(row.vehicleConnected),
        escapeCell(row.dataQualityFlag),
      ].join(','));
    }
    const csv = csvLines.join('\n');

    const filename = `interval-usage_${startDate}_${endDate}_${intervalMinutes}m.csv`;
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /reports/interval-usage/preview — preview interval usage data (JSON)
  // ═══════════════════════════════════════════════════════════════════════════
  app.get<{
    Querystring: {
      siteId?: string;
      chargerIds?: string;
      startDate: string;
      endDate: string;
      limit?: string;
      offset?: string;
    };
  }>('/reports/interval-usage/preview', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const { siteId, chargerIds, startDate, endDate } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10), 0);

    if (!startDate || !endDate) {
      return reply.status(400).send({ error: 'startDate and endDate are required' });
    }
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return reply.status(400).send({ error: 'Invalid date range' });
    }

    const scopedSiteIds = req.currentOperator?.claims?.siteIds ?? [];
    if (siteId && !hasSiteAccess(siteId, scopedSiteIds)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const chargerIdList = chargerIds ? chargerIds.split(',').filter(Boolean) : [];
    const where: any = {
      intervalStart: { gte: start, lte: end },
      ...(siteId ? { siteId } : {}),
      ...(chargerIdList.length > 0 ? { chargerId: { in: chargerIdList } } : {}),
      ...(scopedSiteIds.length > 0 && !scopedSiteIds.includes('*') ? { siteId: { in: scopedSiteIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.rebateInterval15m.findMany({
        where,
        orderBy: { intervalStart: 'asc' },
        take: limit,
        skip: offset,
        include: {
          site: { select: { name: true } },
          charger: { select: { ocppId: true } },
        },
      }),
      prisma.rebateInterval15m.count({ where }),
    ]);

    return {
      total,
      limit,
      offset,
      rows: rows.map((r: any) => ({
        intervalStart: r.intervalStart.toISOString(),
        intervalEnd: r.intervalEnd.toISOString(),
        siteName: r.site?.name ?? '',
        chargerOcppId: r.charger?.ocppId ?? '',
        connectorId: r.connectorId,
        energyKwh: toNumber(r.energyKwh),
        avgPowerKw: toNumber(r.avgPowerKw),
        maxPowerKw: r.maxPowerKw != null ? toNumber(r.maxPowerKw) : null,
        portStatus: r.portStatus ?? '',
        vehicleConnected: r.vehicleConnected != null ? String(r.vehicleConnected) : '',
        dataQualityFlag: r.dataQualityFlag ?? '',
      })),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Saved Reports CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /reports/saved — list saved reports for current operator
  app.get('/reports/saved', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req) => {
    const operatorId = req.currentOperator!.id;
    const reports = await prisma.savedReport.findMany({
      where: { operatorId },
      orderBy: { updatedAt: 'desc' },
    });
    return { reports };
  });

  // GET /reports/saved/:id — get single saved report
  app.get<{ Params: { id: string } }>('/reports/saved/:id', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const report = await prisma.savedReport.findUnique({ where: { id: req.params.id } });
    if (!report || report.operatorId !== req.currentOperator!.id) {
      return reply.status(404).send({ error: 'Report not found' });
    }
    return report;
  });

  // POST /reports/saved — create saved report
  app.post<{
    Body: { name: string; reportType?: string; config: Record<string, unknown> };
  }>('/reports/saved', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const operatorId = req.currentOperator!.id;
    const { name, reportType, config } = req.body;

    if (!name?.trim()) {
      return reply.status(400).send({ error: 'Report name is required' });
    }

    // Limit saved reports per operator
    const count = await prisma.savedReport.count({ where: { operatorId } });
    if (count >= MAX_SAVED_REPORTS) {
      return reply.status(400).send({ error: `Maximum ${MAX_SAVED_REPORTS} saved reports reached` });
    }

    try {
      const report = await prisma.savedReport.create({
        data: {
          operatorId,
          name: name.trim(),
          reportType: reportType ?? 'interval_usage',
          config: config as any,
        },
      });
      return reply.status(201).send(report);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.status(409).send({ error: 'A report with this name already exists' });
      }
      throw err;
    }
  });

  // PUT /reports/saved/:id — update saved report
  app.put<{
    Params: { id: string };
    Body: { name?: string; config?: Record<string, unknown> };
  }>('/reports/saved/:id', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const operatorId = req.currentOperator!.id;
    const existing = await prisma.savedReport.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.operatorId !== operatorId) {
      return reply.status(404).send({ error: 'Report not found' });
    }

    const data: any = {};
    if (req.body.name?.trim()) data.name = req.body.name.trim();
    if (req.body.config) data.config = req.body.config;

    try {
      const updated = await prisma.savedReport.update({
        where: { id: req.params.id },
        data,
      });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.status(409).send({ error: 'A report with this name already exists' });
      }
      throw err;
    }
  });

  // DELETE /reports/saved/:id — delete saved report
  app.delete<{ Params: { id: string } }>('/reports/saved/:id', {
    preHandler: [requireOperator, requirePolicy('site.analytics.read')],
  }, async (req, reply) => {
    const operatorId = req.currentOperator!.id;
    const existing = await prisma.savedReport.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.operatorId !== operatorId) {
      return reply.status(404).send({ error: 'Report not found' });
    }

    await prisma.savedReport.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });
}
