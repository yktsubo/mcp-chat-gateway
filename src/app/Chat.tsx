'use client';

import { useChat } from '@ai-sdk/react';
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import { getSession, signIn } from 'next-auth/react';
import { harden } from 'rehype-harden';
import { defaultRehypePlugins } from 'streamdown';
import { useEffect, useState } from 'react';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message';
import { PromptInput, PromptInputSubmit, PromptInputTextarea, PromptInputFooter } from '@/components/ai-elements/prompt-input';
import { getStatusBadge, Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';

type Status = { name: string; label: string; tools?: number; needsAuth: boolean; stepUp?: boolean; error?: string };

// Extracts the message from an API error body ({"error": "..."})
function errorText(error: Error) {
  try {
    return (JSON.parse(error.message) as { error?: string }).error ?? error.message;
  } catch {
    return error.message;
  }
}
type ToolPart = ToolUIPart | DynamicToolUIPart;

const connectUrl = (name: string) => `/api/mcp/connect?server=${encodeURIComponent(name)}`;
const isToolPart = (part: UIMessage['parts'][number]): part is ToolPart =>
  part.type === 'dynamic-tool' || part.type.startsWith('tool-');
const toolName = (part: ToolPart) => (part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length));

// Markdown rendering: no raw HTML, no images, http(s) links only (confirmed before opening)
const SAFE_REHYPE: MessageResponseProps['rehypePlugins'] = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      // Base for resolving relative URLs
      defaultOrigin: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
      allowedLinkPrefixes: ['*'],
      allowedProtocols: ['https', 'http'],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
];

export function Login() {
  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="text-muted-foreground">続けるにはログインしてください。</p>
      <Button size="lg" onClick={() => signIn('okta')}>
        ログイン
      </Button>
    </main>
  );
}

export default function Chat() {
  const [statuses, setStatuses] = useState<Status[] | null>(null);
  const [notice, setNotice] = useState('');
  // Conversation state and streaming via /api/chat
  const { messages, sendMessage, status, error, stop } = useChat({ onFinish: () => loadStatuses() });

  // getSession() refreshes expiring login tokens before the server uses them
  const loadStatuses = () =>
    getSession()
      .then(() => fetch('/api/mcp'))
      .then((res) => res.json())
      .then((data) => setStatuses(data.statuses ?? []));

  useEffect(() => {
    // Loads MCP server statuses after the chat is shown
    loadStatuses();
    // Reloads statuses and shows a notice when the connect tab reports success
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'mcp-connected') return;
      loadStatuses();
      setNotice(`✅ ${e.data.label} に接続しました。もう一度依頼してください。`);
    };
    // Also reloads statuses when the window regains focus
    const onFocus = () => loadStatuses();
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Recent tool calls for the side panel, newest first
  const recentTools = messages
    .flatMap((m) => m.parts.filter(isToolPart))
    .filter((p) => !toolName(p).endsWith('__connect'))
    .slice(-8)
    .reverse();

  function renderPart(part: UIMessage['parts'][number], key: number) {
    if (part.type === 'text') {
      return (
        <MessageResponse key={key} rehypePlugins={SAFE_REHYPE} linkSafety={{ enabled: true }}>
          {part.text}
        </MessageResponse>
      );
    }
    if (!isToolPart(part)) return null;
    const name = toolName(part);

    // Shows a connect button (opened in a new tab) for a connect tool call
    if (name.endsWith('__connect')) {
      if (part.state !== 'output-available') return null;
      const server = name.slice(0, -'__connect'.length);
      const current = statuses?.find((s) => s.name === server);
      const label = current?.label ?? server;
      const connected = current?.tools !== undefined;
      return (
        <Button key={key} className="w-fit" disabled={connected} onClick={() => window.open(connectUrl(server), '_blank')}>
          {connected ? `${label}: 接続済み` : `${label} に接続`}
        </Button>
      );
    }
    return (
      <Tool key={key}>
        {part.type === 'dynamic-tool' ? (
          <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        ) : (
          <ToolHeader type={part.type} state={part.state} />
        )}
        <ToolContent>
          <ToolInput input={part.input} />
          <ToolOutput output={part.output} errorText={part.errorText} />
        </ToolContent>
      </Tool>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1">
      {/* Side panel (top on mobile): MCP server statuses and recent tool calls */}
      <aside className="border-b bg-background p-4 text-sm lg:order-2 lg:overflow-y-auto lg:border-b-0 lg:border-l">
        <h2 className="mb-2 font-semibold">MCP サーバー</h2>
        <ul className="space-y-1">
          {statuses === null ? (
            <li className="text-muted-foreground">確認中…</li>
          ) : (
            statuses.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground">
                  {s.needsAuth
                    ? '未接続'
                    : s.error
                      ? `⚠️ ${s.error}`
                      : `✅ ${s.tools} ツール${s.stepUp ? '（追加の権限が必要）' : ''}`}
                </span>
              </li>
            ))
          )}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">未接続のサーバーは、必要になったときに接続を求めます。</p>
        <h2 className="mb-2 mt-5 hidden font-semibold lg:block">最近のツール実行</h2>
        <ul className="hidden space-y-2 lg:block">
          {recentTools.length === 0 && <li className="text-muted-foreground">まだありません</li>}
          {recentTools.map((p) => (
            <li key={p.toolCallId} className="flex items-center justify-between gap-2">
              <span className="truncate" title={toolName(p)}>
                {toolName(p)}
              </span>
              {getStatusBadge(p.state)}
            </li>
          ))}
        </ul>
      </aside>

      {/* Conversation and input */}
      <main className="flex min-h-0 flex-col lg:order-1">
        <Conversation>
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {messages.map((m) => (
              <Message key={m.id} from={m.role}>
                <MessageContent className="group-[.is-assistant]:rounded-xl group-[.is-assistant]:border group-[.is-assistant]:bg-background group-[.is-assistant]:px-4 group-[.is-assistant]:py-3 group-[.is-assistant]:shadow-sm group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground">
                  {m.parts.map(renderPart)}
                </MessageContent>
              </Message>
            ))}
            {error && <p className="text-sm text-destructive">⚠️ {errorText(error)}</p>}
            {notice && <p className="text-sm">{notice}</p>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="border-t bg-background p-4">
          <PromptInput
            className="mx-auto max-w-3xl"
            onSubmit={({ text }) => {
              if (!text.trim()) return;
              void getSession().then(() => sendMessage({ text }));
              setNotice('');
            }}
          >
            <PromptInputTextarea placeholder="メッセージ（Enter で送信、Shift+Enter で改行）" />
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={status} onStop={stop} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </main>
    </div>
  );
}
