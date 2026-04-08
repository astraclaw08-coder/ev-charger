import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { writeAdminAudit } from '../lib/adminAudit';

/** Check if operator is admin/superadmin/owner (can manage any org) */
function isAdminLevel(roles: string[]): boolean {
  return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

export async function portfolioRoutes(app: FastifyInstance) {
  // GET /portfolios — list portfolios, optionally filtered by orgId
  app.get<{ Querystring: { orgId?: string } }>('/portfolios', {
    preHandler: [requireOperator, requirePolicy('portfolio.list')],
  }, async (req) => {
    const operator = req.currentOperator!;
    const claimsOrgId = operator.claims?.orgId;
    const queryOrgId = (req.query as any).orgId as string | undefined;

    // Non-admin operators scoped to their org only
    const orgFilter = claimsOrgId
      ? { organizationId: claimsOrgId }
      : queryOrgId
        ? { organizationId: queryOrgId }
        : {};

    const portfolios = await prisma.portfolio.findMany({
      where: orgFilter,
      include: {
        organization: { select: { id: true, name: true } },
        _count: { select: { sites: true } },
      },
      orderBy: [{ organization: { name: 'asc' } }, { name: 'asc' }],
    });

    return portfolios.map((p) => ({
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      organizationName: p.organization.name,
      description: p.description,
      isGlobal: p.isGlobal,
      siteCount: p._count.sites,
      createdAt: p.createdAt.toISOString(),
    }));
  });

  // GET /portfolios/:id — single portfolio
  app.get<{ Params: { id: string } }>('/portfolios/:id', {
    preHandler: [requireOperator, requirePolicy('portfolio.read')],
  }, async (req, reply) => {
    const p = await prisma.portfolio.findUnique({
      where: { id: req.params.id },
      include: {
        organization: { select: { id: true, name: true } },
        _count: { select: { sites: true } },
      },
    });
    if (!p) return reply.status(404).send({ error: 'Portfolio not found' });

    return {
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      organizationName: p.organization.name,
      description: p.description,
      isGlobal: p.isGlobal,
      siteCount: p._count.sites,
      createdAt: p.createdAt.toISOString(),
    };
  });

  // POST /portfolios — create within an org
  app.post<{
    Body: { name: string; organizationId: string; description?: string };
  }>('/portfolios', {
    preHandler: [requireOperator, requirePolicy('portfolio.create')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const { name, organizationId, description } = req.body;

    if (!name?.trim()) return reply.status(400).send({ error: 'Portfolio name is required' });
    if (!organizationId) return reply.status(400).send({ error: 'organizationId is required' });

    // Verify the target org exists
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) return reply.status(404).send({ error: 'Organization not found' });

    // RBAC: non-admin operators can only create portfolios in their own org
    const roles = operator.roles ?? [];
    const claimsOrgId = operator.claims?.orgId;
    if (!isAdminLevel(roles) && claimsOrgId && claimsOrgId !== organizationId) {
      return reply.status(403).send({ error: 'You can only create portfolios in your own organization' });
    }

    try {
      const portfolio = await prisma.portfolio.create({
        data: {
          name: name.trim(),
          organizationId,
          description: description?.trim() || null,
          isGlobal: false,
          createdByOperatorId: operator.id,
        },
      });

      await writeAdminAudit({
        operatorId: operator.id,
        action: 'portfolio.create',
        metadata: { portfolioId: portfolio.id, name: portfolio.name, organizationId },
      });

      return reply.status(201).send(portfolio);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: `Portfolio "${name.trim()}" already exists in this organization` });
      }
      throw err;
    }
  });

  // PUT /portfolios/:id — update
  app.put<{
    Params: { id: string };
    Body: { name?: string; description?: string };
  }>('/portfolios/:id', {
    preHandler: [requireOperator, requirePolicy('portfolio.update')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await prisma.portfolio.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Portfolio not found' });

    // RBAC: non-admin operators can only modify portfolios in their own org
    const roles = operator.roles ?? [];
    const claimsOrgId = operator.claims?.orgId;
    if (!isAdminLevel(roles) && claimsOrgId && claimsOrgId !== existing.organizationId) {
      return reply.status(403).send({ error: 'You can only update portfolios in your own organization' });
    }

    const { name, description } = req.body;

    try {
      const updated = await prisma.portfolio.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description?.trim() || null }),
        },
      });

      await writeAdminAudit({
        operatorId: operator.id,
        action: 'portfolio.update',
        metadata: { portfolioId: updated.id, changes: req.body },
      });

      return updated;
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: `Portfolio "${name}" already exists in this organization` });
      }
      throw err;
    }
  });

  // DELETE /portfolios/:id — hard delete, nullify site references
  app.delete<{ Params: { id: string } }>('/portfolios/:id', {
    preHandler: [requireOperator, requirePolicy('portfolio.delete')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const existing = await prisma.portfolio.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Portfolio not found' });

    // RBAC: non-admin operators can only delete portfolios in their own org
    const roles = operator.roles ?? [];
    const claimsOrgId = operator.claims?.orgId;
    if (!isAdminLevel(roles) && claimsOrgId && claimsOrgId !== existing.organizationId) {
      return reply.status(403).send({ error: 'You can only delete portfolios in your own organization' });
    }

    // Nullify references on sites, then delete
    await prisma.site.updateMany({
      where: { portfolioId: req.params.id },
      data: { portfolioId: null, portfolioName: null },
    });

    await prisma.portfolio.delete({ where: { id: req.params.id } });

    await writeAdminAudit({
      operatorId: operator.id,
      action: 'portfolio.delete',
      metadata: { portfolioId: req.params.id, name: existing.name, organizationId: existing.organizationId },
    });

    return { success: true };
  });

  // POST /portfolios/assign-cross-org — admin-only: replicate portfolio name across orgs
  app.post<{
    Body: { name: string; organizationIds: string[]; description?: string };
  }>('/portfolios/assign-cross-org', {
    preHandler: [requireOperator, requirePolicy('portfolio.assign_cross_org')],
  }, async (req, reply) => {
    const operator = req.currentOperator!;
    const { name, organizationIds, description } = req.body;

    if (!name?.trim()) return reply.status(400).send({ error: 'Portfolio name is required' });
    if (!organizationIds?.length) return reply.status(400).send({ error: 'At least one organizationId is required' });

    // Verify all orgs exist
    const orgs = await prisma.organization.findMany({
      where: { id: { in: organizationIds } },
      select: { id: true },
    });
    if (orgs.length !== organizationIds.length) {
      return reply.status(400).send({ error: 'One or more organization IDs are invalid' });
    }

    const results = [];
    for (const orgId of organizationIds) {
      try {
        const p = await prisma.portfolio.upsert({
          where: { name_organizationId: { name: name.trim(), organizationId: orgId } },
          create: {
            name: name.trim(),
            organizationId: orgId,
            description: description?.trim() || null,
            isGlobal: true,
            createdByOperatorId: operator.id,
          },
          update: { isGlobal: true },
        });
        results.push(p);
      } catch { /* skip duplicates */ }
    }

    await writeAdminAudit({
      operatorId: operator.id,
      action: 'portfolio.assign_cross_org',
      metadata: { name: name.trim(), organizationIds, createdCount: results.length },
    });

    return { created: results.length, portfolios: results };
  });
}
