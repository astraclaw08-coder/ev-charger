export type SSEEvent =
  | { type: 'stream_started'; requestId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; summary: string }
  | { type: 'tool_error'; id: string; name: string; error: string }
  | { type: 'message_done'; requestId: string }
  | { type: 'error'; error: string; requestId: string };

export type ToolChip = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolChips?: ToolChip[];
  timestamp: number;
  meta?: { kind: 'diagnostic-seed' };
};

export type Conversation = {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  title?: string;
};

// ── Tabbed chat types ──────────────────────────────────────────────

export type ChatTab = {
  id: string;
  label: string;
  type: 'general' | 'diagnostic';
  chargerId?: string;
  ocppId?: string;
  status?: string;
  storageKey: string;
  initialPrompt?: string;
  seedState: 'idle' | 'pending' | 'sent';
  seedVersion: number;
  createdAt: number;
  lastViewedAt: number;
};

export type DiagnosticRequest = {
  chargerId: string;
  ocppId: string;
  status: string;
  lastHeartbeat: string | null;
};
