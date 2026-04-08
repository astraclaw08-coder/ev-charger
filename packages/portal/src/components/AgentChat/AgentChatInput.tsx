import { useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';

interface AgentChatInputProps {
  onSend: (text: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
}

export default function AgentChatInput({ onSend, onAbort, isStreaming }: AgentChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const value = useRef('');

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Clamp to ~4 rows (approx 96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [resize]);

  const handleSend = useCallback(() => {
    const text = textareaRef.current?.value.trim();
    if (!text) return;
    onSend(text);
    if (textareaRef.current) {
      textareaRef.current.value = '';
      value.current = '';
      // Reset height
      textareaRef.current.style.height = 'auto';
    }
  }, [onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isStreaming) handleSend();
      }
    },
    [isStreaming, handleSend],
  );

  return (
    <div className="flex items-end gap-2 border-t border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-3">
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder="Ask Lumeo AI anything..."
        disabled={isStreaming}
        onKeyDown={handleKeyDown}
        onInput={resize}
        className={cn(
          'flex-1 resize-none rounded-lg border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-400/50 transition-colors',
          isStreaming && 'opacity-50 cursor-not-allowed',
        )}
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onAbort}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="Stop generating"
          aria-label="Stop generating"
        >
          {/* Stop / square icon */}
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleSend}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors disabled:opacity-40"
          title="Send message"
          aria-label="Send message"
        >
          {/* Arrow up icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0-5 5m5-5 5 5" />
          </svg>
        </button>
      )}
    </div>
  );
}
