import { z } from "zod";
import { ReminderError } from "../reminders/store.js";
import { guarded, type ToolRegistrar } from "./shared.js";

const MS_PER_MINUTE = 60_000;
const MAX_MINUTES = 365 * 24 * 60;
const WITH_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/;

const when = z
  .string()
  .refine((value) => WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value)), "at precisa de data e hora com fuso, ex.: 2026-11-10T18:00:00-03:00");

export const registerReminderTools: ToolRegistrar = (server, { reminders }) => {
  server.registerTool(
    "reminder_add",
    {
      description:
        "Agenda um lembrete para o dono; no horário ele aparece no chat do pet. Use inMinutes (daqui a N minutos) OU at (data e hora com fuso). Nunca coloque segredos no texto.",
      inputSchema: {
        text: z.string().min(1).max(200),
        inMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
        at: when.optional(),
      },
    },
    ({ text, inMinutes, at }) =>
      guarded(async () => {
        if ((inMinutes === undefined) === (at === undefined)) throw new ReminderError("Informe exatamente um: inMinutes ou at.");
        const dueAt = at !== undefined ? new Date(at) : new Date(Date.now() + (inMinutes ?? 0) * MS_PER_MINUTE);
        const reminder = await reminders.add({ text, dueAt });
        return `Lembrete ${reminder.id} agendado para ${reminder.dueAt}.`;
      }),
  );

  server.registerTool(
    "reminder_list",
    { description: "Lista os lembretes pendentes do dono.", inputSchema: {} },
    () =>
      guarded(async () => {
        const pending = await reminders.list();
        return pending.length === 0 ? "Nenhum lembrete pendente." : pending.map((item) => `- ${item.dueAt}: ${item.text}`).join("\n");
      }),
  );
};
