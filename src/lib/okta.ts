import { Issuer, type BaseClient, type ClientMetadata } from 'openid-client';
import { authorizationServerMetadata } from './discovery';
import { log } from './log';

// Requests to Okta (login token refresh, logout, XAA exchange) with openid-client.
// Client authentication is private_key_jwt if OKTA_AI_AGENT_PRIVATE_KEY is set, otherwise the client secret.

// Key types for private_key_jwt
type Jwks = NonNullable<ConstructorParameters<typeof BaseClient>[1]>;
type JWK = Jwks['keys'][number];

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const ID_JAG_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

function privateKey(): JWK | undefined {
  const raw = process.env.OKTA_AI_AGENT_PRIVATE_KEY;
  return raw ? (JSON.parse(raw) as JWK) : undefined;
}

/** Client metadata (client_id and authentication method) and the private_key_jwt keys */
export function clientCredentials(clientId: string): { client: ClientMetadata; jwks?: Jwks } {
  const key = privateKey();
  if (key) {
    return {
      client: {
        client_id: clientId,
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: key.alg ?? 'RS256',
      },
      jwks: { keys: [key] },
    };
  }
  return {
    client: {
      client_id: clientId,
      client_secret: process.env.OKTA_CLIENT_SECRET,
      token_endpoint_auth_method: 'client_secret_basic',
    },
  };
}

const issuers = new Map<string, Promise<Issuer<BaseClient>>>();
const notAdvertised = new Set<string>();

/** Discovers the authorization server and creates a client for it */
async function clientFor(issuer: string, clientId: string): Promise<BaseClient> {
  let discovered = issuers.get(issuer);
  if (!discovered) {
    discovered = Issuer.discover(issuer);
    discovered.catch(() => issuers.delete(issuer));
    issuers.set(issuer, discovered);
  }
  const { client, jwks } = clientCredentials(clientId);
  return new (await discovered).Client(client, jwks);
}

/**
 * Sets the aud of the private_key_jwt client assertion to the token endpoint URL.
 * Ignored when the client secret is used.
 */
export const assertionAudience = (client: BaseClient) => ({
  clientAssertionPayload: { aud: client.issuer.metadata.token_endpoint },
});

/** For tests: clears the discovered metadata */
export function clearIssuerCache() {
  issuers.clear();
  notAdvertised.clear();
}

/** Refreshes the login tokens */
export async function refreshLogin(refreshToken: string) {
  const client = await clientFor(process.env.OKTA_ISSUER!, process.env.OKTA_CLIENT_ID!);
  return client.refresh(refreshToken, assertionAudience(client));
}

/** Returns the OIDC RP-Initiated Logout URL that ends the Okta session */
export async function logoutUrl(idToken: string | undefined, postLogoutRedirectUri: string) {
  const client = await clientFor(process.env.OKTA_ISSUER!, process.env.OKTA_CLIENT_ID!);
  return client.endSessionUrl({
    ...(idToken ? { id_token_hint: idToken } : {}),
    post_logout_redirect_uri: postLogoutRedirectUri,
  });
}

type XaaRequest = {
  /** Authorization server of the MCP server */
  issuer: string;
  /** Resource identifier of the MCP server; sent only when set */
  resource?: string;
  scope: string;
};

/**
 * XAA (Cross App Access): exchanges the user's ID token for an ID-JAG at the Okta org authorization server
 * (RFC 8693 Token Exchange), then exchanges the ID-JAG for an access token at the MCP server's authorization
 * server (RFC 7523 JWT Bearer). Both requests are made as the AI agent.
 */
export async function exchangeIdToken(idToken: string, { issuer, resource, scope }: XaaRequest) {
  const agentId = process.env.OKTA_AI_AGENT_ID || process.env.OKTA_CLIENT_ID!;

  // Logs once per authorization server if it does not advertise the ID-JAG profile, then continues
  const metadata = (await authorizationServerMetadata(issuer)) as { authorization_grant_profiles_supported?: string[] };
  if (!metadata.authorization_grant_profiles_supported?.includes(ID_JAG_PROFILE) && !notAdvertised.has(issuer)) {
    notAdvertised.add(issuer);
    log.warn('xaa_profile_not_advertised', { issuer });
  }

  const org = await clientFor(process.env.OKTA_ISSUER!, agentId);
  const idJag = await org.grant(
    {
      grant_type: TOKEN_EXCHANGE,
      requested_token_type: ID_JAG,
      subject_token: idToken,
      subject_token_type: ID_TOKEN,
      audience: issuer,
      ...(resource ? { resource } : {}),
      ...(scope ? { scope } : {}),
    },
    assertionAudience(org),
  );
  // Checks that the response is an ID-JAG (issued_token_type) with token_type N_A
  if (idJag.issued_token_type !== ID_JAG || idJag.token_type?.toLowerCase() !== 'n_a' || !idJag.access_token) {
    throw new Error(`Unexpected token exchange response: issued_token_type=${idJag.issued_token_type}, token_type=${idJag.token_type}`);
  }

  const resourceServer = await clientFor(issuer, agentId);
  return resourceServer.grant({ grant_type: JWT_BEARER, assertion: idJag.access_token }, assertionAudience(resourceServer));
}
