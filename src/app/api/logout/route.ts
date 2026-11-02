import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { errorFields, log } from '@/lib/log';
import { deleteUserData } from '@/lib/mcp';
import { logoutUrl } from '@/lib/okta';

// Deletes the user's MCP data and returns the Okta logout URL (OIDC RP-Initiated Logout).
// The client clears the app session with next-auth signOut.
export async function POST(req: NextRequest) {
  const origin = new URL(req.url).origin;
  // Accepts same-origin requests only
  if (req.headers.get('origin') !== origin) return Response.json({ error: 'forbidden' }, { status: 403 });

  const user = await currentUser();
  if (!user) return Response.json({ url: `${origin}/` });

  await deleteUserData(user.id);
  log.info('logout', { user: user.id });
  try {
    return Response.json({ url: await logoutUrl(user.idToken, `${origin}/`) });
  } catch (error) {
    // Falls back to the app root if the Okta logout URL cannot be built
    log.warn('okta_logout_url_failed', { user: user.id, ...errorFields(error) });
    return Response.json({ url: `${origin}/` });
  }
}
