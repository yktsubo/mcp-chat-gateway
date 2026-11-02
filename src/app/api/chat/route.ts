import { createAnthropic } from '@ai-sdk/anthropic';
import { azure } from '@ai-sdk/azure';
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from 'ai';
import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { errorFields, log } from '@/lib/log';
import { connectAll, connectTools } from '@/lib/mcp';
import { checkChatLimit } from '@/lib/ratelimit';

export const maxDuration = 300;

// Default maximum conversation size per request (CHAT_MAX_REQUEST_BYTES / CHAT_MAX_MESSAGES)
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 200;
const TOO_LARGE = '会話が長すぎます。ページを再読み込みして、新しい会話を始めてください。';

// Azure OpenAI if AZURE_OPENAI_DEPLOYMENT is set, otherwise Claude (ANTHROPIC_MODEL, default Claude Haiku 5.5)
const model = () => {
  if (process.env.AZURE_OPENAI_DEPLOYMENT) return azure(process.env.AZURE_OPENAI_DEPLOYMENT);
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const anthropic = createAnthropic(workspace ? { headers: { 'anthropic-workspace-id': workspace } } : {});
  return anthropic(process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5');
};

// Streams the model response and tool calls to useChat
export async function POST(req: NextRequest) {
  const current = await currentUser();
  if (!current) return Response.json({ error: 'ログインしてください' }, { status: 401 });
  const user = current.id;

  // Returns 429 with Retry-After when the rate limit is exceeded
  const limit = await checkChatLimit(user);
  if (!limit.success) {
    log.warn('rate_limited', { user });
    return Response.json(
      { error: `回数の上限に達しました。${limit.retryAfterSeconds} 秒後にもう一度お試しください。` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const maxBytes = Number(process.env.CHAT_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES;
  const maxMessages = Number(process.env.CHAT_MAX_MESSAGES) || DEFAULT_MAX_MESSAGES;
  if (Number(req.headers.get('content-length')) > maxBytes) return Response.json({ error: TOO_LARGE }, { status: 413 });
  const body = await req.text();
  if (Buffer.byteLength(body) > maxBytes) return Response.json({ error: TOO_LARGE }, { status: 413 });
  let messages: UIMessage[];
  try {
    messages = (JSON.parse(body) as { messages: UIMessage[] }).messages;
  } catch {
    return Response.json({ error: '不正なリクエストです' }, { status: 400 });
  }
  if (!Array.isArray(messages)) return Response.json({ error: '不正なリクエストです' }, { status: 400 });
  if (messages.length > maxMessages) return Response.json({ error: TOO_LARGE }, { status: 413 });
  const mcp = await connectAll(new URL(req.url).origin, current);
  // Adds connect tools for servers that are not connected
  const tools = { ...mcp.tools, ...connectTools(mcp.statuses) };

  const result = streamText({
    model: model(),
    instructions: process.env.SYSTEM_PROMPT || 'You are a helpful assistant. Use the MCP tools when useful.',
    messages: await convertToModelMessages(messages, { tools }),
    tools,
    stopWhen: isStepCount(10),
    // Logs failed tool calls without their input or output
    onToolExecutionEnd: ({ toolCall, toolOutput }) => {
      if (toolOutput.type === 'tool-error') log.warn('tool_failed', { user, tool: toolCall.toolName, ...errorFields(toolOutput.error) });
    },
    // Closes MCP clients when the stream ends, is aborted, or fails
    onEnd: () => void mcp.close(),
    onAbort: () => void mcp.close(),
    onError: ({ error }) => {
      log.error('chat_failed', { user, ...errorFields(error, true) });
      void mcp.close();
    },
  });
  // Sends a fixed message to the browser; details are logged
  return result.toUIMessageStreamResponse({
    onError: () => 'エラーが発生しました。しばらくしてからもう一度お試しください。',
  });
}
