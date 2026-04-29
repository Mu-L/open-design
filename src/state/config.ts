import type { AppConfig, MediaProviderCredentials } from '../types';

const STORAGE_KEY = 'open-design:config';

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: false,
  mediaProviders: {},
  agentModels: {},
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      mediaProviders: { ...(parsed.mediaProviders ?? {}) },
      agentModels: { ...(parsed.agentModels ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * True when the credentials map has at least one provider with a
 * non-empty apiKey or baseUrl. Used to gate the bootstrap auto-sync —
 * pushing an empty map would wipe out keys the daemon already has from
 * env vars or a previous session, which is destructive for users who
 * configure on the daemon side only.
 */
export function hasAnyConfiguredProvider(
  providers: Record<string, MediaProviderCredentials> | undefined,
): boolean {
  if (!providers) return false;
  for (const v of Object.values(providers)) {
    if (!v) continue;
    if (typeof v.apiKey === 'string' && v.apiKey.trim()) return true;
    if (typeof v.baseUrl === 'string' && v.baseUrl.trim()) return true;
  }
  return false;
}

/**
 * Push the in-browser provider credentials map to the daemon so it can
 * dispatch real upstream calls. We fire-and-forget — failures fall back
 * to per-request resolution against env vars or stored config, so the
 * UX still works if the daemon is offline.
 */
export async function syncMediaProvidersToDaemon(
  providers: Record<string, MediaProviderCredentials> | undefined,
  options?: { force?: boolean },
): Promise<void> {
  if (!providers) return;
  try {
    await fetch('/api/media/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers, force: Boolean(options?.force) }),
    });
  } catch {
    // Daemon offline — frontend keeps the localStorage copy; user can
    // re-save later.
  }
}
