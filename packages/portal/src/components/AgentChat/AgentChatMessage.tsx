import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { ChatMessage, ToolChip } from './types';

// ─── Relative time ──────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Lightweight markdown renderer ──────────────────────────────────────────

function renderMarkdown(text: string): ReactNode[] {
  const elements: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks (```)
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++; // skip opening ```
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={`code-${i}`} className="my-2 overflow-x-auto rounded-md bg-gray-100 dark:bg-slate-800 p-3 text-xs leading-relaxed">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const sizes: Record<number, string> = { 1: 'text-lg font-bold', 2: 'text-base font-bold', 3: 'text-sm font-semibold', 4: 'text-sm font-medium' };
      elements.push(
        <Tag key={`h-${i}`} className={cn('mt-2 mb-1 text-gray-900 dark:text-slate-100', sizes[level] ?? sizes[4])}>
          {renderInline(headingMatch[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    // Table detection: lines starting with |
    if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|') && lines[i].trimEnd().endsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, `tbl-${i}`));
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="my-1 ml-4 list-disc text-sm">
          {items.map((item, idx) => (
            <li key={idx} className="mb-0.5">{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="my-1 ml-4 list-decimal text-sm">
          {items.map((item, idx) => (
            <li key={idx} className="mb-0.5">{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Normal paragraph
    elements.push(
      <p key={`p-${i}`} className="my-0.5 text-sm leading-relaxed">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return elements;
}

function renderTable(lines: string[], key: string): ReactNode {
  const parseRow = (line: string) =>
    line
      .split('|')
      .slice(1, -1) // remove leading/trailing empty from split
      .map((cell) => cell.trim());

  const rows = lines.filter((l) => !l.match(/^\s*\|[\s:-]+\|\s*$/)); // skip separator row
  if (rows.length === 0) return null;

  const header = parseRow(rows[0]);
  const body = rows.slice(1).map(parseRow);

  return (
    <div key={key} className="my-2 overflow-x-auto">
      <table className="min-w-full text-xs border border-gray-200 dark:border-slate-700 rounded">
        <thead>
          <tr className="bg-gray-50 dark:bg-slate-800">
            {header.map((cell, ci) => (
              <th key={ci} className="px-2 py-1 text-left font-medium text-gray-700 dark:text-slate-300 border-b border-gray-200 dark:border-slate-700">
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-b border-gray-100 dark:border-slate-800 last:border-0">
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-1 text-gray-600 dark:text-slate-400">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render inline markdown: bold, italic, code */
function renderInline(text: string): ReactNode[] {
  // Match bold, italic, inline code
  // Order matters: bold (**) before italic (*)
  const parts: ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\*(.+?)\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before the match
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    if (match[2] !== undefined) {
      // Bold **text**
      parts.push(<strong key={match.index} className="font-semibold">{match[2]}</strong>);
    } else if (match[4] !== undefined) {
      // Inline code `text`
      parts.push(
        <code key={match.index} className="rounded bg-gray-100 dark:bg-slate-800 px-1 py-0.5 text-xs">
          {match[4]}
        </code>,
      );
    } else if (match[6] !== undefined) {
      // Italic *text*
      parts.push(<em key={match.index}>{match[6]}</em>);
    }

    last = match.index + match[0].length;
  }

  // Remaining text
  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts.length > 0 ? parts : [text];
}

// ─── Tool chip display ──────────────────────────────────────────────────────

function ToolChipDisplay({ chip }: { chip: ToolChip }) {
  const [expanded, setExpanded] = useState(false);

  // Human-friendly tool names
  const displayName = chip.name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());

  return (
    <button
      type="button"
      onClick={() => chip.summary && setExpanded((v) => !v)}
      className={cn(
        'flex items-start gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors text-left w-full',
        chip.status === 'running' && 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50',
        chip.status === 'done' && 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 hover:bg-gray-100 dark:hover:bg-slate-800',
        chip.status === 'error' && 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50',
      )}
    >
      {chip.status === 'running' && (
        <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center">
          <span className="absolute h-2 w-2 animate-ping rounded-full bg-blue-400 dark:bg-blue-500 opacity-75" />
          <span className="relative h-2 w-2 rounded-full bg-blue-500 dark:bg-blue-400" />
        </span>
      )}
      {chip.status === 'done' && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 h-3 w-3 shrink-0 text-green-500 dark:text-green-400" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
        </svg>
      )}
      {chip.status === 'error' && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 h-3 w-3 shrink-0 text-red-500 dark:text-red-400" aria-hidden="true">
          <path strokeLinecap="round" d="M18 6 6 18M6 6l12 12" />
        </svg>
      )}
      <span className="flex-1 min-w-0">
        <span className={cn(
          'font-medium',
          chip.status === 'running' && 'text-blue-700 dark:text-blue-300',
          chip.status === 'done' && 'text-gray-700 dark:text-slate-300',
          chip.status === 'error' && 'text-red-700 dark:text-red-300',
        )}>
          {displayName}
        </span>
        {chip.status === 'running' && (
          <span className="ml-1 text-blue-500 dark:text-blue-400">running...</span>
        )}
        {expanded && chip.summary && (
          <span className="mt-0.5 block text-gray-500 dark:text-slate-400 break-words">{chip.summary}</span>
        )}
      </span>
      {chip.status === 'done' && chip.summary && (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn('mt-0.5 h-3 w-3 shrink-0 text-gray-400 dark:text-slate-500 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      )}
    </button>
  );
}

// ─── Main message component ─────────────────────────────────────────────────

interface AgentChatMessageProps {
  message: ChatMessage;
}

export default function AgentChatMessage({ message }: AgentChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex w-full gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-xl px-3 py-2',
          isUser
            ? 'bg-blue-600 text-white dark:bg-blue-500'
            : 'bg-gray-100 text-gray-900 dark:bg-slate-800 dark:text-slate-100',
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
        ) : (
          <>
            {/* Tool chips before / interleaved with text */}
            {message.toolChips && message.toolChips.length > 0 && (
              <div className="mb-1.5 flex flex-col gap-1">
                {message.toolChips.map((chip) => (
                  <ToolChipDisplay key={chip.id} chip={chip} />
                ))}
              </div>
            )}
            {message.content ? (
              <div className="prose-sm prose-slate dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {renderMarkdown(message.content)}
              </div>
            ) : (
              !message.toolChips?.length && (
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-slate-500 animate-bounce [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-slate-500 animate-bounce [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-slate-500 animate-bounce [animation-delay:300ms]" />
                </div>
              )
            )}
          </>
        )}
        <div
          className={cn(
            'mt-1 text-[10px]',
            isUser ? 'text-blue-200 dark:text-blue-300/70 text-right' : 'text-gray-400 dark:text-slate-500',
          )}
        >
          {relativeTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}
