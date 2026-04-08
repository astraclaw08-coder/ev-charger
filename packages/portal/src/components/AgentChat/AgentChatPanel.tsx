import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { createApiClient } from '../../api/client';
import { useToken } from '../../auth/TokenContext';
import { useAgentChat } from './useAgentChat';
import AgentChatInput from './AgentChatInput';
import AgentChatMessage from './AgentChatMessage';

export default function AgentChatPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const { messages, isStreaming, sendMessage, abort, clearConversation } = useAgentChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const getToken = useToken();

  // Check OpenAI connection status on mount
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const res = await api.getOpenAIStatus();
        if (!cancelled) setAiConfigured(res.connected);
      } catch {
        if (!cancelled) setAiConfigured(null);
      }
    }
    check();
    return () => { cancelled = true; };
  }, [getToken]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Keyboard shortcut: Cmd+Shift+A to toggle
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <>
      {/* Floating trigger button */}
      {!isOpen && (
        <button
          type="button"
          onClick={toggle}
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/25 hover:bg-blue-700 hover:shadow-blue-600/40 dark:bg-blue-500 dark:hover:bg-blue-600 dark:shadow-blue-500/20 transition-all duration-200"
          title="Open Lumeo AI (Cmd+Shift+A)"
          aria-label="Open Lumeo AI assistant"
        >
          {/* Sparkle / AI icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m12.728 0-1.414-1.414M7.05 7.05 5.636 5.636M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          </svg>
          {messages.length > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white tabular-nums">
              {messages.filter((m) => m.role === 'assistant').length}
            </span>
          )}
        </button>
      )}

      {/* Backdrop (mobile) */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm sm:hidden"
          onClick={close}
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
                  onClick={close}
                >
                  AI not configured — go to settings
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={clearConversation}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              title="New chat"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
              </svg>
              New
            </button>
            <button
              type="button"
              onClick={close}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-slate-500 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-800 dark:hover:text-slate-300 transition-colors"
              title="Close (Cmd+Shift+A)"
              aria-label="Close AI chat panel"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                <path strokeLinecap="round" d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
          {messages.length === 0 && (
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
          )}
          {messages.map((msg) => (
            <AgentChatMessage key={msg.id} message={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <AgentChatInput
          onSend={sendMessage}
          onAbort={abort}
          isStreaming={isStreaming}
        />
      </div>
    </>
  );
}
