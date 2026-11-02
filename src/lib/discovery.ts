import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';

// Metadata discovery for MCP authorization. Results are cached for a short time.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { value: Promise<unknown>; expires: number }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => cache.delete(key));
  cache.set(key, { value, expires: Date.now() + CACHE_MS });
  return value;
}

/** For tests: clears the cache */
export function clearDiscoveryCache() {
  cache.clear();
}

type ResourceInfo = { resource: string; authorizationServers: string[] };

/**
 * Protected Resource Metadata (RFC 9728) of the MCP server.
 * Throws if `resource` does not match the server URL.
 */
export function resourceInfo(serverUrl: string): Promise<ResourceInfo> {
  return cached(`prm:${serverUrl}`, async () => {
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    const allowed = checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(serverUrl),
      configuredResource: metadata.resource,
    });
    if (!allowed) throw new Error(`Protected resource ${metadata.resource} does not match ${serverUrl}`);
    return { resource: metadata.resource, authorizationServers: metadata.authorization_servers ?? [] };
  });
}

/**
 * Authorization server for the MCP server, chosen from authorization_servers.
 * If expected is given, checks that it is listed.
 */
export async function authorizationServerFor(serverUrl: string, expected?: string): Promise<string> {
  const { authorizationServers } = await resourceInfo(serverUrl);
  if (expected) {
    if (!authorizationServers.includes(expected)) {
      throw new Error(`Authorization server ${expected} is not listed for ${serverUrl}`);
    }
    return expected;
  }
  if (!authorizationServers[0]) throw new Error(`No authorization server is listed for ${serverUrl}`);
  return authorizationServers[0];
}

/** Authorization server metadata (RFC 8414 / OpenID Connect Discovery) */
export function authorizationServerMetadata(issuer: string) {
  return cached(`as:${issuer}`, async () => {
    const metadata = await discoverAuthorizationServerMetadata(issuer);
    if (!metadata) throw new Error(`No authorization server metadata for ${issuer}`);
    return metadata;
  });
}
