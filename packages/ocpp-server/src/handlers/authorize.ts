import { prisma } from '@ev-charger/shared';
import type { AuthorizeRequest, AuthorizeResponse } from '@ev-charger/shared';
import { putFleetAuthorize } from '../fleet/authorizeCache';
import { matchFleetPolicy, makePrismaFleetPolicyFetcher } from '../fleet/matchFleetPolicy';

// Flag read at call-time so tests and runtime env changes are honored.
function fleetFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

export async function handleAuthorize(
  _client: any,
  chargerId: string,
  params: AuthorizeRequest,
): Promise<AuthorizeResponse> {
  const { idTag } = params;
  console.log(`[Authorize] chargerId=${chargerId} idTag=${idTag}`);

  const user = await prisma.user.findUnique({ where: { idTag } });

  if (!user) {
    console.warn(`[Authorize] Unknown idTag: ${idTag}`);
    return { idTagInfo: { status: 'Invalid' } };
  }

  // ── Fleet-policy linkage (TASK-0208 Phase 2) ─────────────────────────
  // Flag-gated. On match, stash fleetPolicyId + wall-clock plugInAt in the
  // Authorize cache for StartTransaction to consume. Does NOT change the
  // Authorize response — fleet policies are enforced downstream via the
  // charging-profile scheduler (PR-c), not via the Accept/Invalid verdict.
  //
  // Any failure here is swallowed and logged: we never fail Authorize on
  // fleet-matching errors because the session should still be allowed to
  // start as a non-fleet session if policy resolution breaks.
  if (fleetFlagEnabled()) {
    try {
      const charger = await prisma.charger.findUnique({
        where: { id: chargerId },
        select: { siteId: true },
      });
      if (charger?.siteId) {
        const match = await matchFleetPolicy({
          siteId: charger.siteId,
          idTag,
          fetchPolicies: makePrismaFleetPolicyFetcher(prisma as any),
        });
        if (match) {
          putFleetAuthorize({
            chargerId,
            idTag,
            fleetPolicyId: match.id,
          });
          console.log(
            `[Authorize] fleet match: chargerId=${chargerId} idTag=${idTag} policy=${match.id}(${match.name})`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Authorize] fleet-match error (non-fatal, falling back to non-fleet): chargerId=${chargerId} idTag=${idTag} err=${msg}`,
      );
    }
  }

  return { idTagInfo: { status: 'Accepted' } };
}
