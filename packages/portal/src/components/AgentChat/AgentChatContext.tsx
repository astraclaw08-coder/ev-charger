import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatTab, DiagnosticRequest } from './types';

// ── Constants ──────────────────────────────────────────────────────
const TABS_STORAGE_KEY = 'lumeo.agent-chat.tabs';
const MAX_DIAGNOSTIC_TABS = 3;

const GENERAL_TAB: ChatTab = {
  id: 'general',
  label: 'General',
  type: 'general',
  storageKey: 'lumeo.agent-chat.messages',
  seedState: 'idle',
  seedVersion: 0,
  createdAt: Date.now(),
  lastViewedAt: Date.now(),
};

// ── Context type ───────────────────────────────────────────────────
type AgentChatContextValue = {
  isOpen: boolean;
  openChat: () => void;
  closeChat: () => void;
  toggleChat: () => void;
  tabs: ChatTab[];
  activeTabId: string;
  setActiveTab: (tabId: string) => void;
  openDiagnostic: (req: DiagnosticRequest) => void;
  closeTab: (tabId: string) => void;
  markTabSent: (tabId: string) => void;
  clearTabSeed: (tabId: string) => void;
};

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

// ── Helpers ────────────────────────────────────────────────────────
function loadTabs(): ChatTab[] {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatTab[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure General tab is always present
        const hasGeneral = parsed.some((t) => t.id === 'general');
        if (!hasGeneral) return [GENERAL_TAB, ...parsed];
        return parsed;
      }
    }
  } catch { /* corrupted — fall back */ }
  return [GENERAL_TAB];
}

function saveTabs(tabs: ChatTab[]) {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
  } catch { /* storage full */ }
}

function formatLastHeartbeat(lastHeartbeat: string | null): string {
  if (!lastHeartbeat) return 'never reported';
  const date = new Date(lastHeartbeat);
  if (isNaN(date.getTime())) return 'unknown';
  const agoMs = Date.now() - date.getTime();
  const mins = Math.floor(agoMs / 60_000);
  if (mins < 1) return `just now (${date.toISOString()})`;
  if (mins < 60) return `${mins}m ago (${date.toISOString()})`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago (${date.toISOString()})`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago (${date.toISOString()})`;
}

function buildDiagnosticPrompt(req: DiagnosticRequest): string {
  const heartbeatStr = formatLastHeartbeat(req.lastHeartbeat);
  return `Diagnose charger ${req.ocppId} (ID: ${req.chargerId}). Current status: ${req.status}. Last heartbeat: ${heartbeatStr}. Check recent OCPP logs, error codes, and connectivity patterns. Determine if the charger is ready for operation and recommend next steps if not.`;
}

// ── Provider ───────────────────────────────────────────────────────
export function AgentChatProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tabs, setTabs] = useState<ChatTab[]>(loadTabs);
  const [activeTabId, setActiveTabId] = useState('general');
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Persist tabs whenever they change
  useEffect(() => {
    saveTabs(tabs);
  }, [tabs]);

  const openChat = useCallback(() => setIsOpen(true), []);
  const closeChat = useCallback(() => setIsOpen(false), []);
  const toggleChat = useCallback(() => setIsOpen((v) => !v), []);

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, lastViewedAt: Date.now() } : t)),
    );
  }, []);

  const openDiagnostic = useCallback((req: DiagnosticRequest) => {
    const tabId = `diag-${req.chargerId}`;
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((t) => t.id === tabId);

    // Check limit before creating new tab
    if (!existing) {
      const diagCount = currentTabs.filter((t) => t.type === 'diagnostic').length;
      if (diagCount >= MAX_DIAGNOSTIC_TABS) {
        showToast('Close an existing diagnostic tab first (max 3)');
        return;
      }
    }

    setTabs((prev) => {
      const ex = prev.find((t) => t.id === tabId);
      if (ex) {
        // Existing tab with completed seed — just focus
        if (ex.seedState === 'sent') {
          return prev.map((t) =>
            t.id === tabId ? { ...t, lastViewedAt: Date.now() } : t,
          );
        }
        // Existing tab that was cleared (idle) — reseed
        const prompt = buildDiagnosticPrompt(req);
        return prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                initialPrompt: prompt,
                seedState: 'pending' as const,
                seedVersion: t.seedVersion + 1,
                lastViewedAt: Date.now(),
              }
            : t,
        );
      }

      // New tab
      const prompt = buildDiagnosticPrompt(req);
      const newTab: ChatTab = {
        id: tabId,
        label: req.ocppId,
        type: 'diagnostic',
        chargerId: req.chargerId,
        ocppId: req.ocppId,
        status: req.status,
        storageKey: `lumeo.agent-chat.diag.${req.chargerId}`,
        initialPrompt: prompt,
        seedState: 'pending',
        seedVersion: 1,
        createdAt: Date.now(),
        lastViewedAt: Date.now(),
      };
      return [...prev, newTab];
    });

    setActiveTabId(tabId);
    setIsOpen(true);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    if (tabId === 'general') return; // Can't close General
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveTabId((prev) => (prev === tabId ? 'general' : prev));
  }, []);

  const markTabSent = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, seedState: 'sent' as const } : t,
      ),
    );
  }, []);

  const clearTabSeed = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, seedState: 'idle' as const, initialPrompt: undefined }
          : t,
      ),
    );
  }, []);

  return (
    <AgentChatContext.Provider
      value={{
        isOpen,
        openChat,
        closeChat,
        toggleChat,
        tabs,
        activeTabId,
        setActiveTab,
        openDiagnostic,
        closeTab,
        markTabSent,
        clearTabSeed,
      }}
    >
      {children}
    </AgentChatContext.Provider>
  );
}

export function useAgentChatContext(): AgentChatContextValue {
  const ctx = useContext(AgentChatContext);
  if (!ctx) throw new Error('useAgentChatContext must be used within AgentChatProvider');
  return ctx;
}

// ── Simple toast helper ────────────────────────────────────────────
function showToast(message: string) {
  const el = document.createElement('div');
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '8px 16px',
    borderRadius: '8px',
    backgroundColor: '#1e293b',
    color: '#f1f5f9',
    fontSize: '13px',
    fontWeight: '600',
    zIndex: '9999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    transition: 'opacity 0.3s',
  });
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
