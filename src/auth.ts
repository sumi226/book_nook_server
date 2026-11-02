import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { Request } from "express";
import { config } from "./config.js";

const jwks = createRemoteJWKSet(new URL(config.BETTER_AUTH_JWKS_URL));

export type AuthenticatedUser = {
  email: string;
  name: string;
};

export async function resolveAuthSession(
  request: Request,
): Promise<AuthenticatedUser | null> {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], jwks, {
      issuer: config.BETTER_AUTH_ISSUER,
      audience: config.BETTER_AUTH_AUDIENCE,
      algorithms: ["EdDSA"],
    }));
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.name !== "string"
  ) {
    return null;
  }

  return {
    email: payload.email.trim().toLowerCase(),
    name: payload.name,
  };
}
