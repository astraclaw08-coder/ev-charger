import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { createApiClient } from '../../api/client';
import { useToken } from '../../auth/TokenContext';
import { useAgentChat } from './useAgentChat';
import { useAgentChatContext } from './AgentChatContext';
import AgentChatInput from './AgentChatInput';
import AgentChatMessage from './AgentChatMessage';
import type { ChatTab } from './types';

// ── Diagnostic start event (replaces user bubble for seed messages) ─
function DiagnosticStartEvent({ ocppId, status }: { ocppId?: string; status?: string }) {
  const statusColor =
    status === 'FAULTED' ? 'text-red-500' :
    status === 'OFFLINE' ? 'text-yellow-500' :
    'text-green-500';

  return (
    <div className="flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-blue-500 shrink-0" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">
        Diagnostic started for {ocppId ?? 'charger'}
        {status && <span className={cn('ml-1', statusColor)}>({status})</span>}
      </span>
    </div>
  );
}

// ── Main panel component ──────────────────────────────────────────
export default function AgentChatPanel() {
  const {
    isOpen,
    toggleChat,
    closeChat,
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    markTabSent,
    clearTabSeed,
  } = useAgentChatContext();

  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const getToken = useToken();

  // Check AI connection status on mount
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const res = await api.getAIStatus();
        if (!cancelled) setAiConfigured(res.connected);
      } catch {
        if (!cancelled) setAiConfigured(null);
      }
    }
    check();
    return () => { cancelled = true; };
  }, [getToken]);

  // Keyboard shortcut: Cmd+Shift+A to toggle
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleChat();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [toggleChat]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <>
      {/* Floating trigger button */}
      {!isOpen && (
        <FloatingButton onClick={toggleChat} />
      )}

      {/* Backdrop (mobile) */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm sm:hidden"
          onClick={closeChat}
        />
      )}

      {/* Panel */}
      <div
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[420px] bg-white dark:bg-slate-900 shadow-2xl border-l border-gray-200 dark:border-slate-700 transition-transform duration-300 ease-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <PanelHeader aiConfigured={aiConfigured} onClose={closeChat} />

        {/* Tab bar */}
        {tabs.length > 1 && (
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTab}
            onCloseTab={closeTab}
          />
        )}

        {/* Tab session (remounts per tab) */}
        <ActiveTabSession
          key={activeTab.id}
          tab={activeTab}
          onMarkSent={markTabSent}
          onClearSeed={clearTabSeed}
        />
      </div>
    </>
  );
}

// ── Active tab session (the actual chat content) ──────────────────
function ActiveTabSession({
  tab,
  onMarkSent,
  onClearSeed,
}: {
  tab: ChatTab;
  onMarkSent: (tabId: string) => void;
  onClearSeed: (tabId: string) => void;
}) {
  const { messages, isStreaming, unreadCount, sendMessage, abort, clearConversation, markRead } = useAgentChat(tab.storageKey);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSeedVersion = useRef(0);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Mark read on mount
  useEffect(() => {
    markRead();
  }, [markRead]);

  // Auto-send diagnostic seed
  useEffect(() => {
    if (
      tab.type === 'diagnostic' &&
      tab.initialPrompt &&
      tab.seedState === 'pending' &&
      tab.seedVersion !== lastSeedVersion.current
    ) {
      lastSeedVersion.current = tab.seedVersion;
      sendMessage(tab.initialPrompt, { kind: 'diagnostic-seed' })
        .then(() => onMarkSent(tab.id))
        .catch(() => { /* seedState stays 'pending' — retry on next openDiagnostic */ });
    }
  }, [tab.seedVersion, tab.seedState, tab.type, tab.initialPrompt, tab.id, onMarkSent, sendMessage]);

  const handleClear = useCallback(() => {
    clearConversation();
    if (tab.type === 'diagnostic') {
      onClearSeed(tab.id);
    }
  }, [clearConversation, tab.type, tab.id, onClearSeed]);

  const emptyState = tab.type === 'general' ? (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-900/30 mb-3">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-blue-500 dark:text-blue-400" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m12.728 0-1.414-1.414M7.05 7.05 5.636 5.636M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-slate-100 mb-1">
        Hi! I'm Lumeo AI
      </h3>
      <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">
        Ask me about your sites, chargers, sessions, or analytics. I can help you understand your charging network.
      </p>
    </div>
  ) : (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/30 mb-3">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-amber-500 dark:text-amber-400" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-slate-100 mb-1">
        Diagnostic: {tab.ocppId}
      </h3>
      <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">
        Ask questions about this charger or type a new query.
      </p>
    </div>
  );

  return (
    <>
      {/* Clear button (absolute in top-right of content area) */}
      <div className="flex items-center justify-end px-3 pt-1 shrink-0">
        <button
          type="button"
          onClick={handleClear}
          className="flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
          title="Clear conversation"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
          </svg>
          New
        </button>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && emptyState}
        {messages.map((msg) =>
          msg.meta?.kind === 'diagnostic-seed' ? (
            <DiagnosticStartEvent key={msg.id} ocppId={tab.ocppId} status={tab.status} />
          ) : (
            <AgentChatMessage key={msg.id} message={msg} />
          ),
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <AgentChatInput
        onSend={sendMessage}
        onAbort={abort}
        isStreaming={isStreaming}
      />
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function FloatingButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/25 hover:bg-blue-700 hover:shadow-blue-600/40 dark:bg-blue-500 dark:hover:bg-blue-600 dark:shadow-blue-500/20 transition-all duration-200"
      title="Open Lumeo AI (Cmd+Shift+A)"
      aria-label="Open Lumeo AI assistant"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m12.728 0-1.414-1.414M7.05 7.05 5.636 5.636M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
      </svg>
    </button>
  );
}

function PanelHeader({
  aiConfigured,
  onClose,
}: {
  aiConfigured: boolean | null;
  onClose: () => void;
}) {
  return (
    <div className="flex h-14 items-center justify-between border-b border-gray-200 dark:border-slate-700 px-4 shrink-0">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/40">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m12.728 0-1.414-1.414M7.05 7.05 5.636 5.636M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Lumeo AI</h2>
          {aiConfigured === false && (
            <a
              href="/settings"
              className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline"
              onClick={onClose}
            >
              AI not configured — go to settings
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-slate-500 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-800 dark:hover:text-slate-300 transition-colors"
        title="Close (Cmd+Shift+A)"
        aria-label="Close AI chat panel"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
          <path strokeLinecap="round" d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: {
  tabs: ChatTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}) {
  const statusDotColor = (status?: string) =>
    status === 'FAULTED' ? 'bg-red-500' :
    status === 'OFFLINE' ? 'bg-yellow-500' :
    status === 'ONLINE' ? 'bg-green-500' :
    'bg-gray-400';

  return (
    <div className="flex items-center gap-0.5 border-b border-gray-200 dark:border-slate-700 px-2 overflow-x-auto shrink-0 scrollbar-hide">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold whitespace-nowrap border-b-2 transition-colors shrink-0',
              isActive
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300',
            )}
          >
            {tab.type === 'diagnostic' && (
              <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', statusDotColor(tab.status))} />
            )}
            <span className="max-w-[80px] truncate">{tab.label}</span>
            {tab.type === 'diagnostic' && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onCloseTab(tab.id); } }}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-sm text-gray-400 dark:text-slate-500 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                title="Close tab"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-2.5 w-2.5" aria-hidden="true">
                  <path strokeLinecap="round" d="M18 6 6 18M6 6l12 12" />
                </svg>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
