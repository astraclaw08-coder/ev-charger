import { prisma } from '@ev-charger/shared';
import type { AuthorizeRequest, AuthorizeResponse } from '@ev-charger/shared';

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

  return { idTagInfo: { status: 'Accepted' } };
}
