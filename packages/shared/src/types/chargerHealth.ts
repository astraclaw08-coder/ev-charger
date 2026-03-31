/**
 * Charger Health Assessment — shared types for API + portal
 */

export interface HealthModuleResult {
  module: string;
  score: number; // 0-100
  status: 'healthy' | 'degraded' | 'critical' | 'offline' | 'unknown';
  findings: string[];
  recommendations: string[];
}

export interface ChargerHealthReport {
  chargerId: string;
  ocppId: string;
  connectorId?: number;
  overallScore: number; // 0-100
  overallStatus: 'healthy' | 'degraded' | 'critical' | 'offline';
  modules: HealthModuleResult[];
  summary: string;
  likelyCauses: string[];
  recommendedActions: string[];
  assessedAt: string; // ISO timestamp
}
