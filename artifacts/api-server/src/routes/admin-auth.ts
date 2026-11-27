import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import { db, adminUsersTable, adminSessionsTable, adminUserRolesTable } from "@workspace/db";
import { lt, eq } from "drizzle-orm";
import { adminPasswordMatches, createAdminPasswordHash, generateAdminSalt } from "../lib/admin-password";
import { adminQueryTokenAllowed, selectAdminSessionToken } from "../lib/admin-session-token";
import { forbidSellerStaff, isSellerStaffRole, normalizeAdminApiPath, sellerStaffMayAccess } from "../lib/seller-staff-access";
import { isMissingSchemaError, readAdminAccess } from "../lib/admin-user-access";
import { writeAdminAuditFromRequest } from "../lib/admin-audit";

const router: IRouter = Router();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const ADMIN_AUTH_VERBOSE_LOGS = String(process.env.ADMIN_AUTH_VERBOSE_LOGS || "false").toLowerCase() === "true";
const ADMIN_ALLOW_QUERY_TOKEN = adminQueryTokenAllowed(process.env.ADMIN_ALLOW_QUERY_TOKEN);
const ADMIN_SESSION_COOKIE_NAME = String(process.env.ADMIN_SESSION_COOKIE_NAME || "admin_session").trim();
const ADMIN_SESSION_COOKIE_SAMESITE = (() => {
  const raw = String(process.env.ADMIN_SESSION_COOKIE_SAMESITE || (process.env.NODE_ENV === "production" ? "none" : "lax")).trim().toLowerCase();
  if (raw === "none" || raw === "lax" || raw === "strict") return raw as "none" | "lax" | "strict";
  return process.env.NODE_ENV === "production" ? "none" : "lax";
})();
const ADMIN_SESSION_COOKIE_SECURE = (() => {
  const configured = String(process.env.ADMIN_SESSION_COOKIE_SECURE || (process.env.NODE_ENV === "production" ? "true" : "false")).toLowerCase() === "true";
  // Browsers require Secure when SameSite=None.
  return configured || ADMIN_SESSION_COOKIE_SAMESITE === "none";
})();

type AdminSessionRecord = {
  username: string;
  isPrimary: number | boolean;
};

export type AdminScope = {
  username: string;
  isPrimary: boolean;
  hasGlobalAccess: boolean;
  sellerCode: string | null;
  role: "admin" | "vendedora";
};

let adminSellerScopeMapCache: Record<string, string> | null = null;

function redactToken(token: string): string {
  if (!token) return "";
  if (token.length <= 12) return "[REDACTED]";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function sanitizeHeadersForLog(headers: Request["headers"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => {
      const normalized = key.toLowerCase();
      if (normalized === "authorization" || normalized === "cookie") {
        return [key, "[REDACTED]"];
      }
      return [key, value];
    }),
  );
}

function headerValue(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] || "" : value || "");
}

function getTokenFromRequest(req: Request): string {
  const authorizationHeader = headerValue(req.headers.authorization);
  const cookieToken = String((req as { cookies?: Record<string, string> }).cookies?.[ADMIN_SESSION_COOKIE_NAME] || "");
  const queryToken = String((req.query as Record<string, string | undefined>)?.token || "");
  const token = selectAdminSessionToken({
    authorizationHeader,
    cookieToken,
    queryToken,
    allowQueryToken: ADMIN_ALLOW_QUERY_TOKEN,
  });
  const bearer = authorizationHeader.startsWith("Bearer ") ? authorizationHeader.slice(7).trim() : "";
  if (ADMIN_AUTH_VERBOSE_LOGS && ADMIN_ALLOW_QUERY_TOKEN && token && !bearer && !cookieToken.trim() && queryToken.trim()) {
    console.warn("[AdminAuth] Token via query string (legacy mode) usado em", req.path);
  }
  return token;
}

export async function adminSessionTokenIsActive(token: string): Promise<boolean> {
  const value = String(token || "").trim();
  if (!value) return false;
  try {
    const rows = await db
      .select({ expiresAt: adminSessionsTable.expiresAt })
      .from(adminSessionsTable)
      .where(eq(adminSessionsTable.token, value))
      .limit(1);
    const expiresAt = rows[0]?.expiresAt;
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() > Date.now();
  } catch (err) {
    console.error("[AdminAuth] Falha ao validar sessão. A proteção de checkout permanece.", err);
    return false;
  }
}

function normalizeSellerCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function getAdminSellerScopeMap(): Record<string, string> {
  if (adminSellerScopeMapCache) return adminSellerScopeMapCache;

  const raw = process.env["ADMIN_SELLER_SCOPE_MAP"];
  if (!raw) {
    adminSellerScopeMapCache = {};
    return adminSellerScopeMapCache;
  }

  try {
    const parsed = JSON.parse(raw);
    const map: Record<string, string> = {};

    if (parsed && typeof parsed === "object") {
      for (const [username, sellerCode] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedUsername = String(username).trim().toLowerCase();
        const normalizedSeller = normalizeSellerCode(sellerCode);
        if (normalizedUsername && normalizedSeller) {
          map[normalizedUsername] = normalizedSeller;
        }
      }
    }

    adminSellerScopeMapCache = map;
    return map;
  } catch (err) {
    console.error("[AdminAuth] ADMIN_SELLER_SCOPE_MAP inválido. Use JSON no formato {\"usuario\":\"seller-slug\"}.", err);
    adminSellerScopeMapCache = {};
    return adminSellerScopeMapCache;
  }
}

export function resolveAdminScopeFromSession(session: AdminSessionRecord): AdminScope {
  const username = String(session.username || "").trim().toLowerCase();
  const isPrimary = !!session.isPrimary;
  if (isPrimary) {
    return {
      username,
      isPrimary,
      hasGlobalAccess: true,
      sellerCode: null,
      role: "admin",
    };
  }

  const sellerCode = getAdminSellerScopeMap()[username] ?? null;
  return {
    username,
    isPrimary,
    hasGlobalAccess: false,
    sellerCode,
    role: "admin",
  };
}

export function getAdminScope(req: Request): AdminScope | null {
  const session = (req as any).adminSession;
  if (!session) return null;
  return {
    username: String(session.username || "").trim().toLowerCase(),
    isPrimary: !!session.isPrimary,
    hasGlobalAccess: !!session.hasGlobalAccess,
    sellerCode: normalizeSellerCode(session.sellerCode),
    role: isSellerStaffRole(session.role) ? "vendedora" : "admin",
  };
}

async function loadUserAccess(username: string) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) return null;
  let user: typeof adminUsersTable.$inferSelect | undefined = (
    await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, normalized)).limit(1)
  )[0];
  if (!user) {
    const allUsers = await db.select().from(adminUsersTable);
    user = allUsers.find((row) => row.username.toLowerCase() === normalized);
  }
  if (!user) return null;
  const access = await readAdminAccess(user.id);
  return { user, access };
}

export async function verifyCurrentAdminPassword(req: Request, password: string): Promise<boolean> {
  const plain = String(password || "");
  if (!plain) return false;

  const session = (req as any).adminSession as { username?: string } | undefined;
  const sessionUsername = String(session?.username || "").trim().toLowerCase();
  if (!sessionUsername) return false;

  let user: typeof adminUsersTable.$inferSelect | undefined = (
    await db
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.username, sessionUsername))
      .limit(1)
  )[0];

  if (!user) {
    const allUsers = await db.select().from(adminUsersTable);
    user = allUsers.find((u) => u.username.toLowerCase() === sessionUsername);
  }

  if (!user) return false;
  return adminPasswordMatches(plain, user.salt, user.passwordHash);
}

// Utilitário para limpar sessões expiradas do banco
async function purgeExpiredSessions() {
  const now = new Date();
  await db.delete(adminSessionsTable).where(
    lt(adminSessionsTable.expiresAt, now)
  );
}

// --------------------------------------------------------------------------
// Seed admin users from env vars on first run
// --------------------------------------------------------------------------
async function seedFromEnvIfEmpty() {
  const existing = await db.select({ id: adminUsersTable.id }).from(adminUsersTable).limit(1);
  if (existing.length > 0) return; // already seeded

  const usersToSeed: Array<{ username: string; password: string; isPrimary: boolean }> = [];

  if (process.env["ADMIN_USERNAME"] && process.env["ADMIN_PASSWORD"]) {
    usersToSeed.push({ username: process.env["ADMIN_USERNAME"], password: process.env["ADMIN_PASSWORD"], isPrimary: true });
  }
  if (process.env["ADMIN_USERNAME_2"] && process.env["ADMIN_PASSWORD_2"]) {
    usersToSeed.push({ username: process.env["ADMIN_USERNAME_2"], password: process.env["ADMIN_PASSWORD_2"], isPrimary: false });
  }

  for (const u of usersToSeed) {
    const existingUser = await db.select({ id: adminUsersTable.id }).from(adminUsersTable).where(eq(adminUsersTable.username, u.username.trim())).limit(1);
    if (existingUser.length > 0) continue;

    const salt = generateAdminSalt();
    await db.insert(adminUsersTable).values({
      id:           crypto.randomBytes(8).toString("hex"),
      username:     u.username.trim(),
      passwordHash: createAdminPasswordHash(u.password, salt),
      salt,
      isPrimary:    u.isPrimary,
    });
  }

  if (usersToSeed.length > 0) {
    console.log(`[AdminAuth] Seeded ${usersToSeed.length} admin user(s) from env vars.`);
  }
}

// Run seed on startup
seedFromEnvIfEmpty().catch(console.error);

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------
export async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (ADMIN_AUTH_VERBOSE_LOGS) {
      console.log('[requireAdminAuth] INICIO', { headers: sanitizeHeadersForLog(req.headers), query: req.query });
    }
    const token = getTokenFromRequest(req);
    await purgeExpiredSessions();

    if (!token) {
      if (ADMIN_AUTH_VERBOSE_LOGS) {
        console.log('[requireAdminAuth] Sem token');
      }
      res.status(401).json({ error: "UNAUTHORIZED", message: "Acesso não autorizado." });
      return;
    }
    const sessionRows = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.token, token)).limit(1);
    if (!sessionRows[0]) {
      if (ADMIN_AUTH_VERBOSE_LOGS) {
        console.log('[requireAdminAuth] Sessão não encontrada para token', redactToken(token));
      }
      res.status(401).json({ error: "UNAUTHORIZED", message: "Acesso não autorizado." });
      return;
    }
    const loaded = await loadUserAccess(sessionRows[0].username);
    if (!loaded) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Acesso não autorizado." });
      return;
    }
    if (!loaded.access.active) {
      await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, token));
      res.status(401).json({ error: "UNAUTHORIZED", message: "Conta desativada." });
      return;
    }

    if (isSellerStaffRole(loaded.access.role)) {
      const path = normalizeAdminApiPath(req.originalUrl || req.path);
      if (!sellerStaffMayAccess(req.method, path)) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          void writeAdminAuditFromRequest(req, {
            actorUsername: loaded.user.username,
            actorRole: "vendedora",
            action: "denied",
            entityType: "route",
            entityId: `${req.method} ${path}`.slice(0, 255),
            before: null,
            after: { allowed: false },
          });
        }
        res.status(403).json({ error: "FORBIDDEN", message: "Sem permissão para esta ação." });
        return;
      }
      (req as any).adminSession = {
        ...sessionRows[0],
        username: loaded.user.username,
        isPrimary: false,
        hasGlobalAccess: true,
        sellerCode: null,
        role: "vendedora",
      };
      next();
      return;
    }

    const scope = resolveAdminScopeFromSession(sessionRows[0]);

    if (!scope.hasGlobalAccess && !scope.sellerCode) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Usuário admin sem seller vinculado. Configure ADMIN_SELLER_SCOPE_MAP.",
      });
      return;
    }

    // Anexa info da sessão para downstream
    (req as any).adminSession = { ...sessionRows[0], ...scope, role: "admin" };
    if (ADMIN_AUTH_VERBOSE_LOGS) {
      console.log('[requireAdminAuth] Sessão OK', {
        username: scope.username,
        isPrimary: scope.isPrimary,
        hasGlobalAccess: scope.hasGlobalAccess,
        sellerCode: scope.sellerCode,
        expiresAt: sessionRows[0].expiresAt,
      });
    }
    next();
  } catch (err) {
    console.error('[requireAdminAuth] Erro:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Erro interno na autenticação', details: String(err) });
  }
}

export async function requirePrimaryAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromRequest(req);
  await purgeExpiredSessions();

  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Acesso não autorizado." });
    return;
  }
  const sessionRows = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.token, token)).limit(1);
  if (!sessionRows[0] || !sessionRows[0].isPrimary) {
    res.status(403).json({ error: "FORBIDDEN", message: "Apenas o administrador principal pode realizar esta ação." });
    return;
  }
  const loaded = await loadUserAccess(sessionRows[0].username);
  if (loaded && (!loaded.access.active || isSellerStaffRole(loaded.access.role))) {
    res.status(403).json({ error: "FORBIDDEN", message: "Apenas o administrador principal pode realizar esta ação." });
    return;
  }
  const scope = resolveAdminScopeFromSession(sessionRows[0]);
  (req as any).adminSession = { ...sessionRows[0], ...scope, role: "admin" };
  next();
}

export async function getSessionInfo(req: Request) {
  const token = getTokenFromRequest(req);
  if (!token) return undefined;
  const sessionRows = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.token, token)).limit(1);
  if (!sessionRows[0]) return undefined;
  return { ...sessionRows[0], ...resolveAdminScopeFromSession(sessionRows[0]) };
}

// --------------------------------------------------------------------------
// POST /api/admin/login
// --------------------------------------------------------------------------
router.post("/admin/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Usuário e senha são obrigatórios." });
    return;
  }

  try {
    const users = await db
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.username, username.trim().toLowerCase()))
      .limit(1);

    // Also try case-insensitive via all users (small table)
    let user: typeof adminUsersTable.$inferSelect | undefined = users[0];
    if (!user) {
      const allUsers = await db.select().from(adminUsersTable);
      user = allUsers.find(
        (u) => u.username.toLowerCase() === username.trim().toLowerCase()
      );
    }

    if (!user) {
      res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Usuário ou senha incorretos." });
      return;
    }

    if (!adminPasswordMatches(password, user.salt, user.passwordHash)) {
      res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Usuário ou senha incorretos." });
      return;
    }

    const access = await readAdminAccess(user.id);
    if (!access.active) {
      res.status(401).json({ error: "ACCOUNT_DISABLED", message: "Conta desativada. Fale com o administrador." });
      return;
    }
    const role = access.role;
    const isPrimary = role === "vendedora" ? false : Boolean(user.isPrimary);

    await purgeExpiredSessions();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await db.insert(adminSessionsTable).values({
      token,
      username: user.username,
      isPrimary: isPrimary ? 1 : 0,
      expiresAt,
      createdAt: new Date(),
    });
    res.cookie(ADMIN_SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: ADMIN_SESSION_COOKIE_SECURE,
      sameSite: ADMIN_SESSION_COOKIE_SAMESITE,
      path: "/api",
      maxAge: TOKEN_TTL_MS,
    });
    const sellerCode = role === "vendedora"
      ? null
      : resolveAdminScopeFromSession({ username: user.username, isPrimary }).sellerCode;
    if (role === "vendedora") {
      void writeAdminAuditFromRequest(req, {
        actorUsername: user.username,
        actorRole: "vendedora",
        action: "login",
        entityType: "admin_user",
        entityId: user.id,
        before: null,
        after: { username: user.username, role },
      });
    }
    res.json({ token, expiresIn: TOKEN_TTL_MS / 1000, isPrimary, username: user.username, sellerCode, role });
  } catch (err) {
    console.error("[AdminAuth] login error:", err, JSON.stringify(err, Object.getOwnPropertyNames(err)));
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao autenticar.", details: String(err) });
  }
});

// --------------------------------------------------------------------------
// POST /api/admin/logout
// --------------------------------------------------------------------------
router.post("/admin/logout", async (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) {
    const sessionRows = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.token, token)).limit(1);
    if (sessionRows[0]) {
      const loaded = await loadUserAccess(sessionRows[0].username);
      if (loaded && isSellerStaffRole(loaded.access.role)) {
        void writeAdminAuditFromRequest(req, {
          actorUsername: loaded.user.username,
          actorRole: "vendedora",
          action: "logout",
          entityType: "admin_user",
          entityId: loaded.user.id,
          before: null,
          after: { username: loaded.user.username },
        });
      }
    }
    await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, token));
  }
  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: ADMIN_SESSION_COOKIE_SECURE,
    sameSite: ADMIN_SESSION_COOKIE_SAMESITE,
    path: "/api",
  });
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// GET /api/admin/verify
// --------------------------------------------------------------------------
router.get("/admin/verify", requireAdminAuth, async (req, res) => {
  try {
    console.log('[admin/verify] INICIO', {
      username: (req as any).adminSession?.username,
      isPrimary: !!(req as any).adminSession?.isPrimary,
      sellerCode: (req as any).adminSession?.sellerCode ?? null,
    });
    const session = (req as any).adminSession;
    res.json({
      ok: true,
      isPrimary: !!session?.isPrimary,
      username: session?.username ?? "",
      role: session?.role === "vendedora" ? "vendedora" : "admin",
    });
    console.log('[admin/verify] SUCESSO', { username: session?.username });
  } catch (err) {
    console.error('[admin/verify] Erro:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Erro interno no endpoint /admin/verify', details: String(err) });
  }
});

// --------------------------------------------------------------------------
// GET /api/admin/users  — list all users (primary admin only)
// --------------------------------------------------------------------------
router.get("/admin/users", requirePrimaryAdmin, async (_req, res) => {
  try {
    const users = await db
      .select({ id: adminUsersTable.id, username: adminUsersTable.username, isPrimary: adminUsersTable.isPrimary, createdAt: adminUsersTable.createdAt })
      .from(adminUsersTable)
      .orderBy(adminUsersTable.createdAt);

    let roleRows: Array<{ userId: string; role: string; active: boolean | number | null }> = [];
    try {
      roleRows = await db
        .select({
          userId: adminUserRolesTable.userId,
          role: adminUserRolesTable.role,
          active: adminUserRolesTable.active,
        })
        .from(adminUserRolesTable);
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
    const byUser = new Map(roleRows.map((row) => [row.userId, row]));

    res.json({
      users: users.map((user) => {
        const extra = byUser.get(user.id);
        const role = extra && isSellerStaffRole(extra.role) ? "vendedora" : "admin";
        const active = extra ? extra.active !== false && extra.active !== 0 : true;
        return { ...user, role, active };
      }),
    });
  } catch (err) {
    console.error("[AdminAuth] list users error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao listar usuários." });
  }
});

// --------------------------------------------------------------------------
// POST /api/admin/users  — create a new user (primary admin only)
// --------------------------------------------------------------------------
router.post("/admin/users", requirePrimaryAdmin, async (req, res) => {
  const { username, password, fullAccess, role } = req.body as {
    username?: string; password?: string; fullAccess?: boolean; role?: string;
  };
  const asSellerStaff = isSellerStaffRole(role);

  if (!username || !password) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Usuário e senha são obrigatórios." });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Senha deve ter pelo menos 6 caracteres." });
    return;
  }

  try {
    const salt = generateAdminSalt();
    const id   = crypto.randomBytes(8).toString("hex");
    const grantPrimary = !asSellerStaff && fullAccess === true;
    const savedUsername = username.trim().toLowerCase();

    await db.insert(adminUsersTable).values({
      id,
      username:     savedUsername,
      passwordHash: createAdminPasswordHash(password, salt),
      salt,
      isPrimary:    grantPrimary,
      createdBy:    String((req as { adminSession?: { username?: string } }).adminSession?.username || "") || null,
    });

    if (asSellerStaff) {
      try {
        await db.insert(adminUserRolesTable).values({
          userId: id,
          role: "vendedora",
          active: true,
          updatedAt: new Date(),
        });
      } catch (err) {
        await db.delete(adminUsersTable).where(eq(adminUsersTable.id, id));
        if (isMissingSchemaError(err)) {
          res.status(503).json({
            error: "MIGRATION_REQUIRED",
            message: "Aplique a migration da vendedora antes de criar esse acesso.",
          });
          return;
        }
        throw err;
      }
      await writeAdminAuditFromRequest(req, {
        actorUsername: String((req as { adminSession?: { username?: string } }).adminSession?.username || "admin"),
        actorRole: "admin",
        action: "seller_staff_create",
        entityType: "admin_user",
        entityId: id,
        before: null,
        after: { username: savedUsername, role: "vendedora", active: true },
      });
    }

    res.status(201).json({
      id,
      username: savedUsername,
      isPrimary: grantPrimary,
      role: asSellerStaff ? "vendedora" : "admin",
      active: true,
    });
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "CONFLICT", message: "Usuário já existe." });
    } else {
      console.error("[AdminAuth] create user error:", err);
      res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao criar usuário." });
    }
  }
});

// --------------------------------------------------------------------------
// PATCH /api/admin/users/:id/access  — toggle full access (primary admin only)
// --------------------------------------------------------------------------
router.patch("/admin/users/:id/access", requirePrimaryAdmin, async (req, res) => {
  const { id } = req.params;
  // Garante que id é string
  const userId = Array.isArray(id) ? id[0] : id;
  const { fullAccess } = req.body as { fullAccess?: boolean };

  if (typeof fullAccess !== "boolean") {
    res.status(400).json({ error: "INVALID_INPUT", message: "fullAccess (boolean) é obrigatório." });
    return;
  }

  try {
    const existing = await db
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.id, userId))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Usuário não encontrado." });
      return;
    }

    const access = await readAdminAccess(existing[0].id);
    if (isSellerStaffRole(access.role) && fullAccess) {
      res.status(400).json({ error: "INVALID_OP", message: "A vendedora não recebe acesso total." });
      return;
    }

    // Prevent removing the last primary admin
    if (!fullAccess && existing[0].isPrimary) {
      const primaryCount = await db
        .select({ id: adminUsersTable.id })
        .from(adminUsersTable)
        .where(eq(adminUsersTable.isPrimary, true));
      if (primaryCount.length <= 1) {
        res.status(400).json({ error: "INVALID_OP", message: "Deve existir pelo menos um administrador com acesso total." });
        return;
      }
    }

    await db
      .update(adminUsersTable)
      .set({ isPrimary: fullAccess })
      .where(eq(adminUsersTable.id, userId));

    res.json({ ok: true, id, isPrimary: fullAccess });
  } catch (err) {
    console.error("[AdminAuth] toggle access error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao alterar acesso." });
  }
});

// --------------------------------------------------------------------------
// PATCH /api/admin/users/:id/password  — change own password (primary admin) or any user (super)
// --------------------------------------------------------------------------
router.patch("/admin/users/:id/password", requireAdminAuth, forbidSellerStaff, async (req, res) => {
  const { id }       = req.params;
  const userId = Array.isArray(id) ? id[0] : id;
  const { password } = req.body as { password?: string };
  const session      = await getSessionInfo(req);

  if (!password || password.length < 6) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Senha deve ter pelo menos 6 caracteres." });
    return;
  }

  if (!session) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Acesso não autorizado." });
    return;
  }

  try {
    const existing = await db
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.id, userId))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Usuário não encontrado." });
      return;
    }

    const targetUsername = String(existing[0].username || "").trim().toLowerCase();
    const actorUsername = String(session.username || "").trim().toLowerCase();

    // Allow password change if actor is primary admin or is changing their own account.
    if (!session.isPrimary && targetUsername !== actorUsername) {
      res.status(403).json({ error: "FORBIDDEN", message: "Sem permissão para alterar esta senha." });
      return;
    }

    const salt = generateAdminSalt();
    await db
      .update(adminUsersTable)
      .set({ passwordHash: createAdminPasswordHash(password, salt), salt })
      .where(eq(adminUsersTable.id, userId));

    const access = await readAdminAccess(existing[0].id);
    if (isSellerStaffRole(access.role)) {
      await db.delete(adminSessionsTable).where(eq(adminSessionsTable.username, existing[0].username));
      await writeAdminAuditFromRequest(req, {
        actorUsername: actorUsername,
        actorRole: "admin",
        action: "seller_staff_password",
        entityType: "admin_user",
        entityId: userId,
        before: null,
        after: { passwordChanged: true },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[AdminAuth] change password error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao alterar senha." });
  }
});

// --------------------------------------------------------------------------
// PATCH /api/admin/users/:id/active  — desativa a vendedora (primary admin only)
// --------------------------------------------------------------------------
router.patch("/admin/users/:id/active", requirePrimaryAdmin, async (req, res) => {
  const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { active } = req.body as { active?: boolean };
  if (typeof active !== "boolean") {
    res.status(400).json({ error: "INVALID_INPUT", message: "active (boolean) é obrigatório." });
    return;
  }

  try {
    const existing = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, userId)).limit(1);
    if (!existing[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Usuário não encontrado." });
      return;
    }
    const access = await readAdminAccess(existing[0].id);
    if (!access.schemaReady) {
      res.status(503).json({
        error: "MIGRATION_REQUIRED",
        message: "Aplique a migration da vendedora antes de desativar.",
      });
      return;
    }
    if (!isSellerStaffRole(access.role)) {
      res.status(400).json({ error: "INVALID_OP", message: "Desativar por aqui vale para a vendedora." });
      return;
    }

    await db.update(adminUserRolesTable)
      .set({ active, updatedAt: new Date() })
      .where(eq(adminUserRolesTable.userId, userId));
    if (!active) {
      await db.delete(adminSessionsTable).where(eq(adminSessionsTable.username, existing[0].username));
    }
    await writeAdminAuditFromRequest(req, {
      actorUsername: String((req as { adminSession?: { username?: string } }).adminSession?.username || "admin"),
      actorRole: "admin",
      action: active ? "seller_staff_activate" : "seller_staff_deactivate",
      entityType: "admin_user",
      entityId: userId,
      before: { active: access.active, username: existing[0].username },
      after: { active, username: existing[0].username },
    });
    res.json({ ok: true, id: userId, active });
  } catch (err) {
    console.error("[AdminAuth] active error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao alterar a conta." });
  }
});

// --------------------------------------------------------------------------
// DELETE /api/admin/users/:id  — delete non-primary user (primary admin only)
// --------------------------------------------------------------------------
router.delete("/admin/users/:id", requirePrimaryAdmin, async (req, res) => {
  const { id } = req.params;
  const userId = Array.isArray(id) ? id[0] : id;

  try {
    const existing = await db
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.id, userId))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Usuário não encontrado." });
      return;
    }

    if (existing[0].isPrimary) {
      res.status(400).json({ error: "INVALID_OP", message: "Não é possível remover o administrador principal." });
      return;
    }

    try {
      await db.delete(adminUserRolesTable).where(eq(adminUserRolesTable.userId, userId));
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
    await db.delete(adminSessionsTable).where(eq(adminSessionsTable.username, existing[0].username));
    await db.delete(adminUsersTable).where(eq(adminUsersTable.id, userId));
    res.json({ ok: true });
  } catch (err) {
    console.error("[AdminAuth] delete user error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao remover usuário." });
  }
});

export default router;
