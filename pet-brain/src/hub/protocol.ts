import { z } from "zod";
import { MEDIA_ACTIONS } from "./media.js";

export const MAX_CHAT_CHARS = 8000;
const MAX_TOKEN_CHARS = 256;
const MAX_REMINDER_CHARS = 200;
const MAX_REMINDER_MINUTES = 365 * 24 * 60;
const MAX_HABIT_CHARS = 60;
const MAX_ART_URL_CHARS = 600;
const MAX_TRACK_FIELD_CHARS = 200;
const MAX_CAPTURE_CHARS = 500;
const MAX_SEEK_SECONDS = 24 * 60 * 60;
const MIN_HABIT_MINUTES = 5;
const MAX_HABIT_MINUTES = 24 * 60;

export const DEVICES = ["pc", "phone"] as const;
export type Device = (typeof DEVICES)[number];
export const SIGNALS = ["poke", "wave", "scare", "play", "goodnight"] as const;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().max(MAX_TOKEN_CHARS), device: z.enum(DEVICES).optional() }),
  z.object({ type: z.literal("chat"), text: z.string().min(1).max(MAX_CHAT_CHARS) }),
  z.object({ type: z.literal("decide"), id: z.string().regex(/^[a-f0-9]{16}$/), approved: z.boolean() }),
  z.object({ type: z.literal("signal"), kind: z.enum(SIGNALS) }),
  z.object({ type: z.literal("sleep"), asleep: z.boolean() }),
  z.object({ type: z.literal("media"), action: z.enum(MEDIA_ACTIONS) }),
  z.object({ type: z.literal("media_art"), url: z.string().min(1).max(MAX_ART_URL_CHARS) }),
  z.object({ type: z.literal("media_seek"), seconds: z.number().int().min(0).max(MAX_SEEK_SECONDS) }),
  z.object({
    type: z.literal("lyrics"),
    title: z.string().min(1).max(MAX_TRACK_FIELD_CHARS),
    artist: z.string().max(MAX_TRACK_FIELD_CHARS),
    duration: z.number().int().min(0).max(MAX_SEEK_SECONDS),
  }),
  z.object({ type: z.literal("perf") }),
  z.object({ type: z.literal("weather") }),
  z.object({ type: z.literal("briefing") }),
  z.object({ type: z.literal("capture"), text: z.string().min(1).max(MAX_CAPTURE_CHARS) }),
  z.object({ type: z.literal("reminders") }),
  z.object({ type: z.literal("reminder_add"), text: z.string().min(1).max(MAX_REMINDER_CHARS), inMinutes: z.number().int().min(1).max(MAX_REMINDER_MINUTES) }),
  z.object({ type: z.literal("reminder_cancel"), id: z.string().regex(/^[a-f0-9]{16}$/) }),
  z.object({ type: z.literal("habits") }),
  z.object({ type: z.literal("habit_add"), name: z.string().min(1).max(MAX_HABIT_CHARS), everyMinutes: z.number().int().min(MIN_HABIT_MINUTES).max(MAX_HABIT_MINUTES) }),
  z.object({ type: z.literal("habit_done"), id: z.string().regex(/^[a-f0-9]{16}$/) }),
  z.object({ type: z.literal("habit_remove"), id: z.string().regex(/^[a-f0-9]{16}$/) }),
  z.object({ type: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage | undefined {
  try {
    const parsed = clientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
