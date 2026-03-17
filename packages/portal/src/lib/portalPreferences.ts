export type PortalRolePreference = 'executive' | 'operations' | 'finance' | 'field' | 'admin';

const ROLE_KEY = 'portal.pref.role';

export function getRolePreference(): PortalRolePreference {
  if (typeof window === 'undefined') return 'operations';
  const raw = window.localStorage.getItem(ROLE_KEY);
  if (raw === 'executive' || raw === 'operations' || raw === 'finance' || raw === 'field' || raw === 'admin') return raw;
  return 'operations';
}

export function setRolePreference(role: PortalRolePreference) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ROLE_KEY, role);
}

export function getDefaultHomePath(_role: PortalRolePreference): string {
  return '/overview';
}
