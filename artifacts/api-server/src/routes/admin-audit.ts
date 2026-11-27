import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { adminAuditLogTable, db } from "@workspace/db";
import { getAdminScope, requirePrimaryAdmin } from "./admin-auth";
import { isMissingSchemaError } from "../lib/admin-user-access";

const router: IRouter = Router();

/** Só leitura. Não existe rota de editar ou apagar o log. */
router.get("/admin/audit-log", requirePrimaryAdmin, async (req, res) => {
  try {
    getAdminScope(req);
    const requested = Number(req.query.limit || 100);
    const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 100;
    const rows = await db
      .select()
      .from(adminAuditLogTable)
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(limit);
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        actorUsername: row.actorUsername,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.beforeJson,
        after: row.afterJson,
        ip: row.ip,
      })),
    });
  } catch (err) {
    if (isMissingSchemaError(err)) {
      res.status(503).json({
        error: "MIGRATION_REQUIRED",
        message: "Falta aplicar a migration da auditoria.",
      });
      return;
    }
    console.error("[audit] list error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao ler a auditoria." });
  }
});

export default router;
