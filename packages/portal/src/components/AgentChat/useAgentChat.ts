import { useCallback, useRef, useState } from 'react';
import { useToken } from '../../auth/TokenContext';
import type { ChatMessage, SSEEvent, ToolChip } from './types';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const STORAGE_KEY = 'lumeo.agent-chat.messages';

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ChatMessage[];
  } catch { /* ignore corrupt data */ }
  return [];
}

function saveMessages(msgs: ChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs));
  } catch { /* storage full — silent */ }
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const getToken = useToken();

  // Persist whenever messages change
  const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      saveMessages(next);
      return next;
    });
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      toolChips: [],
      timestamp: Date.now(),
    };

    // Build messages payload (all prior messages + new user message)
    const allMessages = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    updateMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = await getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Dev mode header
      if (!token) {
        headers['x-dev-operator-id'] = 'operator-001';
      }

      const res = await fetch(`${API_URL}/agent/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: allMessages }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${errBody}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        // Keep the last potentially-incomplete frame in the buffer
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6);
            if (json === '[DONE]') continue;

            let event: SSEEvent;
            try {
              event = JSON.parse(json) as SSEEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case 'text_delta':
                updateMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === 'assistant') {
                    copy[copy.length - 1] = { ...last, content: last.content + event.text };
                  }
                  return copy;
                });
                break;

              case 'tool_started':
                updateMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === 'assistant') {
                    const chip: ToolChip = { id: event.id, name: event.name, status: 'running' };
                    copy[copy.length - 1] = {
                      ...last,
                      toolChips: [...(last.toolChips ?? []), chip],
                    };
                  }
                  return copy;
                });
                break;

              case 'tool_result':
                updateMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === 'assistant' && last.toolChips) {
                    copy[copy.length - 1] = {
                      ...last,
                      toolChips: last.toolChips.map((c) =>
                        c.id === event.id ? { ...c, status: 'done' as const, summary: event.summary } : c,
                      ),
                    };
                  }
                  return copy;
                });
                break;

              case 'tool_error':
                updateMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === 'assistant' && last.toolChips) {
                    copy[copy.length - 1] = {
                      ...last,
                      toolChips: last.toolChips.map((c) =>
                        c.id === event.id ? { ...c, status: 'error' as const, summary: event.error } : c,
                      ),
                    };
                  }
                  return copy;
                });
                break;

              case 'message_done':
                setIsStreaming(false);
                break;

              case 'error':
                updateMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === 'assistant') {
                    copy[copy.length - 1] = {
                      ...last,
                      content: last.content + `\n\n**Error:** ${event.error}`,
                    };
                  }
                  return copy;
                });
                setIsStreaming(false);
                break;
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled — just stop streaming
      } else {
        updateMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content: last.content || `Sorry, something went wrong: ${(err as Error).message}`,
            };
          }
          return copy;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [messages, getToken, updateMessages]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const clearConversation = useCallback(() => {
    updateMessages(() => []);
    setIsStreaming(false);
    abortRef.current?.abort();
  }, [updateMessages]);

  return { messages, isStreaming, sendMessage, abort, clearConversation };
}
