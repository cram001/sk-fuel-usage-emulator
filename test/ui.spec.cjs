const { test, expect } = require("@playwright/test");
test("standalone WebApp discovers engine, tracks refills, resets trip and saves configuration", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto("/sk-fuel-usage-mgr-emulator/");
  await expect(
    page.getByRole("heading", { name: "SK Fuel Usage Manager Emulator" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "main", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tanks", exact: true }).click();
  await page.getByLabel("Capacity (L)", { exact: true }).fill("100");
  await page.getByLabel("Reserve (L)", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Save tank" }).click();
  await expect(
    page.getByRole("heading", { name: "Main tank", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Set full", exact: true }).click();
  await expect(page.locator(".fdm-big")).toContainText("100");
  await page.getByLabel("Fuel quantity (L)", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Set quantity", exact: true }).click();
  await expect(page.locator(".fdm-big")).toContainText("20");
  await page.getByLabel("Fuel quantity (L)", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Add fuel", exact: true }).click();
  await expect(page.locator(".fdm-big")).toContainText("30");
  await page.getByRole("button", { name: "Fuel", exact: true }).click();
  await page.getByLabel("Fuel supply tank").selectOption("main");
  await page.getByRole("button", { name: "Reset trip", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Checkpoint interval (seconds)").fill("15");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("status")).toContainText("Configuration saved");
  await page.getByRole("button", { name: "Fuel", exact: true }).click();
  await page.screenshot({
    path: "test-results/fuel-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/fuel-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("federated React 19 panel mounts in a host and uses its save contract", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/admin/test-host");
  await expect(
    page.getByRole("heading", { name: "SK Fuel Usage Manager Emulator" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Checkpoint interval (seconds)").fill("45");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect
    .poll(() => page.evaluate(() => window.savedConfig?.checkpointSeconds))
    .toBe(45);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.hostError)).toBeUndefined();
});
