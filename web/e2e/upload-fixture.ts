import { expect, type BrowserContext } from '@playwright/test';

export async function mockPdfUpload(context: BrowserContext, runId: string, expected: Record<string, unknown>) {
  const uploadUrl = `https://storage.example/upload/${runId}`;
  await context.route('**/api/analyze/upload', route => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON();
    expect(body).toMatchObject(expected);
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.size).toBeGreaterThan(4);
    expect(route.request().postData()!.length).toBeLessThan(4096);
    if (!expected.submissionId) expect(body.submissionId).toBeUndefined();
    return route.fulfill({ json: { runId, uploadUrl } });
  });
  await context.route(uploadUrl, route => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataBuffer()?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { Key: 'synthetic.pdf' } });
  });
}
