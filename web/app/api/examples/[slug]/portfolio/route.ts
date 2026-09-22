export const dynamic = 'force-dynamic';

// Retire old PDF links as well as the visible preview. No signed URL is issued.
export function GET() {
  return Response.json({ error: '이미지 공개 불가' }, {
    status: 410, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
