// =============================================================================
// e2e/admin-pages.spec.ts — smoke for the two admin pages no other spec opens:
// /admin/pagos and /admin/reportes.
//
// Both shipped broken because every unit test mocks the database and only
// asserts on the parameter stream: invalid raw-SQL aliases stayed green while
// production returned "Application error". This spec renders the real pages
// against the throwaway database, so a server exception fails the run instead
// of hiding behind a green unit suite.
// =============================================================================

import { expect, test } from "@playwright/test";

import { E2E_ROOT_EMAIL, E2E_ROOT_PASSWORD } from "./db-target";

test("pagos y reportes renderizan sin error de servidor", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ---- Root signs in ---------------------------------------------------
    await page.goto("/login");
    await page.fill("#email", E2E_ROOT_EMAIL);
    await page.fill("#password", E2E_ROOT_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));

    // ---- /admin/pagos — the filtered ledger (raw-SQL regression) ---------
    const pagos = await page.goto("/admin/pagos");
    expect(pagos?.status() ?? 0).toBeLessThan(500);
    await expect(page.getByText("Application error")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pagos", exact: true })).toBeVisible();
    await expect(page.getByText("Semanas", { exact: true })).toBeVisible();

    // ---- /admin/reportes — consolidated sheet + participation donut ------
    const reportes = await page.goto("/admin/reportes");
    expect(reportes?.status() ?? 0).toBeLessThan(500);
    await expect(page.getByText("Application error")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Reportes", exact: true })).toBeVisible();
    await expect(page.getByText("Participación de la semana")).toBeVisible();
  } finally {
    await context.close();
  }
});
