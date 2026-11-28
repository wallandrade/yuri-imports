import crypto from "crypto";
import type { Request } from "express";
import { adminAuditLogTable, db } from "@workspace/db";
import { clientIpFromRequest, redactAuditPayload } from "./admin-audit-payload";
import { isMissingSchemaError } from "./admin-user-access";

export type AuditWriteInput = {
  actorUsername: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

export async function writeAdminAudit(entry: AuditWriteInput): Promise<"ok" | "missing" | "error"> {
  try {
    await db.insert(adminAuditLogTable).values({
      id: crypto.randomBytes(16).toString("hex"),
      createdAt: new Date(),
      actorUsername: String(entry.actorUsername || "").slice(0, 255) || "desconhecido",
      actorRole: String(entry.actorRole || "admin").slice(0, 32),
      action: String(entry.action || "acao").slice(0, 64),
      entityType: String(entry.entityType || "entidade").slice(0, 64),
      entityId: entry.entityId ? String(entry.entityId).slice(0, 255) : null,
      beforeJson: redactAuditPayload(entry.before ?? null),
      afterJson: redactAuditPayload(entry.after ?? null),
      ip: entry.ip ? String(entry.ip).slice(0, 64) : null,
    });
    return "ok";
  } catch (err) {
    if (isMissingSchemaError(err)) return "missing";
    const code = String((err as { code?: string })?.code || "unknown");
    console.error("[audit] falha ao gravar", code);
    return "error";
  }
}

export async function writeAdminAuditFromRequest(
  req: Request,
  entry: Omit<AuditWriteInput, "ip"> & { ip?: string | null },
): Promise<"ok" | "missing" | "error"> {
  return writeAdminAudit({
    ...entry,
    ip: entry.ip ?? clientIpFromRequest(req),
  });
}
