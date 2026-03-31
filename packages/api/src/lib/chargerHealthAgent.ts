/**
 * Modular AI Customer Service Ops Agent — Charger Health Assessment
 *
 * Pure algorithmic heuristics (no LLM calls). Ingests OCPP telemetry,
 * uptime data, session history, and connector state to produce a
 * structured diagnostic report with scored modules, likely causes,
 * and actionable operator recommendations.
 */

import { prisma } from '@ev-charger/shared';
import type { ChargerHealthReport, HealthModuleResult } from '@ev-charger/shared';

// ── Thresholds ──────────────────────────────────────────────────────
const HEARTBEAT_STALE_MINUTES = 17;
const HEARTBEAT_WARNING_MINUTES = 10;
const FAULT_TRANSITION_THRESHOLD = 3; // faults in 24h = concern
const SESSION_ANOMALY_WINDOW_DAYS = 7;
const MIN_SESSION_DURATION_SEC = 60;
const UPTIME_DEGRADED_PCT = 95;
const UPTIME_CRITICAL_PCT = 80;

// ── Main entry ──────────────────────────────────────────────────────

export async function assessChargerHealth(
  chargerId: string,
  connectorId?: number,
): Promise<ChargerHealthReport> {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    include: {
      connectors: true,
      site: { select: { name: true, timeZone: true } },
    },
  });

  if (!charger) throw new Error(`Charger ${chargerId} not found`);

  const now = new Date();
  const h24Ago = new Date(now.getTime() - 24 * 60 * 60_000);
  const d7Ago = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const d30Ago = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  // ── Parallel data fetch ───────────────────────────────────────────
  const [recentLogs, stateTransitions, uptimeEvents, uptimeDaily, recentSessions] =
    await Promise.all([
      prisma.ocppLog.findMany({
        where: { chargerId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.connectorStateTransition.findMany({
        where: {
          chargerId,
          occurredAt: { gte: d7Ago },
          ...(connectorId != null ? { connectorId } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: 50,
      }),
      prisma.uptimeEvent.findMany({
        where: { chargerId, createdAt: { gte: d30Ago } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.uptimeDaily.findMany({
        where: { chargerId, date: { gte: d30Ago } },
        orderBy: { date: 'desc' },
      }),
      prisma.session.findMany({
        where: {
          connector: {
            chargerId,
            ...(connectorId != null ? { connectorId } : {}),
          },
          startedAt: { gte: new Date(now.getTime() - SESSION_ANOMALY_WINDOW_DAYS * 24 * 60 * 60_000) },
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
        include: { payment: { select: { status: true } } },
      }),
    ]);

  // ── Run analysis modules ──────────────────────────────────────────
  const modules: HealthModuleResult[] = [
    analyzeHeartbeat(charger, now),
    analyzeConnectorState(stateTransitions, charger.connectors, h24Ago),
    analyzeSessionAnomalies(recentSessions),
    analyzeOcppErrors(recentLogs, h24Ago),
    analyzeUptimeTrend(uptimeDaily, uptimeEvents, d7Ago, d30Ago),
    analyzePowerDelivery(recentLogs, recentSessions),
  ];

  // ── Aggregate ─────────────────────────────────────────────────────
  const validModules = modules.filter((m) => m.status !== 'unknown');
  const overallScore = validModules.length > 0
    ? Math.round(validModules.reduce((sum, m) => sum + m.score, 0) / validModules.length)
    : 0;

  const overallStatus: ChargerHealthReport['overallStatus'] =
    charger.status === 'OFFLINE' ? 'offline'
      : overallScore >= 80 ? 'healthy'
        : overallScore >= 50 ? 'degraded'
          : 'critical';

  const allFindings = modules.flatMap((m) => m.findings);
  const allRecommendations = modules.flatMap((m) => m.recommendations);

  // Deduplicate and rank causes
  const likelyCauses = rankCauses(modules, charger);
  const summary = buildSummary(charger.ocppId, overallStatus, overallScore, allFindings);

  return {
    chargerId,
    ocppId: charger.ocppId,
    ...(connectorId != null ? { connectorId } : {}),
    overallScore,
    overallStatus,
    modules,
    summary,
    likelyCauses,
    recommendedActions: [...new Set(allRecommendations)].slice(0, 8),
    assessedAt: now.toISOString(),
  };
}

// ── Module 1: Heartbeat Health ──────────────────────────────────────

function analyzeHeartbeat(
  charger: { status: string; lastHeartbeat: Date | null; ocppId: string },
  now: Date,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'heartbeat_health',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  if (!charger.lastHeartbeat) {
    m.score = 0;
    m.status = 'offline';
    m.findings.push('No heartbeat has ever been received from this charger.');
    m.recommendations.push('Verify charger is powered on and OCPP endpoint is correctly configured.');
    return m;
  }

  const ageMin = (now.getTime() - charger.lastHeartbeat.getTime()) / 60_000;

  if (ageMin > HEARTBEAT_STALE_MINUTES) {
    m.score = 10;
    m.status = 'offline';
    m.findings.push(`Last heartbeat was ${Math.round(ageMin)} minutes ago (threshold: ${HEARTBEAT_STALE_MINUTES}min).`);
    m.recommendations.push('Check network connectivity, power supply, and OCPP WebSocket connection.');
    m.recommendations.push('If charger is powered, perform a hard reset.');
  } else if (ageMin > HEARTBEAT_WARNING_MINUTES) {
    m.score = 60;
    m.status = 'degraded';
    m.findings.push(`Heartbeat is ${Math.round(ageMin)} minutes old — approaching staleness.`);
    m.recommendations.push('Monitor heartbeat frequency; may indicate intermittent connectivity.');
  } else {
    m.findings.push(`Heartbeat is fresh (${Math.round(ageMin)} minutes ago).`);
  }

  if (charger.status === 'FAULTED') {
    m.score = Math.min(m.score, 20);
    m.status = 'critical';
    m.findings.push('Charger status is FAULTED.');
    m.recommendations.push('Review StatusNotification error codes for fault details.');
  }

  return m;
}

// ── Module 2: Connector State Analysis ──────────────────────────────

function analyzeConnectorState(
  transitions: Array<{ fromStatus: string; toStatus: string; occurredAt: Date; connectorId: number; transitionType: string }>,
  connectors: Array<{ connectorId: number; status: string }>,
  h24Ago: Date,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'connector_state',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  if (transitions.length === 0) {
    m.findings.push('No connector state transitions in the last 7 days.');
    if (connectors.some((c) => c.status === 'UNAVAILABLE')) {
      m.score = 50;
      m.status = 'degraded';
      m.findings.push('One or more connectors are in UNAVAILABLE state.');
      m.recommendations.push('Investigate why connectors are unavailable — may need soft reset or physical inspection.');
    }
    return m;
  }

  // Count fault transitions in 24h
  const recentFaults = transitions.filter(
    (t) => t.toStatus === 'FAULTED' && t.occurredAt >= h24Ago,
  );

  if (recentFaults.length >= FAULT_TRANSITION_THRESHOLD) {
    m.score = 15;
    m.status = 'critical';
    m.findings.push(`${recentFaults.length} fault transitions in last 24h (threshold: ${FAULT_TRANSITION_THRESHOLD}).`);
    m.recommendations.push('Charger experiencing repeated faults — schedule field service inspection.');
    m.recommendations.push('Check for ground faults, overheating, or damaged connectors.');
  } else if (recentFaults.length > 0) {
    m.score = 65;
    m.status = 'degraded';
    m.findings.push(`${recentFaults.length} fault transition(s) in last 24h.`);
    m.recommendations.push('Monitor for recurrence; single faults may be transient.');
  }

  // Detect rapid cycling (>10 transitions/hour)
  const hourBuckets = new Map<string, number>();
  for (const t of transitions.filter((t) => t.occurredAt >= h24Ago)) {
    const hourKey = t.occurredAt.toISOString().slice(0, 13);
    hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);
  }
  const maxPerHour = Math.max(0, ...hourBuckets.values());
  if (maxPerHour > 10) {
    m.score = Math.min(m.score, 30);
    m.status = 'critical';
    m.findings.push(`Rapid state cycling detected: ${maxPerHour} transitions in a single hour.`);
    m.recommendations.push('Possible hardware issue or unstable vehicle connection causing rapid state changes.');
  }

  // Stuck state detection
  for (const conn of connectors) {
    if (conn.status === 'FAULTED') {
      m.score = Math.min(m.score, 25);
      m.status = 'critical';
      m.findings.push(`Connector #${conn.connectorId} is currently in FAULTED state.`);
      m.recommendations.push(`Attempt soft reset for connector #${conn.connectorId}; if unresolved, perform hard reset.`);
    }
  }

  if (m.findings.length === 0) {
    m.findings.push('Connector state transitions appear normal.');
  }

  return m;
}

// ── Module 3: Session Anomalies ─────────────────────────────────────

function analyzeSessionAnomalies(
  sessions: Array<{
    id: string;
    status: string;
    startedAt: Date;
    stoppedAt: Date | null;
    kwhDelivered: number | null;
    meterStart: number | null;
    meterStop: number | null;
    payment: { status: string } | null;
  }>,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'session_anomalies',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  if (sessions.length === 0) {
    m.status = 'unknown';
    m.findings.push('No sessions in the analysis window — cannot assess session health.');
    return m;
  }

  const failedSessions = sessions.filter((s) => s.status === 'FAILED');
  const zeroKwh = sessions.filter(
    (s) => s.status === 'COMPLETED' && (s.kwhDelivered === 0 || s.kwhDelivered === null) && s.meterStop === s.meterStart,
  );
  const shortSessions = sessions.filter((s) => {
    if (!s.stoppedAt) return false;
    const durationSec = (s.stoppedAt.getTime() - s.startedAt.getTime()) / 1000;
    return s.status === 'COMPLETED' && durationSec < MIN_SESSION_DURATION_SEC;
  });

  const totalCompleted = sessions.filter((s) => s.status === 'COMPLETED').length;

  if (failedSessions.length > 0) {
    const failRate = sessions.length > 0 ? failedSessions.length / sessions.length : 0;
    if (failRate > 0.3) {
      m.score = 20;
      m.status = 'critical';
    } else if (failRate > 0.1) {
      m.score = 55;
      m.status = 'degraded';
    } else {
      m.score = 80;
    }
    m.findings.push(`${failedSessions.length}/${sessions.length} sessions failed (${(failRate * 100).toFixed(0)}% failure rate).`);
    m.recommendations.push('Investigate failed session OCPP logs for Authorize/StartTransaction rejections.');
  }

  if (zeroKwh.length > 0 && totalCompleted > 0) {
    const zeroRate = zeroKwh.length / totalCompleted;
    m.score = Math.min(m.score, zeroRate > 0.3 ? 30 : zeroRate > 0.1 ? 60 : 85);
    if (zeroRate > 0.1) m.status = m.status === 'critical' ? 'critical' : 'degraded';
    m.findings.push(`${zeroKwh.length} completed session(s) delivered 0 kWh — possible metering or relay issue.`);
    m.recommendations.push('Check charger relay/contactor function and meter calibration.');
  }

  if (shortSessions.length > 2) {
    m.score = Math.min(m.score, 65);
    m.status = m.status === 'critical' ? 'critical' : 'degraded';
    m.findings.push(`${shortSessions.length} sessions ended in under ${MIN_SESSION_DURATION_SEC}s — possible start/stop flapping.`);
    m.recommendations.push('May indicate loose connector, vehicle-side fault, or authorization timeout.');
  }

  if (m.findings.length === 0) {
    m.findings.push(`${sessions.length} recent sessions — no anomalies detected.`);
  }

  return m;
}

// ── Module 4: OCPP Error Analysis ───────────────────────────────────

function analyzeOcppErrors(
  logs: Array<{ action: string | null; messageType: number; payload: unknown; createdAt: Date }>,
  h24Ago: Date,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'ocpp_errors',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  const recent = logs.filter((l) => l.createdAt >= h24Ago);
  const callErrors = recent.filter((l) => l.messageType === 4); // CALLERROR
  const statusNotifs = recent.filter((l) => l.action === 'StatusNotification');

  if (callErrors.length > 5) {
    m.score = 30;
    m.status = 'critical';
    m.findings.push(`${callErrors.length} OCPP CALLERROR messages in last 24h — protocol-level failures.`);
    m.recommendations.push('Review CALLERROR payloads for error codes (InternalError, NotSupported, etc.).');
  } else if (callErrors.length > 0) {
    m.score = 75;
    m.status = 'degraded';
    m.findings.push(`${callErrors.length} CALLERROR message(s) in last 24h.`);
  }

  // Check for error codes in StatusNotification payloads
  const errorStatuses = statusNotifs.filter((l) => {
    const p = l.payload as Record<string, unknown> | null;
    return p && p.errorCode && p.errorCode !== 'NoError';
  });

  if (errorStatuses.length > 0) {
    const errorCodes = [...new Set(errorStatuses.map((l) => {
      const p = l.payload as Record<string, unknown>;
      return String(p.errorCode ?? 'Unknown');
    }))];
    m.score = Math.min(m.score, errorCodes.length > 2 ? 25 : 55);
    m.status = m.status === 'critical' ? 'critical' : 'degraded';
    m.findings.push(`StatusNotification error codes in 24h: ${errorCodes.join(', ')}.`);
    m.recommendations.push('Error codes indicate hardware or configuration issues — cross-reference with charger vendor docs.');
  }

  // Rejected remote commands
  const rejectedCommands = recent.filter((l) => {
    const p = l.payload as Record<string, unknown> | null;
    return p && (p.status === 'Rejected' || p.status === 'NotSupported');
  });

  if (rejectedCommands.length > 2) {
    m.score = Math.min(m.score, 50);
    m.status = m.status === 'critical' ? 'critical' : 'degraded';
    m.findings.push(`${rejectedCommands.length} remote commands rejected by charger in 24h.`);
    m.recommendations.push('Verify charger firmware supports the commands being sent; check authorization/idTag configuration.');
  }

  if (m.findings.length === 0) {
    m.findings.push('No significant OCPP errors in last 24h.');
  }

  return m;
}

// ── Module 5: Uptime Trend ──────────────────────────────────────────

function analyzeUptimeTrend(
  daily: Array<{ date: Date; uptimePercent: number; outageSeconds: number }>,
  events: Array<{ event: string; reason: string | null; createdAt: Date }>,
  d7Ago: Date,
  d30Ago: Date,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'uptime_trend',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  if (daily.length === 0) {
    m.status = 'unknown';
    m.findings.push('No uptime data available for trend analysis.');
    return m;
  }

  const d7 = daily.filter((d) => d.date >= d7Ago);
  const d30 = daily.filter((d) => d.date >= d30Ago);

  const avg7d = d7.length > 0 ? d7.reduce((s, d) => s + d.uptimePercent, 0) / d7.length : null;
  const avg30d = d30.length > 0 ? d30.reduce((s, d) => s + d.uptimePercent, 0) / d30.length : null;

  if (avg7d !== null) {
    if (avg7d < UPTIME_CRITICAL_PCT) {
      m.score = 15;
      m.status = 'critical';
      m.findings.push(`7-day average uptime is ${avg7d.toFixed(1)}% — critically low.`);
      m.recommendations.push('Charger has significant downtime — prioritize field service investigation.');
    } else if (avg7d < UPTIME_DEGRADED_PCT) {
      m.score = 55;
      m.status = 'degraded';
      m.findings.push(`7-day average uptime is ${avg7d.toFixed(1)}% — below target of ${UPTIME_DEGRADED_PCT}%.`);
      m.recommendations.push('Review outage events and schedule preventive maintenance.');
    } else {
      m.findings.push(`7-day uptime: ${avg7d.toFixed(1)}%.`);
    }
  }

  // Trend detection: 7d vs 30d
  if (avg7d !== null && avg30d !== null && avg30d > 0) {
    const delta = avg7d - avg30d;
    if (delta < -5) {
      m.score = Math.min(m.score, 45);
      m.status = m.status === 'critical' ? 'critical' : 'degraded';
      m.findings.push(`Uptime trending down: 7d avg ${avg7d.toFixed(1)}% vs 30d avg ${avg30d.toFixed(1)}% (${delta.toFixed(1)}pp decline).`);
      m.recommendations.push('Degrading trend suggests emerging hardware or connectivity issue.');
    } else if (delta > 5) {
      m.findings.push(`Uptime improving: 7d avg ${avg7d.toFixed(1)}% vs 30d avg ${avg30d.toFixed(1)}%.`);
    }
  }

  // Recent outage events
  const faultEvents = events.filter((e) => e.event === 'FAULTED' || e.event === 'OFFLINE');
  if (faultEvents.length > 5) {
    m.score = Math.min(m.score, 40);
    m.findings.push(`${faultEvents.length} fault/offline events in last 30 days.`);
  }

  return m;
}

// ── Module 6: Power Delivery ────────────────────────────────────────

function analyzePowerDelivery(
  logs: Array<{ action: string | null; payload: unknown; createdAt: Date }>,
  sessions: Array<{ status: string; kwhDelivered: number | null; startedAt: Date; stoppedAt: Date | null }>,
): HealthModuleResult {
  const m: HealthModuleResult = {
    module: 'power_delivery',
    score: 100,
    status: 'healthy',
    findings: [],
    recommendations: [],
  };

  const meterValues = logs.filter((l) => l.action === 'MeterValues');

  if (meterValues.length === 0 && sessions.length === 0) {
    m.status = 'unknown';
    m.findings.push('No meter data or sessions to assess power delivery.');
    return m;
  }

  // Check for stalled energy during ACTIVE sessions (meter values not incrementing)
  if (meterValues.length >= 3) {
    const energyReadings: number[] = [];
    for (const mv of meterValues.slice(0, 20)) {
      const p = mv.payload as Record<string, unknown> | null;
      if (!p) continue;
      const values = (p.meterValue ?? p.meterValues) as Array<{ sampledValue?: Array<{ value?: string; measurand?: string }> }> | undefined;
      if (!Array.isArray(values)) continue;
      for (const mv2 of values) {
        for (const sv of mv2.sampledValue ?? []) {
          if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
            const val = parseFloat(sv.value ?? '');
            if (!isNaN(val)) energyReadings.push(val);
          }
        }
      }
    }

    if (energyReadings.length >= 3) {
      // Check if energy is incrementing
      const diffs: number[] = [];
      for (let i = 1; i < energyReadings.length; i++) {
        diffs.push(energyReadings[i - 1] - energyReadings[i]); // reversed order (newest first)
      }
      const stalledCount = diffs.filter((d) => Math.abs(d) < 1).length; // < 1 Wh change
      if (stalledCount > diffs.length * 0.5 && diffs.length >= 3) {
        m.score = 40;
        m.status = 'degraded';
        m.findings.push('Energy meter readings appear stalled — minimal energy flow between consecutive readings.');
        m.recommendations.push('Check charger relay/contactor, cable condition, and vehicle-side charge acceptance.');
      }
    }
  }

  // Delivery consistency across sessions
  const completedWithKwh = sessions.filter((s) => s.status === 'COMPLETED' && s.kwhDelivered != null && s.kwhDelivered > 0);
  if (completedWithKwh.length >= 3) {
    const avgKwh = completedWithKwh.reduce((s, sess) => s + (sess.kwhDelivered ?? 0), 0) / completedWithKwh.length;
    const variance = completedWithKwh.reduce((s, sess) => s + Math.pow((sess.kwhDelivered ?? 0) - avgKwh, 2), 0) / completedWithKwh.length;
    const cv = avgKwh > 0 ? Math.sqrt(variance) / avgKwh : 0;

    if (cv > 1.5) {
      m.score = Math.min(m.score, 60);
      m.status = m.status === 'critical' ? 'critical' : 'degraded';
      m.findings.push(`High variability in energy delivered per session (CV=${cv.toFixed(2)}) — inconsistent charging behavior.`);
      m.recommendations.push('May indicate intermittent hardware issue or mixed vehicle types with very different charge profiles.');
    } else {
      m.findings.push(`Average energy per session: ${avgKwh.toFixed(1)} kWh across ${completedWithKwh.length} sessions.`);
    }
  }

  if (m.findings.length === 0) {
    m.findings.push('Power delivery appears normal based on available data.');
  }

  return m;
}

// ── Helpers ─────────────────────────────────────────────────────────

function rankCauses(modules: HealthModuleResult[], charger: { status: string }): string[] {
  const causes: string[] = [];

  if (charger.status === 'OFFLINE') {
    causes.push('Charger is offline — likely network or power issue.');
  }
  if (charger.status === 'FAULTED') {
    causes.push('Charger is in FAULTED state — hardware or firmware fault.');
  }

  // Sort modules by severity (lowest score first)
  const sorted = [...modules].filter((m) => m.status !== 'unknown').sort((a, b) => a.score - b.score);

  for (const mod of sorted) {
    if (mod.score >= 80) continue;
    switch (mod.module) {
      case 'heartbeat_health':
        if (mod.score < 30) causes.push('Network connectivity loss or charger power failure.');
        break;
      case 'connector_state':
        if (mod.score < 30) causes.push('Connector hardware fault — repeated fault state transitions.');
        else if (mod.score < 70) causes.push('Intermittent connector issue — occasional faults or cycling.');
        break;
      case 'session_anomalies':
        if (mod.score < 30) causes.push('High session failure rate — possible authorization or relay problem.');
        else if (mod.score < 70) causes.push('Session quality issues — zero-kWh or very short sessions.');
        break;
      case 'ocpp_errors':
        if (mod.score < 30) causes.push('Frequent OCPP protocol errors — firmware or configuration issue.');
        break;
      case 'uptime_trend':
        if (mod.score < 50) causes.push('Significant uptime degradation — systemic reliability problem.');
        break;
      case 'power_delivery':
        if (mod.score < 50) causes.push('Stalled or inconsistent power delivery — metering or relay issue.');
        break;
    }
  }

  return [...new Set(causes)].slice(0, 5);
}

function buildSummary(
  ocppId: string,
  status: ChargerHealthReport['overallStatus'],
  score: number,
  findings: string[],
): string {
  const statusLabel = { healthy: 'healthy', degraded: 'experiencing issues', critical: 'in critical condition', offline: 'offline' }[status];
  const topIssue = findings.find((f) => !f.includes('normal') && !f.includes('fresh') && !f.includes('No significant'));
  return `Charger ${ocppId} is ${statusLabel} (score: ${score}/100).${topIssue ? ` Key finding: ${topIssue}` : ''}`;
}
