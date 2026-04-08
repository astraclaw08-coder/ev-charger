import { FastifyInstance } from 'fastify';
import { requireOperator } from '../plugins/auth';
import OpenAI from 'openai';
import { getLLMApiKey } from '../lib/llmProvider';
import { buildAgentSystemPrompt } from '../lib/agentSystemPrompt';
import { AGENT_TOOLS, executeAgentTool } from '../lib/agentTools';
import { prisma } from '@ev-charger/shared';
import crypto from 'crypto';

const MAX_TOOL_ITERATIONS = 6;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

export async function agentChatRoutes(app: FastifyInstance) {
  app.post('/agent/chat', {
    preHandler: [requireOperator],
  }, async (req, reply) => {
    const requestId = crypto.randomUUID();
    const operator = req.currentOperator!;
    const claims = operator.claims!;
    const { messages } = req.body as { messages: Array<{ role: string; content: string }>; conversationId?: string };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages array required' });
    }

    // Limit context
    const trimmedMessages = messages.slice(-40); // last 20 pairs

    // Get LLM API key (OpenRouter)
    const scopeKey = claims.orgId ?? 'default';
    let apiKey: string;
    try {
      apiKey = await getLLMApiKey(prisma, scopeKey);
    } catch (err: any) {
      return reply.status(503).send({ error: err.message });
    }

    const openai = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://portal.lumeopower.com',
        'X-OpenRouter-Title': 'Lumeo AI',
      },
    });

    // Set up SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': requestId,
    });

    function sendSSE(event: Record<string, unknown>) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Cancellation handling
    let aborted = false;
    req.raw.on('close', () => { aborted = true; });

    const systemPrompt = buildAgentSystemPrompt({
      roles: claims.roles ?? [],
      siteIds: claims.siteIds ?? [],
      orgId: claims.orgId ?? null,
      dataScopes: claims.dataScopes ?? [],
    });

    // Agentic loop
    const currentMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedMessages,
    ];
    let iterations = 0;

    try {
      while (iterations < MAX_TOOL_ITERATIONS && !aborted) {
        iterations++;

        const stream = await openai.chat.completions.create({
          model: DEFAULT_MODEL,
          messages: currentMessages,
          tools: AGENT_TOOLS as any,
          stream: true,
          max_tokens: 4096,
        });

        let assistantContent = '';
        const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

        for await (const chunk of stream) {
          if (aborted) break;

          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          // Stream text content
          if (delta.content) {
            assistantContent += delta.content;
            sendSSE({ type: 'text_delta', text: delta.content });
          }

          // Collect tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id ?? '', function: { name: '', arguments: '' } };
                }
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
        }

        if (aborted) break;

        // If no tool calls, we're done
        if (toolCalls.length === 0) {
          break;
        }

        // Add assistant message with tool calls to conversation
        currentMessages.push({
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: tc.function,
          })),
        });

        // Execute each tool call
        for (const tc of toolCalls) {
          if (aborted) break;

          const toolName = tc.function.name;
          let toolInput: any;
          try {
            toolInput = JSON.parse(tc.function.arguments || '{}');
          } catch {
            toolInput = {};
          }

          sendSSE({ type: 'tool_started', id: tc.id, name: toolName, input: toolInput });

          try {
            const result = await executeAgentTool(toolName, toolInput, claims, requestId);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

            // Summarize for UI
            const summary = (result as any)?.error
              ? `Permission denied: ${(result as any).error}`
              : `Completed ${toolName}`;

            sendSSE({ type: 'tool_result', id: tc.id, name: toolName, summary });

            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: resultStr,
            });
          } catch (err: any) {
            const errorMsg = err.message || 'Tool execution failed';
            sendSSE({ type: 'tool_error', id: tc.id, name: toolName, error: errorMsg });
            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: errorMsg }),
            });
          }
        }
        // Loop continues — model will see tool results and respond
      }
    } catch (err: any) {
      app.log.error({ err, requestId }, 'Agent chat error');
      if (!aborted) {
        sendSSE({ type: 'error', error: err.message || 'Internal error', requestId });
      }
    }

    if (!aborted) {
      sendSSE({ type: 'message_done', requestId });
    }
    reply.raw.end();
  });
}
