import { auth } from '@ai-sdk/mcp';
import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { authorizationServerMetadata } from '@/lib/discovery';
import { errorFields, log } from '@/lib/log';
import { StoredOAuthProvider, mcpFetch, mcpServers } from '@/lib/mcp';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// OAuth callback: exchanges the authorization code for tokens
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const server = mcpServers().find((s) => state.startsWith(`${s.name}.`));
  const user = (await currentUser())?.id;
  if (!code || !server || !user) {
    // Authorization error, unknown state, or no session
    log.warn('mcp_oauth_callback_rejected', {
      server: server?.name,
      user,
      error: url.searchParams.get('error') ?? (!code ? 'no_code' : !server ? 'unknown_state' : 'no_session'),
      description: url.searchParams.get('error_description') ?? undefined,
    });
    // Shows a fixed message instead of error_description from the URL
    const message = url.searchParams.get('error') === 'access_denied' ? '接続が拒否されました' : '不正なコールバックです';
    return new Response(message, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const authProvider = await StoredOAuthProvider.load(server, url.origin, user);
  const label = server.label ?? server.name;

  // Rejects the response if iss is missing but the authorization server advertises it (RFC 9207).
  // The SDK checks the value when iss is present.
  const iss = url.searchParams.get('iss');
  const authServer = authProvider.authorizationServerInformation();
  if (!iss && authServer) {
    const metadata = (await authorizationServerMetadata(authServer.issuer ?? authServer.authorizationServerUrl)) as {
      authorization_response_iss_parameter_supported?: boolean;
    };
    if (metadata.authorization_response_iss_parameter_supported) {
      log.warn('mcp_oauth_callback_rejected', { server: server.name, user, error: 'missing_iss' });
      return new Response('認可レスポンスに iss がありません', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
  try {
    await auth(authProvider, {
      serverUrl: server.url,
      authorizationCode: code,
      callbackState: state,
      callbackIssuer: iss ?? undefined,
      fetchFn: mcpFetch,
    });
  } catch (error) {
    // Logs the reason without showing it
    log.error('mcp_oauth_callback_failed', { server: server.name, user, ...errorFields(error) });
    return new Response(`${label} に接続できませんでした。\nチャットに戻って、もう一度「接続」を押してください。`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  log.info('mcp_connected', { server: server.name, user });

  // Notifies the opener (chat tab) and closes this tab. Values are escaped for HTML and script.
  const message = JSON.stringify({ type: 'mcp-connected', server: server.name, label }).replace(/</g, '\\u003c');
  return new Response(
    `<p>${escapeHtml(label)} に接続しました。このタブを閉じて、チャットでもう一度依頼してください。</p>` +
      `<script>window.opener?.postMessage(${message}, location.origin); window.close()</script>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
