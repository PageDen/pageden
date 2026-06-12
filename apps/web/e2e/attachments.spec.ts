import { test, expect } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("attachments: upload an image in the editor, save, reload, it persists and loads", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Media ${suffix}`;
  const documentTitle = `Picture doc ${suffix}`;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  // Folder + document.
  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(folderName);
  await dialog.getByRole("button", { name: "Save" }).click();
  const folderRow = page.getByRole("listitem").filter({ hasText: folderName });
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await folderRow.getByRole("button", { name: "New document" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(documentTitle);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.locator("nav").getByRole("link", { name: documentTitle }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Document body")).toBeVisible();

  // Upload an image through the editor's hidden file input.
  await page.locator('.rich-markdown-editor input[type="file"]').first().setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });

  // The image appears in the editor and points at a stored attachment.
  const img = page.locator(".rich-markdown-editor img").first();
  await expect(img).toBeVisible({ timeout: 15000 });
  await expect(img).toHaveAttribute("src", /\/api\/attachments\//);
  // And it actually loads (first-party download works).
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Selected images get an Outline-style floating toolbar for layout controls.
  await expect(page.getByRole("button", { name: "Align image left" })).toBeVisible();
  const widthInput = page.getByLabel("Image width");
  const heightInput = page.getByLabel("Image height");
  await expect.poll(async () => Number(await widthInput.inputValue())).toBeGreaterThan(0);
  await expect.poll(async () => Number(await heightInput.inputValue())).toBeGreaterThan(0);
  await widthInput.fill("320");
  await page.getByRole("button", { name: "Align image right" }).click();
  await expect(img).toHaveAttribute("width", "320");
  await expect(img).toHaveAttribute("data-align", "right");
  const rightHandle = page.getByRole("button", { name: "Resize image right" });
  await expect(rightHandle).toBeVisible();
  const rightHandleBox = await rightHandle.boundingBox();
  if (!rightHandleBox) throw new Error("Resize handle was not measurable");
  const handleCenterX = rightHandleBox.x + rightHandleBox.width / 2;
  const handleCenterY = rightHandleBox.y + rightHandleBox.height / 2;
  await page.mouse.move(handleCenterX, handleCenterY);
  await page.mouse.down();
  await page.mouse.move(handleCenterX + 60, handleCenterY, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number((await img.getAttribute("width")) ?? "0")).toBeGreaterThan(320);
  const resizedWidth = await img.getAttribute("width");
  const resizedHeight = await img.getAttribute("height");
  expect(resizedWidth).toBeTruthy();
  expect(resizedHeight).toBeTruthy();

  // Save, reload — the image reference persists in the stored Markdown.
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  const reloaded = page.locator(".rich-markdown-editor img, .prose img").first();
  await expect(reloaded).toBeVisible({ timeout: 15000 });
  await expect(reloaded).toHaveAttribute("src", /\/api\/attachments\//);
  await expect(reloaded).toHaveAttribute("width", resizedWidth ?? "");
  await expect(reloaded).toHaveAttribute("height", resizedHeight ?? "");
  await expect(reloaded).toHaveAttribute("data-align", "right");
  await expect.poll(async () => reloaded.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});
