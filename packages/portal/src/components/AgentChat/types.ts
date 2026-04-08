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
};

export type Conversation = {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  title?: string;
};
