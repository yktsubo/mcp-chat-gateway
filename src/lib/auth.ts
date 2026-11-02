import { getServerSession, type NextAuthOptions } from 'next-auth';
import OktaProvider from 'next-auth/providers/okta';
import { errorFields, log } from './log';
import { assertionAudience, clientCredentials, refreshLogin } from './okta';

// Login with Okta OIDC. The session is an encrypted cookie (next-auth JWT) that also holds the ID token
// (used for XAA) and the refresh token; neither is sent to the browser.

// Refresh the ID token this many seconds before it expires
const REFRESH_MARGIN_SECONDS = 60;

/**
 * withRefresh: whether to refresh an expiring ID token. Enabled only for the next-auth handler (/api/auth/*),
 * which can write the updated cookie.
 */
function createAuthOptions(withRefresh: boolean): NextAuthOptions {
  const { client, jwks } = clientCredentials(process.env.OKTA_CLIENT_ID!);
  return {
    providers: [
      OktaProvider({
        issuer: process.env.OKTA_ISSUER!,
        clientId: process.env.OKTA_CLIENT_ID!,
        clientSecret: process.env.OKTA_CLIENT_SECRET ?? '',
        client,
        jwks,
        authorization: { params: { scope: 'openid profile email offline_access' } },
        checks: ['pkce', 'state', 'nonce'],
        // With private_key_jwt, sets the client assertion aud to the token endpoint for the code exchange
        ...(jwks && {
          token: {
            request: async ({ client, params, checks, provider }) => ({
              tokens: await client.callback(provider.callbackUrl, params, checks, assertionAudience(client)),
            }),
          },
        }),
      }),
    ],
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account) {
          return {
            ...token,
            username: (profile as { preferred_username?: string } | undefined)?.preferred_username,
            idToken: account.id_token,
            refreshToken: account.refresh_token,
            expiresAt: account.expires_at,
          };
        }
        const expiresAt = token.expiresAt as number | undefined;
        const fresh = !expiresAt || expiresAt - REFRESH_MARGIN_SECONDS > Date.now() / 1000;
        if (!withRefresh || fresh || !token.refreshToken) return token;
        try {
          const tokens = await refreshLogin(token.refreshToken as string);
          return {
            ...token,
            idToken: tokens.id_token ?? token.idToken,
            refreshToken: tokens.refresh_token ?? token.refreshToken,
            expiresAt: tokens.expires_at,
            error: undefined,
          };
        } catch (error) {
          log.warn('login_refresh_failed', { user: token.sub, ...errorFields(error) });
          return { ...token, error: 'RefreshFailed' };
        }
      },
      // The browser session contains only the user ID and username
      session: ({ session, token }) => ({ ...session, user: { ...session.user, id: token.sub, username: token.username } }),
    },
  };
}

/** Options for the next-auth handler */
export const authOptions = createAuthOptions(true);

// Options for server-side use; the session also includes the ID token
const serverOptions: NextAuthOptions = {
  ...createAuthOptions(false),
  callbacks: {
    ...createAuthOptions(false).callbacks,
    session: ({ session, token }) => ({
      ...session,
      user: { ...session.user, id: token.sub, username: token.username },
      idToken: token.error ? undefined : token.idToken,
    }),
  },
};

type CurrentUser = { id: string; name: string; idToken?: string };

/** Returns the signed-in user (ID, name, ID token), or undefined */
export async function currentUser(): Promise<CurrentUser | undefined> {
  const session = (await getServerSession(serverOptions)) as {
    user?: { id?: string; username?: string; email?: string };
    idToken?: string;
  } | null;
  const user = session?.user;
  if (!user?.id) return undefined;
  return { id: user.id, name: user.username || user.email || user.id, idToken: session?.idToken };
}
