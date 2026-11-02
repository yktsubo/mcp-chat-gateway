import type { NextRequest } from 'next/server';
import { clientMetadata, clientMetadataDocumentUrl } from '@/lib/mcp';

// OAuth Client ID Metadata Document (CIMD); its URL is the client_id
export function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  return Response.json(
    { client_id: clientMetadataDocumentUrl(origin), ...clientMetadata(origin) },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
