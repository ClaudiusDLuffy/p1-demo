import { z } from "zod";

export const PARTS_RECIPIENT_LIMIT = 25;
const profileId = z.string().trim().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const partsPhoneSchema = z.string().max(40).transform(value => value.replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9][0-9]{7,14}$/));
export const partsTimezoneSchema = z.string().trim().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); return true; }
  catch { return false; }
}, "Use a valid IANA timezone.");
const cutoff = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
const recipient = z.object({
  profileId, phoneE164: partsPhoneSchema, active: z.boolean(),
  // Stale first-party settings forms send these display fields. Validate then
  // discard them; none can select the actor, recipient identity, or phone.
  id: z.string().uuid().optional(), name: z.string().max(200).optional(),
  email: z.string().max(320).nullable().optional(),
}).strict().transform(value => ({ profileId: value.profileId, phoneE164: value.phoneE164, active: value.active }));
export const partsSettingsCommandSchema = z.object({
  enabled: z.boolean(), timezone: partsTimezoneSchema, cutoffTime: cutoff,
  recipients: z.array(recipient).max(PARTS_RECIPIENT_LIMIT),
}).strict().superRefine((value, context) => {
  if (new Set(value.recipients.map(item => item.profileId.toLowerCase())).size !== value.recipients.length) {
    context.addIssue({ code: "custom", path: ["recipients"], message: "Each staff recipient may appear only once." });
  }
  if (value.enabled && !value.cutoffTime) context.addIssue({ code: "custom", path: ["cutoffTime"], message: "Set a cutoff before enabling alerts." });
  if (value.enabled && value.recipients.length === 0) context.addIssue({ code: "custom", path: ["recipients"], message: "Add a recipient before enabling alerts." });
});
export type PartsSettingsCommand = z.infer<typeof partsSettingsCommandSchema>;

export const partsSettingsResponseSchema = z.object({
  enabled: z.boolean(), timezone: partsTimezoneSchema, cutoffTime: cutoff,
  updatedAt: z.string().nullable(), recipients: z.array(z.object({
    id: z.string().uuid(), profileId, phoneE164: partsPhoneSchema, active: z.boolean(),
    name: z.string().max(200), email: z.string().max(320).nullable(),
  })).max(PARTS_RECIPIENT_LIMIT),
});
export type PartsSettingsResponse = z.infer<typeof partsSettingsResponseSchema>;
