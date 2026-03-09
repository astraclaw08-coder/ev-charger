import { prisma } from '@ev-charger/shared';

export async function writeAdminAudit(args: {
  operatorId: string;
  action: string;
  targetUserId?: string;
  targetEmail?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.adminAuditEvent.create({
    data: {
      operatorId: args.operatorId,
      action: args.action,
      targetUserId: args.targetUserId,
      targetEmail: args.targetEmail,
      metadata: (args.metadata ?? {}) as any,
    },
  });
}
