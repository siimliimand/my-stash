import { z } from "zod";

export const CardSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1, "Title is required"),
  body: z.string().min(1, "Body is required"),
  source: z.string().default(""),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  favorite: z.boolean().default(false),
  lastReviewedAt: z.string().datetime().nullable().default(null),
  reviewCount: z.number().int().nonnegative().default(0),
  origin: z.enum(["user", "ai"]).default("user"),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  batchDate: z.string().optional(),
});

export const StashSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, "Stash name is required"),
  cardIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string().datetime(),
});

export const SettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).default("system"),
});

export const AppDataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  cards: z.array(CardSchema).default([]),
  stashes: z.array(StashSchema).default([]),
  settings: SettingsSchema.default({ theme: "system" }),
});

export const CardFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  body: z.string().min(1, "Key takeaway is required"),
  source: z.string().default(""),
  tags: z.array(z.string()).default([]),
});

export type CardFormData = z.infer<typeof CardFormSchema>;
