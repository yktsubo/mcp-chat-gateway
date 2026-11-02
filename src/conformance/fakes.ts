import nock from 'nock';

// Fake authorization servers, MCP servers, and Okta for conformance tests.
// HTTP is intercepted with nock, and the requests sent by the app are recorded.

export type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  form: URLSearchParams;
};

export const requests: Recorded[] = [];

export function resetFakes() {
  nock.cleanAll();
  requests.length = 0;
  nock.disableNetConnect(); // blocks all other network access
}

type Reply = [number, unknown?, Record<string, string>?];

/** Responds to and records requests to origin + path (persistent) */
export function route(method: 'GET' | 'POST' | 'DELETE', url: string, reply: (req: Recorded) => Reply) {
  const { origin, pathname } = new URL(url);
  const scope = nock(origin).persist();
  const interceptor =
    method === 'GET' ? scope.get(pathname) : method === 'POST' ? scope.post(pathname) : scope.delete(pathname);
  // nock 15 passes a standard Request to the reply function
  interceptor.query(true).reply(async (request: Request) => {
    const body = await request.clone().text();
    const recorded: Recorded = {
      method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body,
      form: new URLSearchParams(request.headers.get('content-type')?.includes('form') ? body : ''),
    };
    requests.push(recorded);
    const [status, payload, headers] = reply(recorded);
    return [status, typeof payload === 'string' ? payload : JSON.stringify(payload ?? ''), { 'content-type': 'application/json', ...headers }];
  });
}

export const findRequests = (method: string, url: string) =>
  requests.filter((r) => r.method === method && r.url.split('?')[0] === url);

// --- MCP server (Streamable HTTP, JSON-RPC) ---------------------------------------------

export type McpServerOptions = {
  url: string;
  /** Accepted access token; others get 401 */
  token: string;
  /** WWW-Authenticate for 401 */
  challenge?: string;
  /** Responds to tools/call with 403 insufficient_scope */
  insufficientScope?: string;
};

export function fakeMcpServer({ url, token, challenge, insufficientScope }: McpServerOptions) {
  route('POST', url, (req): Reply => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return [401, '', challenge ? { 'www-authenticate': challenge } : {}];
    }
    const message = JSON.parse(req.body) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) return [202, ''];
    const result = (() => {
      switch (message.method) {
        case 'initialize':
          return {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
          };
        case 'tools/list':
          return { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] };
        default:
          return {};
      }
    })();
    if (message.method === 'tools/call' && insufficientScope) {
      return [403, '', { 'www-authenticate': `Bearer error="insufficient_scope", scope="${insufficientScope}"` }];
    }
    return [200, { jsonrpc: '2.0', id: message.id, result }];
  });
  route('GET', url, () => [405, '']);
  route('DELETE', url, () => [200, '']);
}

// --- Authorization server ---------------------------------------------------------------------------

export type AuthorizationServerOptions = {
  issuer: string;
  /** Metadata URL (default: RFC 8414 path insertion) */
  metadataUrl?: string;
  metadata?: Record<string, unknown>;
  token?: (req: Recorded) => Reply;
};

export function rfc8414MetadataUrl(issuer: string) {
  const { origin, pathname } = new URL(issuer);
  return `${origin}/.well-known/oauth-authorization-server${pathname === '/' ? '' : pathname}`;
}

export function fakeAuthorizationServer({ issuer, metadataUrl, metadata = {}, token }: AuthorizationServerOptions) {
  const doc = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    // Fields required by OpenID Connect Discovery
    jwks_uri: `${issuer}/keys`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    ...metadata,
  };
  route('GET', metadataUrl ?? rfc8414MetadataUrl(issuer), () => [200, doc]);
  route('POST', `${issuer}/register`, (req) => [201, { ...JSON.parse(req.body), client_id: 'registered-client' }]);
  route('POST', `${issuer}/token`, token ?? (() => [200, { access_token: 'mcp-access-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' }]));
  return doc;
}

export function fakeProtectedResourceMetadata(url: string, metadata: Record<string, unknown>) {
  route('GET', url, () => [200, metadata]);
}
