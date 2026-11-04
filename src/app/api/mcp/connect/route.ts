import { NextResponse, type NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { connectAll, mcpServers } from '@/lib/mcp';

// Starts MCP authorization for the server and redirects to the authorization server
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user = await currentUser();
  if (!user) return new Response('ログインしてください', { status: 401 });

  // Rejects a server name that is not configured, including a missing one
  const name = url.searchParams.get('server');
  if (!name || !mcpServers().some((s) => s.name === name)) {
    return new Response('不正なリクエストです', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const mcp = await connectAll(url.origin, user, name);
  await mcp.close();
  return NextResponse.redirect(mcp.statuses[0]?.authorizeUrl ?? new URL('/', url.origin), 303);
}
