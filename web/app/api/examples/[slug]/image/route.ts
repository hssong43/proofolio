export const dynamic = 'force-dynamic';

// Public portfolio media is withdrawn; never fetch or sign the retained private original.
export function GET() {
  return Response.json({ error: '이미지 공개 불가' }, {
    status: 410, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
