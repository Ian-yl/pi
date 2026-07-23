import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5174";
const uploadBuffer = Buffer.from("89504e470d0a", "hex");
const resultImage =
  "data:image/svg+xml," +
  encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'/>");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });

await page.route("**/api/**", async (route) => {
  const url = route.request().url();
  if (url.endsWith("/api/pages/pg-1t/bootstrap")) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ pageId: "pg-1t", gallery: [] }),
    });
    return;
  }
  if (url.endsWith("/api/generations/try-on")) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        taskId: "test-task",
        status: "completed",
        gallery: [{ id: "origin", label: "origin", url: resultImage }],
      }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{}",
  });
});

await page.goto(`${baseUrl}/try-on`);
await page.waitForLoadState("networkidle");

const fileInputs = page.locator('input[type="file"]');
await assert.equal(await fileInputs.count(), 2);
await fileInputs.nth(0).setInputFiles({
  name: "product-upload.png",
  mimeType: "image/png",
  buffer: uploadBuffer,
});
await fileInputs.nth(1).setInputFiles({
  name: "reference-model-upload.png",
  mimeType: "image/png",
  buffer: uploadBuffer,
});

const requestPromise = page.waitForRequest(
  (request) =>
    request.url().endsWith("/api/generations/try-on") &&
    request.method() === "POST",
);
await page.locator(".primary-generate").click();
const body = (await requestPromise).postDataBuffer().toString("latin1");

assert.match(body, /name="files"; filename="product-upload\.png"/);
assert.match(body, /name="files"; filename="reference-model-upload\.png"/);
assert.equal((body.match(/name="files"; filename=/g) ?? []).length, 2);
assert.equal(body.includes('"file":{}'), false);

await browser.close();
