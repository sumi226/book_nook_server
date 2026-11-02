import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  MONGODB_URI: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("mongodb://") || value.startsWith("mongodb+srv://"), {
      message: "MONGODB_URI must use mongodb:// or mongodb+srv://",
    }),
  MONGODB_DB: z.string().trim().min(1).default("booknook"),
  BETTER_AUTH_JWKS_URL: z.string().url(),
  BETTER_AUTH_ISSUER: z.string().url(),
  BETTER_AUTH_AUDIENCE: z.string().url(),
  FRONTEND_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const config = configSchema.parse(process.env);
