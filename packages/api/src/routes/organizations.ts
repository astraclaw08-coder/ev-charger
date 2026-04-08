import type { FastifyInstance } from 'fastify';
import { prisma } from '@ev-charger/shared';
import { requireOperator } from '../plugins/auth';
import { requirePolicy } from '../plugins/authorization';
import { writeAdminAudit } from '../lib/adminAudit';

export async function organizationRoutes(app: FastifyInstance) {
  // GET /organizations — list all organizations (scoped by operator claims)
  app.get('/organizations', {
    preHandler: [requireOperator, requirePolicy('org.list')],
  }, async (req) => {
    const operator = req.currentOperator!;
    const claims = operator.claims;
    const orgId = claims?.orgId;

    // If operator is scoped to a specific org, only return that org
    const where = orgId ? { id: orgId } : {};

    const orgs = await prisma.organization.findMany({
      where,
      include: {
        _count: { select: { sites: true, portfolios: true } },
      },
      orderBy: { name: 'asc' },
    });

    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      billingAddress: o.billingAddress,
      contactEmail: o.contactEmail,
      contactPhone: o.contactPhone,
      status: o.status,
      siteCount: o._count.sites,
      portfolioCount: o._count.portfolios,
      createdAt: o.createdAt.toISOString(),
    }));
  });

  // GET /organizations/:id — get single org with counts
  app.get<{ Params: { id: string } }>('/organizations/:id', {
    preHandler: [requireOperator, requirePolicy('org.read')],
  }, async (req, reply) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { sites: true, portfolios: true } },
        portfolios: { orderBy: { name: 'asc' }, select: { id: true, name: true, description: true, isGlobal: true } },
      },
    });
    if (!org) return reply.status(404).send({ error: 'Organization not found' });

    return {
      id: org.id,
      name: org.name,
      billingAddress: org.billingAddress,
      contactEmail: org.contactEmail,
      contactPhone: org.contactPhone,
      status: org.status,
      siteCount: org._count.sites,
      portfolioCount: org._count.portfolios,
      portfolios: org.portfolios,
      createdAt: org.createdAt.toISOString(),
    };
  });

  // POST /organizations — create (admin/superadmin only)
  app.post<{
    Body: { name: string; billingAddress?: string; contactEmail?: string; contactPhone?: string };
  }>('/organizations', {
    preHandler: [requireOperator, requirePolicy('org.create')],
  }, async (req, reply) => {
    const { name, billingAddress, contactEmail, contactPhone } = req.body;
    if (!name?.trim()) return reply.status(400).send({ error: 'Organization name is required' });

    try {
      const org = await prisma.organization.create({
        data: {
          name: name.trim(),
          billingAddress: billingAddress?.trim() || null,
          contactEmail: contactEmail?.trim() || null,
          contactPhone: contactPhone?.trim() || null,
          createdByOperatorId: req.currentOperator!.id,
        },
      });

      await writeAdminAudit({
        operatorId: req.currentOperator!.id,
        action: 'organization.create',
        metadata: { organizationId: org.id, name: org.name },
      });

      return reply.status(201).send(org);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: `Organization "${name.trim()}" already exists` });
      }
      throw err;
    }
  });

  // PUT /organizations/:id — update (admin/superadmin only)
  app.put<{
    Params: { id: string };
    Body: { name?: string; billingAddress?: string; contactEmail?: string; contactPhone?: string; status?: string };
  }>('/organizations/:id', {
    preHandler: [requireOperator, requirePolicy('org.update')],
  }, async (req, reply) => {
    const existing = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Organization not found' });

    const { name, billingAddress, contactEmail, contactPhone, status } = req.body;

    try {
      const updated = await prisma.organization.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(billingAddress !== undefined && { billingAddress: billingAddress?.trim() || null }),
          ...(contactEmail !== undefined && { contactEmail: contactEmail?.trim() || null }),
          ...(contactPhone !== undefined && { contactPhone: contactPhone?.trim() || null }),
          ...(status !== undefined && { status }),
        },
      });

      await writeAdminAudit({
        operatorId: req.currentOperator!.id,
        action: 'organization.update',
        metadata: { organizationId: updated.id, changes: req.body },
      });

      return updated;
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: `Organization name "${name}" already exists` });
      }
      throw err;
    }
  });

  // DELETE /organizations/:id — soft-delete (set status=inactive)
  app.delete<{ Params: { id: string } }>('/organizations/:id', {
    preHandler: [requireOperator, requirePolicy('org.delete')],
  }, async (req, reply) => {
    const existing = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Organization not found' });

    await prisma.organization.update({
      where: { id: req.params.id },
      data: { status: 'inactive' },
    });

    await writeAdminAudit({
      operatorId: req.currentOperator!.id,
      action: 'organization.delete',
      metadata: { organizationId: req.params.id, name: existing.name },
    });

    return { success: true };
  });
}
