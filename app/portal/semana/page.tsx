import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { authorization, toActor } from "@/lib/authz";
import { MS_PER_DAY, effectiveCycleStatus, isReportable } from "@/lib/cycles";
import { prisma } from "@/lib/db";
import type { RegistrationField } from "@/lib/invitations";
import { createPaymentsService } from "@/lib/payments";
import { settings } from "@/lib/settings";
import { createWeeklyReportsService } from "@/lib/weekly-reports";

import { PaymentForm, type PaymentMethodOption } from "./payment-form";
import { WeekForm, type WeekDefaults } from "./week-form";

/**
 * Last-resort labels for the six `payment_method` enum codes. Since F6 the
 * catalog carries its own `label` and order (D55); this map only covers rows
 * that predate the admin catalog or arrive without one.
 */
const METHOD_LABELS: Record<string, string> = {
  TRANSFER: "Transferencia",
  MOBILE: "Pago móvil",
  ZELLE: "Zelle",
  CASH: "Efectivo",
  CRYPTO: "Cripto",
  OTHER: "Otro",
};

// =============================================================================
// app/portal/semana/page.tsx — the member's week: Visión Celular report and
// the offering report of the current cycle (§8.2).
//
// Two independent things live here on purpose: marking your OWN attendance
// (weekly report) and reporting your offering. The spec makes them
// independent — reporting a payment is not attendance, and vice versa.
//
// Reads only. Every mutation goes through the Server Actions in
// lib/payments-actions.ts and lib/weekly-actions.ts; this page re-reads after
// `router.refresh()` so what is on screen is what the database says.
// =============================================================================

export const dynamic = "force-dynamic";

interface CycleRow {
  id: string;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  due_at: Date;
  status: string;
}

interface PaymentMethodRow {
  id: string;
  code: string;
  label: string;
  requires_reference: boolean;
  requires_proof: boolean;
}

export default async function WeekPage() {
  const session = await requireSession("/portal/semana");
  const actor = toActor(session);

  const payments = createPaymentsService(prisma, settings, authorization);
  const weekly = createWeeklyReportsService(prisma, authorization);

  const now = new Date();

  const [cycles, methodRows, customFieldRows, myPaymentReports, weeklyHistory] = await Promise.all([
    prisma.$queryRaw<CycleRow[]>`
      SELECT id, period_key, starts_at, ends_at, due_at, status
      FROM payment_cycles
      WHERE starts_at <= ${now}
      ORDER BY starts_at DESC
      LIMIT 1
    `,
    prisma.$queryRaw<PaymentMethodRow[]>`
      SELECT id, code, label, requires_reference, requires_proof
      FROM payment_methods
      WHERE is_active
      ORDER BY sort_order, label
    `,
    // The PAYMENT_REPORT fields the offering form renders (D56); the service
    // re-reads them inside its transaction, so this read is for the UI only.
    prisma.$queryRaw<RegistrationField[]>`
      SELECT code, label, type, options,
             is_required AS "isRequired", regex,
             min_numeric::text AS "minNumeric", max_numeric::text AS "maxNumeric",
             sort_order AS "sortOrder", default_value AS "defaultValue"
      FROM custom_fields
      WHERE entity = 'PAYMENT_REPORT' AND is_active
      ORDER BY sort_order, code
    `,
    payments.listMyReports({ id: session.userId, role: session.role }, { limit: 8 }),
    weekly.myReports(actor, { limit: 8 }),
  ]);

  const [currency, amountMode, expectedAmount] = await Promise.all([
    settings.get<string>("payments.currency"),
    settings.get<string>("payments.amount_mode"),
    settings.get<unknown>("payments.expected_amount"),
  ]);

  const cycle = cycles[0] ?? null;
  const statusInput = cycle
    ? {
        status: cycle.status,
        startsAt: cycle.starts_at,
        endsAt: cycle.ends_at,
        dueAt: cycle.due_at,
      }
    : null;

  const effective = statusInput ? effectiveCycleStatus(statusInput, now) : null;
  const reportable = statusInput ? isReportable(statusInput, now) : false;

  const myWeeklyReport = cycle
    ? (weeklyHistory.find((row) => row.cycleId === cycle.id) ?? null)
    : null;
  const downline = cycle
    ? await weekly.downlineReports(actor, { cycleId: cycle.id, limit: 25 })
    : [];
  const offerings = cycle ? await payments.downlineOfferings(actor, { cycleId: cycle.id, limit: 25 }) : [];
  const offeringByUser = new Map(offerings.map((row) => [row.userId, row]));
  const board = downline.map((row) => ({ ...row, offering: offeringByUser.get(row.userId) }));

  const weeklyDefaults: WeekDefaults | null = myWeeklyReport
    ? {
        attended: myWeeklyReport.attended,
        discipleshipAttended: myWeeklyReport.discipleshipAttended,
        cellsTotal: myWeeklyReport.cellsTotal,
        cellsHeld: myWeeklyReport.cellsHeld,
        cellsNotHeld: myWeeklyReport.cellsNotHeld,
        cellAttendees: myWeeklyReport.cellAttendees,
        cellAbsentees: myWeeklyReport.cellAbsentees,
        cellNewVisitors: myWeeklyReport.cellNewVisitors,
        cellNewCells: myWeeklyReport.cellNewCells,
        visitors: myWeeklyReport.visitors,
        note: myWeeklyReport.note,
      }
    : null;

  const methods: PaymentMethodOption[] = methodRows.map((row) => ({
    id: row.id,
    code: row.code,
    label: row.label.trim() === "" ? (METHOD_LABELS[row.code] ?? row.code) : row.label,
    requiresReference: row.requires_reference,
    requiresProof: row.requires_proof,
  }));

  return (
    <SessionShell
      session={session}
      title="Semana y aportes"
      description="Tu reporte de la Visión Celular y el aporte de esta semana."
    >
      <section className="rounded-lg border bg-background p-4 text-sm">
        {cycle && effective ? (
          <>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {weekRangeLabel(cycle.starts_at, cycle.ends_at)}
            </p>
            <p className="mt-1">
              Del {dayLabel(cycle.starts_at)} al {dayLabel(cycle.ends_at)} ·{" "}
              <span className="font-medium">{statusLabel(effective)}</span>
            </p>
            <p className="mt-1 text-muted-foreground">
              {reportable
                ? `Puedes reportar hasta el ${dayLabel(cycle.due_at)} (${daysLeft(cycle.due_at, now)} ${daysLeft(cycle.due_at, now) === 1 ? "día" : "días"}).`
                : "La semana está cerrada: solo consulta."}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            Todavía no hay una semana planificada. Aparecerá sola cuando el
            sistema abra el próximo ciclo.
          </p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <WeekForm defaults={weeklyDefaults} editable={reportable} />
        <PaymentForm
          methods={methods}
          fields={customFieldRows}
          currency={currency}
          amountMode={amountMode}
          expectedAmount={expectedAmount === null ? null : String(expectedAmount)}
          editable={reportable}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Mis aportes</h2>
        {myPaymentReports.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
            Todavía no reportaste aportes.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-background">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Semana</th>
                  <th className="px-4 py-3 font-medium">Monto</th>
                  <th className="px-4 py-3 font-medium">Método</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Fecha de pago</th>
                </tr>
              </thead>
              <tbody>
                {myPaymentReports.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      {row.periodKey}
                      {row.status === "REJECTED" && row.reviewNote ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Motivo: {row.reviewNote}
                          {reportable
                            ? " — puedes enviar uno nuevo esta semana."
                            : " — la semana ya cerró."}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {row.amount} {row.currency}
                    </td>
                    <td className="px-4 py-3">{row.method}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3">{dayLabel(row.paidAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Visión Celular · las personas de tu alcance
        </h2>
        <p className="text-sm text-muted-foreground">
          Ves únicamente a las personas que están dentro de tu alcance. Las
          semanas cerradas siguen consultables.
        </p>
        {downline.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
            Nadie de tu alcance registró su reporte esta semana.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-background">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Persona</th>
                  <th className="px-4 py-3 font-medium">Asistió</th>
                  <th className="px-4 py-3 font-medium">Ofrenda</th>
                  <th className="px-4 py-3 font-medium">Células</th>
                  <th className="px-4 py-3 font-medium">Asistentes</th>
                  <th className="px-4 py-3 font-medium">Visitantes nuevos</th>
                  <th className="px-4 py-3 font-medium">Nota</th>
                </tr>
              </thead>
              <tbody>
                {board.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <span className="font-medium">{row.fullName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.publicCode}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.attended ? "Sí" : "No"}</td>
                    <td className="px-4 py-3">
                      {row.offering?.hasOffering ? "Sí" : "No"}
                      {row.offering?.amount ? (
                        <span className="block text-xs text-muted-foreground">{row.offering.amount} {row.offering.currency}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {row.cellsHeld} de {row.cellsTotal}
                    </td>
                    <td className="px-4 py-3">{row.cellAttendees}</td>
                    <td className="px-4 py-3">{row.cellNewVisitors}</td>
                    <td className="px-4 py-3">{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </SessionShell>
  );
}

function statusLabel(status: "OPEN" | "GRACE" | "CLOSED"): string {
  if (status === "OPEN") return "Semana abierta";
  if (status === "GRACE") return "Periodo de gracia";
  return "Cerrada";
}

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** Friendly range: the raw `period_key` is a database key, not UI copy. */
function weekRangeLabel(start: Date, end: Date): string {
  const startMonth = MONTHS_ES[start.getMonth()] ?? "";
  const endMonth = MONTHS_ES[end.getMonth()] ?? "";

  if (start.getFullYear() !== end.getFullYear()) {
    return `Semana del ${start.getDate()} de ${startMonth} de ${start.getFullYear()} al ${end.getDate()} de ${endMonth} de ${end.getFullYear()}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `Semana del ${start.getDate()} de ${startMonth} al ${end.getDate()} de ${endMonth}`;
  }
  return `Semana del ${start.getDate()} al ${end.getDate()} de ${startMonth}`;
}

function daysLeft(dueAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / MS_PER_DAY));
}

/** `DD/MM/YYYY`, formatted on the server so SSR stays deterministic. */
function dayLabel(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function StatusBadge({ status }: { status: "PENDING" | "APPROVED" | "REJECTED" }) {
  const styles: Record<string, string> = {
    PENDING: "bg-muted text-foreground",
    APPROVED: "bg-primary text-primary-foreground",
    REJECTED: "bg-destructive/10 text-destructive",
  };
  const labels: Record<string, string> = {
    PENDING: "Pendiente",
    APPROVED: "Aprobado",
    REJECTED: "Rechazado",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
