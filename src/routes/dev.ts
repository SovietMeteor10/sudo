import { Router } from "express";
import { searchIdentityHandles } from "../discovery/discovery.service.js";
import { AccountAccessError, accountAccessProvider, createDevSession, getIdentityForDevSession } from "../localState/accountAccess.js";
import { DevSignupError, createDevIdentity } from "../identity/devSignup.js";

export const devRouter = Router();

type SignupBody = {
  handle?: unknown;
  password?: unknown;
  recoveryQuestion?: unknown;
  recoveryAnswer?: unknown;
};

type SigninBody = {
  handle?: unknown;
  password?: unknown;
};

type RecoverBody = {
  handle?: unknown;
  backupCode?: unknown;
  recoveryQuestion?: unknown;
  recoveryAnswer?: unknown;
};

devRouter.post("/dev/signup", (request, response) => {
  // DEV ONLY: this endpoint intentionally creates server-side private keys in
  // data/keys for local development. Do not expose it as production signup.
  const body = request.body as SignupBody;

  if (typeof body.handle !== "string") {
    response.status(400).json({ error: "invalid_handle", message: "handle is required" });
    return;
  }

  if (typeof body.password !== "string" || !isStrongPassword(body.password)) {
    response.status(400).json({ error: "weak_password", message: "password does not meet requirements" });
    return;
  }

  if (typeof body.recoveryQuestion !== "string" || body.recoveryQuestion.trim().length < 1) {
    response.status(400).json({ error: "invalid_recovery_question", message: "recovery question is required" });
    return;
  }

  if (typeof body.recoveryAnswer !== "string" || body.recoveryAnswer.trim().length < 1) {
    response.status(400).json({ error: "invalid_recovery_answer", message: "recovery answer is required" });
    return;
  }

  try {
    const baseUrl = process.env.SUDO_BASE_URL ?? `${request.protocol}://${request.get("host")}`;
    const host = process.env.SUDO_HOST ?? "autodidact.fun";
    const result = createDevIdentity({
      rawHandle: body.handle,
      password: body.password,
      recoveryQuestion: body.recoveryQuestion.trim(),
      recoveryAnswer: body.recoveryAnswer.trim(),
      baseUrl,
      host
    });

    response.status(201).json({
      identity: result.identity,
      backupCode: result.backupCode,
      sessionToken: createDevSession(result.canonicalId).token
    });
  } catch (error) {
    if (error instanceof DevSignupError) {
      response
        .status(error.code === "duplicate_handle" ? 409 : 400)
        .json({ error: error.code, message: error.message });
      return;
    }

    throw error;
  }
});

devRouter.post("/dev/recover", (request, response) => {
  const body = request.body as RecoverBody;

  if (
    typeof body.handle !== "string"
    || typeof body.backupCode !== "string"
    || typeof body.recoveryQuestion !== "string"
    || typeof body.recoveryAnswer !== "string"
  ) {
    response.status(400).json({ error: "invalid_credentials", message: "handle, backup code, recovery question, and recovery answer are required" });
    return;
  }

  try {
    const result = accountAccessProvider.recoverCredential(
      body.handle,
      body.backupCode,
      body.recoveryAnswer
    );
    response.json({
      identity: result.identity,
      sessionToken: result.session.token,
      expiresAt: result.session.expiresAt
    });
  } catch (error) {
    if (error instanceof AccountAccessError) {
      response.status(401).json({ error: error.code, message: error.message });
      return;
    }

    throw error;
  }
});

devRouter.post("/dev/signin", (request, response) => {
  const body = request.body as SigninBody;

  if (
    typeof body.handle !== "string"
    || typeof body.password !== "string"
  ) {
    response.status(400).json({ error: "invalid_credentials", message: "handle and password are required" });
    return;
  }

  try {
    const result = accountAccessProvider.unlockCredential(
      body.handle,
      body.password
    );
    response.json({
      identity: result.identity,
      sessionToken: result.session.token,
      expiresAt: result.session.expiresAt
    });
  } catch (error) {
    if (error instanceof AccountAccessError) {
      response.status(401).json({ error: error.code, message: error.message });
      return;
    }

    throw error;
  }
});

devRouter.get("/dev/session", (request, response) => {
  const authorization = request.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authorization);

  if (!match) {
    response.status(401).json({ error: "missing_session", message: "missing bearer token" });
    return;
  }

  const identity = getIdentityForDevSession(match[1]!);
  if (!identity) {
    response.status(401).json({ error: "invalid_session", message: "session expired or invalid" });
    return;
  }

  response.json(identity);
});

devRouter.get("/dev/search-handles", (request, response) => {
  const query = typeof request.query["q"] === "string" ? request.query["q"] : "";
  response.json({ results: searchIdentityHandles(query) });
});

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 12
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password)
  );
}
