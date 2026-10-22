// =============================================================================
// e2e/journey.spec.ts — the §16 mandated flow, end to end:
//
//   invitar → registrar → reportar → aprobar → ver en el dashboard semanal
//
// Runs against the throwaway database provisioned by global-setup.ts. Two
// browser contexts keep the two sessions (root and member) independent — the
// journey never relies on logging out.
// =============================================================================

import { expect, test } from "@playwright/test";

import {
  E2E_MEMBER_EMAIL,
  E2E_MEMBER_NAME,
  E2E_MEMBER_NATIONAL_ID,
  E2E_MEMBER_PASSWORD,
  E2E_MEMBER_USERNAME,
  E2E_REPORT_AMOUNT,
  E2E_ROOT_EMAIL,
  E2E_ROOT_PASSWORD,
} from "./db-target";

test("invitar → registrar → reportar → aprobar → dashboard semanal", async ({ browser }) => {
  const rootContext = await browser.newContext();
  const memberContext = await browser.newContext();

  try {
    // ---- 1. Root signs in ------------------------------------------------
    const rootPage = await rootContext.newPage();
    await rootPage.goto("/login");
    await rootPage.fill("#identifier", E2E_ROOT_EMAIL);
    await rootPage.fill("#password", E2E_ROOT_PASSWORD);
    await rootPage.getByRole("button", { name: "Entrar" }).click();
    await rootPage.waitForURL((url) => !url.pathname.startsWith("/login"));

    // ---- 2. Root creates a one-use invitation ----------------------------
    await rootPage.goto("/portal/invitations");
    await rootPage.getByRole("button", { name: "Crear invitación" }).click();

    const createdBox = rootPage.getByText("Tu nueva invitación").locator("..");
    const linkInput = createdBox.locator("input[readonly]");
    await expect(linkInput).toHaveValue(/\/invite\//);

    const inviteUrl = await linkInput.inputValue();
    const token = inviteUrl.split("/invite/")[1];
    expect(token, "the invitation link must carry a token").toBeTruthy();

    // ---- 3. The invitee registers and lands inside the portal ------------
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`/invite/${token}`);
    await memberPage.fill("#fullName", E2E_MEMBER_NAME);
    await memberPage.fill("#username", E2E_MEMBER_USERNAME);
    await memberPage.fill("#nationalId", E2E_MEMBER_NATIONAL_ID);
    await memberPage.fill("#email", E2E_MEMBER_EMAIL);
    await memberPage.fill("#password", E2E_MEMBER_PASSWORD);
    await memberPage.getByRole("button", { name: "Registrarme" }).click();
    await memberPage.waitForURL(/\/portal(\/|$)/);

    // ---- 4. The member reports this week's offering ----------------------
    await memberPage.goto("/portal/semana");
    await memberPage.fill("#pay-amount", E2E_REPORT_AMOUNT);
    // The default method (Transferencia) requires a reference.
    await memberPage.fill("#pay-reference", "E2E-REF-0001");
    await memberPage.getByRole("button", { name: "Enviar ofrenda" }).click();
    await expect(memberPage.getByText("Ofrenda enviada", { exact: false })).toBeVisible();

    // ---- 5. Root sees the pending report in the weekly dashboard ---------
    await rootPage.goto("/admin");
    const kpis = rootPage.locator('section[aria-label="Indicadores de la semana"]');
    // Pending money does not count as collected: the week-filtered KPI is 0.
    await expect(kpis.getByText("0.00 USD").first()).toBeVisible();

    // ---- 6. Root approves it in the review queue --------------------------
    await rootPage.goto("/admin/revisiones");
    await expect(rootPage.getByText(E2E_MEMBER_NAME)).toBeVisible();
    await rootPage.getByRole("button", { name: "Aprobar" }).click();
    const approveDialog = rootPage.getByRole("dialog");
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByRole("button", { name: "Aprobar" }).click();
    await expect(rootPage.getByText("Aporte aprobado.")).toBeVisible();
    await expect(
      rootPage.getByText("No hay aportes pendientes de revisión", { exact: false }),
    ).toBeVisible();

    // ---- 7. The approved offering shows up in the weekly dashboard --------
    await rootPage.goto("/admin");
    const kpisAfter = rootPage.locator('section[aria-label="Indicadores de la semana"]');
    await expect(kpisAfter.getByText(`${E2E_REPORT_AMOUNT} USD`).first()).toBeVisible();
  } finally {
    await rootContext.close();
    await memberContext.close();
  }
});
