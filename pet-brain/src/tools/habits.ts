import { z } from "zod";
import { guarded, type ToolRegistrar } from "./shared.js";

const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;

export const registerHabitTools: ToolRegistrar = (server, { habits }) => {
  server.registerTool(
    "habit_add",
    {
      description:
        "Cria um hábito: o pet cutuca o dono no chat a cada N minutos (ex.: beber água, alongar). Não cutuca de madrugada. Para um aviso único, use reminder_add. Nunca coloque segredos no nome.",
      inputSchema: { name: z.string().min(1).max(60), everyMinutes: z.number().int().min(MIN_MINUTES).max(MAX_MINUTES) },
    },
    ({ name, everyMinutes }) =>
      guarded(async () => {
        const habit = await habits.add({ name, everyMinutes });
        return `Hábito "${habit.name}" criado: aviso a cada ${String(habit.everyMinutes)} min (id ${habit.id}).`;
      }),
  );

  server.registerTool(
    "habit_list",
    { description: "Lista os hábitos do dono e quantas vezes cada um foi feito hoje.", inputSchema: {} },
    () =>
      guarded(async () => {
        const all = await habits.list();
        return all.length === 0
          ? "Nenhum hábito ainda."
          : all.map((habit) => `- ${habit.name}: a cada ${String(habit.everyMinutes)} min, feito ${String(habit.doneToday)}x hoje`).join("\n");
      }),
  );
};
