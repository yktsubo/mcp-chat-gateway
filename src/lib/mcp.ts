import {
  auth,
  createMCPClient,
  UnauthorizedError,
  type MCPClient,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { randomUUID } from 'crypto';
import { authorizationServerFor, authorizationServerMetadata, resourceInfo } from './discovery';
import { errorFields, log } from './log';
import { exchangeIdToken } from './okta';
import { getStore } from './store';

// An entry of MCP_SERVERS (JSON array).
// name: ID used as the tool name prefix and the storage key / label: display name (defaults to name)
// description: what the server does; shown to the model while the server is not connected
// auth: "oauth" (default; the user connects with the MCP OAuth flow) or
//       "xaa" (Okta Cross App Access; a token is obtained from the login ID token without user interaction)
// issuer: authorization server to use (defaults to the first one in the Protected Resource Metadata; must be listed there)
// scope: scope requested with XAA
// xaa_resource: adds the resource parameter to the XAA ID-JAG request (omitted by default)
// client_id / client_secret: pre-registered client (for oauth, falls back to CIMD, then dynamic client registration)
type McpServer = {
  name: string;
  label?: string;
  url: string;
  description?: string;
  auth?: 'oauth' | 'xaa';
  issuer?: string;
  scope?: string;
  xaa_resource?: boolean;
  client_id?: string;
  client_secret?: string;
};

export function mcpServers(): McpServer[] {
  return JSON.parse(process.env.MCP_SERVERS || '[]');
}

const labelOf = (name: string) => mcpServers().find((m) => m.name === name)?.label ?? name;
const keyOf = (user: string, server: string) => `mcp:${user}:${server}`;

// Lifetime of stored data, counted from the last write
const TTL_SECONDS = 60 * 60 * 24 * 30;
// Re-exchange XAA tokens this many seconds before they expire
const XAA_MARGIN_SECONDS = 60;

type Stored = {
  client?: OAuthClientInformation;
  tokens?: OAuthTokens & { expires_at?: number };
  verifier?: string;
  state?: string;
  authServer?: OAuthAuthorizationServerInformation;
  /** Scope requested by the MCP server with insufficient_scope; kept until step-up authorization completes */
  stepUpScope?: string;
};

/** OAuth client metadata of this app, used for dynamic client registration and the CIMD document */
export function clientMetadata(origin: string, tokenEndpointAuthMethod = 'none') {
  return {
    client_name: 'MCP Chat',
    client_uri: origin,
    redirect_uris: [`${origin}/api/mcp/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
}

/** URL of the Client ID Metadata Document (CIMD), used as the client_id */
export const clientMetadataDocumentUrl = (origin: string) => `${origin}/oauth/client-metadata.json`;

/**
 * Returns the CIMD client_id bound to the authorization server if the server supports CIMD.
 * Only available when the app is served over https.
 */
async function cimdClient(server: McpServer, origin: string): Promise<OAuthClientInformation | undefined> {
  if (!origin.startsWith('https:')) return undefined;
  try {
    const issuer = await authorizationServerFor(server.url, server.issuer);
    const metadata = await authorizationServerMetadata(issuer);
    return metadata.client_id_metadata_document_supported ? { client_id: clientMetadataDocumentUrl(origin), issuer } : undefined;
  } catch {
    return undefined;
  }
}

// OAuth client provider for the AI SDK. The SDK runs the MCP OAuth flow; this class stores its state
// per user and MCP server and selects the client registration.
export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private tokensHidden = false;

  private constructor(
    private server: McpServer,
    private origin: string,
    private key: string,
    private data: Stored,
    private startsAuth: boolean,
    private cimd: OAuthClientInformation | undefined,
  ) {}

  // startsAuth: whether state and the PKCE verifier may be saved. Only /api/mcp/connect sets it to true,
  // so that other requests do not overwrite an authorization in progress.
  static async load(server: McpServer, origin: string, user: string, startsAuth = false) {
    const key = keyOf(user, server.name);
    const data = (await getStore().get(key)) as Stored;
    const cimd = !server.client_id && !data.client ? await cimdClient(server, origin) : undefined;
    return new StoredOAuthProvider(server, origin, key, data, startsAuth, cimd);
  }

  // Writes the changed fields and removes the fields set to undefined
  private async save(patch: Partial<Stored>) {
    Object.assign(this.data, patch);
    const entries = Object.entries(patch);
    const set = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
    const removed = entries.filter(([, v]) => v === undefined).map(([k]) => k);
    if (Object.keys(set).length) await getStore().set(this.key, set, TTL_SECONDS);
    if (removed.length) await getStore().remove(this.key, removed);
  }

  get redirectUrl() {
    return `${this.origin}/api/mcp/callback`;
  }

  get clientMetadata() {
    return clientMetadata(this.origin, this.server.client_secret ? 'client_secret_basic' : 'none');
  }

  /** Scope that requires step-up authorization */
  get stepUpScope() {
    return this.data.stepUpScope;
  }

  /** Ignores the stored tokens so that the SDK starts a new authorization (step-up) */
  hideTokens() {
    this.tokensHidden = true;
  }

  // Prefixes state with the server name so that the callback can identify the server
  state = () => `${this.server.name}.${randomUUID()}`;
  saveState = async (state: string) => {
    if (this.startsAuth) await this.save({ state });
  };
  storedState = () => this.data.state;

  // Client registration order: pre-registered, stored registration, CIMD, then dynamic registration (by the SDK)
  clientInformation = () => {
    if (this.server.client_id) {
      return { client_id: this.server.client_id, client_secret: this.server.client_secret, issuer: this.server.issuer };
    }
    return this.data.client ?? this.cimd;
  };
  saveClientInformation = (client: OAuthClientInformation) => this.save({ client });
  isClientInformationDynamicallyRegistered = () => !this.server.client_id && !!this.data.client;

  // Client authentication at the token endpoint. Uses client_secret_basic unless the authorization server
  // supports only client_secret_post (RFC 8414 default is client_secret_basic).
  addClientAuthentication = (
    headers: Headers,
    params: URLSearchParams,
    _url: string | URL,
    metadata?: { token_endpoint_auth_methods_supported?: string[] },
  ) => {
    const client = this.clientInformation();
    if (!client) return;
    // Public clients send only client_id
    if (!client.client_secret) {
      params.set('client_id', client.client_id);
      return;
    }
    const methods = metadata?.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (!methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
      params.set('client_id', client.client_id);
      params.set('client_secret', client.client_secret);
      return;
    }
    // Form-encodes the ID and secret before Basic encoding (RFC 6749 §2.3.1)
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const credentials = Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString('base64');
    headers.set('Authorization', `Basic ${credentials}`);
  };

  // Keeps the authorization server discovered at the start of authorization for the callback
  authorizationServerInformation = () => this.data.authServer;
  saveAuthorizationServerInformation = (authServer: OAuthAuthorizationServerInformation) =>
    this.save({ authServer });

  tokens = () => (this.tokensHidden ? undefined : this.data.tokens);
  // Stores tokens without the ID token and clears the authorization state and step-up scope
  saveTokens = ({ id_token: _, ...tokens }: OAuthTokens) =>
    this.save({ tokens, verifier: undefined, state: undefined, stepUpScope: undefined });

  saveCodeVerifier = async (verifier: string) => {
    if (this.startsAuth) await this.save({ verifier });
  };
  codeVerifier = () => this.data.verifier ?? '';

  // Keeps the authorization URL so that the caller can redirect the user to it
  redirectToAuthorization = (url: URL) => {
    this.authorizationUrl = url;
  };

  invalidateCredentials = async (scope: 'all' | 'client' | 'tokens' | 'verifier') => {
    if (scope === 'all') await this.save({ client: undefined, tokens: undefined, verifier: undefined });
    else await this.save({ [scope]: undefined });
  };
}

/**
 * fetch for MCP and OAuth requests.
 * - Re-creates error responses as a standard Response so that the SDK can read OAuth errors in Next.js.
 * - Reports the requested scope on a 403 insufficient_scope response.
 */
export function createMcpFetch(onInsufficientScope?: (scope: string) => Promise<void>): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.ok) return res;
    const url = input instanceof Request ? input.url : String(input);
    if (res.status === 403 && onInsufficientScope) {
      const { error, scope } = extractWWWAuthenticateParams(res);
      if (error === 'insufficient_scope' && scope) {
        log.info('mcp_insufficient_scope', { url: url.split('?')[0], scope });
        await onInsufficientScope(scope);
      }
    }
    const body = await res.text();
    // Logs token endpoint errors (the body contains only error and error_description)
    if (url.includes('/token')) log.error('oauth_token_request_failed', { url: url.split('?')[0], status: res.status, body: body.slice(0, 300) });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export const mcpFetch = createMcpFetch();

const mergeScopes = (...scopes: (string | undefined)[]) =>
  [...new Set(scopes.flatMap((s) => s?.split(/\s+/) ?? []).filter(Boolean))].join(' ');

type McpUser = { id: string; idToken?: string };

const RELOGIN_MESSAGE = 'ログインし直してください（ID トークンの期限切れ）';

/**
 * Gets an access token for the MCP server with XAA and caches it until it expires.
 * The authorization server is taken from the MCP server's Protected Resource Metadata.
 * If a step-up scope is pending, exchanges again with it added and falls back to the configured scope if denied.
 */
async function xaaToken(server: McpServer, user: McpUser): Promise<string> {
  const key = keyOf(user.id, server.name);
  const data = (await getStore().get(key)) as Stored;
  const cached = data.tokens;
  const valid = !!cached && (cached.expires_at ?? 0) - XAA_MARGIN_SECONDS > Date.now() / 1000;
  if (valid && !data.stepUpScope) return cached.access_token;
  if (!user.idToken) throw new Error(RELOGIN_MESSAGE);

  const { resource } = await resourceInfo(server.url);
  const issuer = await authorizationServerFor(server.url, server.issuer);
  const exchange = async (scope: string) => {
    try {
      const issued = await exchangeIdToken(user.idToken!, { issuer, scope, ...(server.xaa_resource ? { resource } : {}) });
      const tokens = { access_token: issued.access_token!, token_type: 'Bearer', expires_at: issued.expires_at };
      await getStore().set(key, { tokens }, TTL_SECONDS);
      return tokens.access_token;
    } catch (error) {
      log.error('xaa_exchange_failed', { server: server.name, user: user.id, scope, ...errorFields(error) });
      throw error;
    }
  };

  if (data.stepUpScope) {
    const requested = mergeScopes(server.scope, data.stepUpScope);
    await getStore().remove(key, ['stepUpScope']);
    try {
      return await exchange(requested);
    } catch {
      log.warn('xaa_step_up_denied', { server: server.name, user: user.id, scope: requested });
      if (valid) return cached.access_token;
    }
  }
  return exchange(server.scope ?? '');
}

class AuthorizationRequired extends Error {
  constructor(readonly url: URL) {
    super('authorization required');
  }
}

/** Connects to the MCP server: oauth uses the stored tokens (or starts authorization), xaa uses an exchanged token */
async function connect(server: McpServer, origin: string, user: McpUser, startsAuth: boolean) {
  const key = keyOf(user.id, server.name);
  const fetch = createMcpFetch((scope) => getStore().set(key, { stepUpScope: scope }, TTL_SECONDS));

  if (server.auth === 'xaa') {
    const token = await xaaToken(server, user);
    try {
      const client = await createMCPClient({
        transport: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${token}` }, fetch },
      });
      return { client, stepUp: false };
    } catch (error) {
      // Drops the token so that the next request exchanges again
      await getStore().remove(key, ['tokens']);
      throw error;
    }
  }

  const authProvider = await StoredOAuthProvider.load(server, origin, user.id, startsAuth);
  // Starts step-up authorization with the requested scope
  if (startsAuth && authProvider.stepUpScope) {
    authProvider.hideTokens();
    await auth(authProvider, { serverUrl: server.url, scope: authProvider.stepUpScope, fetchFn: mcpFetch });
    if (authProvider.authorizationUrl) throw new AuthorizationRequired(authProvider.authorizationUrl);
  }
  try {
    const client = await createMCPClient({ transport: { type: 'http', url: server.url, authProvider, fetch } });
    return { client, stepUp: !!authProvider.stepUpScope };
  } catch (error) {
    if (error instanceof UnauthorizedError && authProvider.authorizationUrl) throw new AuthorizationRequired(authProvider.authorizationUrl);
    throw error;
  }
}

type ServerStatus = {
  name: string;
  tools?: number;
  /** Authorization URL when the user needs to connect */
  authorizeUrl?: string;
  /** Connected, but step-up authorization is required */
  stepUp?: boolean;
  error?: string;
};

// Connects to the MCP servers and collects their tools as `<server>__<tool>`.
// With name, connects only to that server and may start authorization; the URL is returned as authorizeUrl.
export async function connectAll(origin: string, user: McpUser, name?: string) {
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  const statuses: ServerStatus[] = [];

  for (const server of mcpServers().filter((s) => !name || s.name === name)) {
    try {
      const { client, stepUp } = await connect(server, origin, user, name !== undefined);
      clients.push(client);
      const serverTools = await client.tools();
      for (const [toolName, t] of Object.entries(serverTools)) tools[`${server.name}__${toolName}`] = t;
      statuses.push({ name: server.name, tools: Object.keys(serverTools).length, ...(stepUp ? { stepUp } : {}) });
    } catch (error) {
      if (error instanceof AuthorizationRequired) {
        statuses.push({ name: server.name, authorizeUrl: error.url.toString() });
        continue;
      }
      if (!(error instanceof UnauthorizedError)) log.warn('mcp_connect_failed', { server: server.name, ...errorFields(error) });
      statuses.push({ name: server.name, error: (error as Error).message });
    }
  }
  return { tools, statuses, close: () => Promise.all(clients.map((c) => c.close())) };
}

// Creates a `<name>__connect` tool for each server that is not connected or needs step-up.
// When the model calls it, the UI shows a connect button.
export function connectTools(statuses: ServerStatus[]): ToolSet {
  const tools: ToolSet = {};
  for (const s of statuses.filter((s) => s.authorizeUrl || s.stepUp)) {
    const description = mcpServers().find((m) => m.name === s.name)?.description ?? s.name;
    const purpose = s.stepUp
      ? `Grant the "${s.name}" MCP server (${description}) the additional permission it asked for. Call this when one of its tools failed because of insufficient permission.`
      : `Connect the "${s.name}" MCP server (${description}) so that its tools become available. Call this when the user's request needs it.`;
    tools[`${s.name}__connect`] = tool({
      description: purpose,
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () =>
        `A button labeled "${labelOf(s.name)} に接続" is now shown to the user. Ask them to press it and then send the request again.`,
    });
  }
  return tools;
}

// Server statuses for the UI, without authorization URLs.
// Error details are replaced with a fixed message, except for the re-login message.
export const publicStatuses = (statuses: ServerStatus[]) =>
  statuses.map(({ authorizeUrl, error, ...s }) => ({
    ...s,
    ...(error ? { error: error === RELOGIN_MESSAGE ? error : '接続できませんでした' } : {}),
    label: labelOf(s.name),
    needsAuth: !!authorizeUrl,
  }));

/** Deletes all stored MCP data of the user */
export async function deleteUserData(user: string) {
  await Promise.all(mcpServers().map((s) => getStore().delete(keyOf(user, s.name))));
}
