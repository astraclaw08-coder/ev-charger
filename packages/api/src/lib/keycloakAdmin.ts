type KeycloakUser = {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  createdTimestamp?: number;
};

type KeycloakRole = { id?: string; name: string };

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export class KeycloakAdminClient {
  private readonly baseUrl = requireEnv('KEYCLOAK_BASE_URL').replace(/\/$/, '');
  private readonly realm = requireEnv('KEYCLOAK_REALM');
  private readonly clientId = requireEnv('KEYCLOAK_ADMIN_CLIENT_ID');
  private readonly clientSecret = requireEnv('KEYCLOAK_ADMIN_CLIENT_SECRET');

  private token: { value: string; expiresAt: number } | null = null;

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 10_000) return this.token.value;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(`${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) throw new Error(`Keycloak token request failed (${res.status})`);
    const json = await res.json() as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: now + (json.expires_in * 1000) };
    return json.access_token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/admin/realms/${this.realm}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Keycloak admin request failed (${res.status}): ${text || res.statusText}`);
    }

    if (res.status === 204) return null as T;
    return res.json() as Promise<T>;
  }

  async listUsers(query?: { search?: string; first?: number; max?: number }) {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.first != null) params.set('first', String(query.first));
    if (query?.max != null) params.set('max', String(query.max));
    const qs = params.toString();
    return this.request<KeycloakUser[]>(`/users${qs ? `?${qs}` : ''}`);
  }

  async getUser(userId: string) {
    return this.request<KeycloakUser>(`/users/${userId}`);
  }

  async createUser(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    sendInvite?: boolean;
    temporaryPassword?: string;
  }) {
    const username = input.email.toLowerCase();

    await this.request<null>('/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        enabled: true,
        emailVerified: false,
      }),
    });

    const found = await this.listUsers({ search: input.email, max: 10 });
    const user = found.find((u) => (u.email ?? '').toLowerCase() === input.email.toLowerCase()) ?? found[0];
    if (!user?.id) throw new Error('User created but could not be reloaded from Keycloak');

    if (input.temporaryPassword) {
      await this.request<null>(`/users/${user.id}/reset-password`, {
        method: 'PUT',
        body: JSON.stringify({ type: 'password', temporary: true, value: input.temporaryPassword }),
      });
    }

    if (input.sendInvite) {
      await this.executeActionsEmail(user.id, ['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
    }

    return user;
  }

  async getRealmRole(roleName: string) {
    return this.request<KeycloakRole>(`/roles/${encodeURIComponent(roleName)}`);
  }

  async listRealmRolesForUser(userId: string) {
    return this.request<KeycloakRole[]>(`/users/${userId}/role-mappings/realm`);
  }

  async addRealmRole(userId: string, roleName: string) {
    const role = await this.getRealmRole(roleName);
    await this.request<null>(`/users/${userId}/role-mappings/realm`, {
      method: 'POST',
      body: JSON.stringify([role]),
    });
  }

  async removeRealmRole(userId: string, roleName: string) {
    const role = await this.getRealmRole(roleName);
    await this.request<null>(`/users/${userId}/role-mappings/realm`, {
      method: 'DELETE',
      body: JSON.stringify([role]),
    });
  }

  async setEnabled(userId: string, enabled: boolean) {
    const current = await this.getUser(userId);
    await this.request<null>(`/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...current,
        enabled,
      }),
    });
  }

  async executeActionsEmail(userId: string, actions: string[]) {
    await this.request<null>(`/users/${userId}/execute-actions-email`, {
      method: 'PUT',
      body: JSON.stringify(actions),
    });
  }

  async logoutUser(userId: string) {
    await this.request<null>(`/users/${userId}/logout`, { method: 'POST' });
  }
}

export function getKeycloakAdminClient() {
  return new KeycloakAdminClient();
}
