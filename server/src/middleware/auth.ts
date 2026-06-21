// middleware/auth.ts — security slice 1: the auth SEAM + network bind resolver.
//
// THE SEAM (why this file exists): today Nodedex is a single-owner LOCAL tool,
// so auth is one shared bearer token. The future Phase-2 remote server is
// multi-tenant (per-account credentials). This module is written so that going
// multi-tenant is a swap of ONE function — validateCredential(token) → identity
// — while credential extraction, the gate placement in api-server.ts, and every
// downstream `req.auth` reference stay put. Do NOT build accounts/passwords in
// the local tool; they belong to the closed Phase-2 server. See memory
// project-monetization-direction-2026-06-13 for the bigger picture.

import type { Request, Response, NextFunction } from "express";

// The identity attached to a request once authenticated.
// TODAY only `owner` is ever produced; `account` is the shape the future
// server's validateCredential will return. Downstream code can already branch
// on req.auth.kind without caring which era it's in.
export type AuthIdentity =
  | { kind: "owner" }                        // single-owner local tool (today)
  | { kind: "account"; accountId: string };  // multi-tenant server (future)

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthIdentity;
  }
}

// ─── Network bind ───────────────────────────────────────────────────────────
// Default to loopback so a fresh install is NOT reachable from the network.
// Intentional exposure (the future remote server, or a LAN dev box) opts in via
// NODEDEX_BIND_HOST=0.0.0.0. Pure + exported so it's unit-testable without
// opening a socket.
export function resolveBindHost(): string {
  const h = (process.env.NODEDEX_BIND_HOST || "").trim();
  return h.length > 0 ? h : "127.0.0.1";
}

// ─── Auth ───────────────────────────────────────────────────────────────────

// Is the whole-API token lock turned on? Unset = OFF (open, localhost-protected)
// so the live dogfood loop and a naive install keep working.
export function apiTokenEnabled(): boolean {
  return (process.env.NODEDEX_API_TOKEN || "").length > 0;
}

// Pull the presented credential. Prefer a DEDICATED header so we never collide
// with Authorization, which the chat-proxy forwards verbatim to the upstream
// LLM. Authorization: Bearer is also accepted for convenience on data paths.
export function extractCredential(req: Request): string {
  const x = (req.headers["x-nodedex-token"] || "") as string;
  if (x && x.trim()) return x.trim();
  const auth = (req.headers["authorization"] || "").toString();
  return auth.replace(/^Bearer\s+/i, "").trim();
}

// THE SWAP POINT. token → identity (or null if it doesn't authenticate).
// Today: constant-time compare to the one configured owner token.
// Future server: replace the body with a token→account DB lookup returning
// { kind: "account", accountId }. Callers only check apiTokenEnabled() first,
// so this is only invoked when a token is actually configured.
export function validateCredential(token: string): AuthIdentity | null {
  const expected = process.env.NODEDEX_API_TOKEN || "";
  if (!expected) return null;
  if (token && safeEqual(token, expected)) return { kind: "owner" };
  return null;
}

// Length-then-constant-time compare — avoids leaking the token via timing.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// App-level gate. When the token is OFF: pass everything, stamping the owner
// identity (single-owner tool). When ON: require a valid credential on every
// /api/* path except those the caller exempts (health for supervisors, the
// chat-proxy BYO-key passthrough, and non-/api pages like /upgrade).
export function requireAuth(opts: { exempt: (path: string) => boolean }) {
  return (req: Request, res: Response, next: NextFunction) => {
    req.auth = { kind: "owner" }; // default identity; replaced below if a token authenticates
    if (!apiTokenEnabled()) return next();
    if (opts.exempt(req.path)) return next();
    const identity = validateCredential(extractCredential(req));
    if (!identity) {
      return res.status(401).json({
        error: "Unauthorized — set header 'x-nodedex-token' or 'Authorization: Bearer <token>' (NODEDEX_API_TOKEN is enabled)",
      });
    }
    req.auth = identity;
    next();
  };
}

// What the whole-API gate does NOT cover: liveness (supervisors poll it), the
// chat-proxy (authenticates with the client's own forwarded LLM key), and any
// non-/api path (the /upgrade page, static). NB for Phase 2: the remote server
// MUST gate /api/chat (it spends money) — that exemption is local-tool-only.
export function defaultAuthExempt(p: string): boolean {
  return !p.startsWith("/api/") || p === "/api/health" || p.startsWith("/api/chat");
}
