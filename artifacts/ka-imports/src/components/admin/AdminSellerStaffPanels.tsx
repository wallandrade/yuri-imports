import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type PreconfirmItem = {
  id: string;
  orderId: string;
  status: string;
  confirmedBy: string;
  confirmedAt?: string;
  note?: string | null;
  hasProof?: boolean;
  proofUrl?: string | null;
  reviewNote?: string | null;
  orderNumber?: number | null;
  clientName?: string | null;
  total?: string | null;
  orderStatus?: string | null;
};

type AuditItem = {
  id: string;
  createdAt?: string;
  actorUsername: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

function formatWhen(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function jsonPreview(value: unknown) {
  if (value == null) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

export function AdminPreconfirmPanel({
  headers,
  onUnauthorized,
}: {
  headers: () => Record<string, string>;
  onUnauthorized: () => void;
}) {
  const [items, setItems] = useState<PreconfirmItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/api/admin/orders/payment-preconfirms?status=pending_admin`, { headers: headers() });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const data = await res.json() as { items?: PreconfirmItem[]; message?: string };
      if (!res.ok) {
        setError(data.message || "Não foi possível carregar a fila.");
        setItems([]);
        return;
      }
      setItems(data.items || []);
    } catch {
      setError("Não foi possível carregar a fila.");
    } finally {
      setLoading(false);
    }
  }, [headers, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (orderId: string, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Motivo da rejeição (opcional)") : "";
    if (note === null) return;
    setBusy(orderId);
    try {
      const res = await fetch(`${BASE}/api/admin/orders/${orderId}/payment-preconfirm/${decision}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ note }),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const data = await res.json() as { message?: string };
      if (!res.ok) {
        const message = data.message || "Não foi possível revisar.";
        if (res.status === 409 || res.status === 404) await load();
        setError(message);
        return;
      }
      await load();
    } catch {
      setError("Não foi possível revisar.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h2 className="text-lg font-bold">Pré-confirmações da vendedora</h2>
        <p className="text-sm text-muted-foreground">O pagamento só fica confirmado quando você aprovar. Rejeitar não marca o pedido como pago.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Carregando</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma pré-confirmação pendente.</p>
      ) : items.map((item) => (
        <article key={item.id} className="rounded-2xl border border-border bg-white p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Pedido #{item.orderNumber || item.orderId} · {item.clientName || "Cliente"}</p>
            <p className="text-sm text-muted-foreground">{formatWhen(item.confirmedAt)}</p>
          </div>
          <p className="text-sm">Vendedora: {item.confirmedBy} · status do pedido: {item.orderStatus || "—"} · total {item.total || "—"}</p>
          {item.note && <p className="text-sm">Observação: {item.note}</p>}
          {item.proofUrl && (
            item.proofUrl.startsWith("data:image")
              ? <img src={item.proofUrl} alt="Comprovante" className="max-h-40 rounded-lg border" />
              : <a className="text-sm text-primary underline" href={item.proofUrl} target="_blank" rel="noreferrer">Abrir comprovante</a>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy === item.orderId} onClick={() => void review(item.orderId, "approve")}>
              Aprovar
            </Button>
            <Button size="sm" variant="outline" disabled={busy === item.orderId} onClick={() => void review(item.orderId, "reject")}>
              Rejeitar
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function AdminAuditLogPanel({
  headers,
  onUnauthorized,
}: {
  headers: () => Record<string, string>;
  onUnauthorized: () => void;
}) {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/api/admin/audit-log?limit=100`, { headers: headers() });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const data = await res.json() as { items?: AuditItem[]; message?: string };
      if (!res.ok) {
        setError(data.message || "Não foi possível carregar o log.");
        setItems([]);
        return;
      }
      setItems(data.items || []);
    } catch {
      setError("Não foi possível carregar o log.");
    } finally {
      setLoading(false);
    }
  }, [headers, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">Auditoria</h2>
        <p className="text-sm text-muted-foreground">Registro só de inclusão. Não há edição nem exclusão.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Carregando</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="p-3">Quando</th>
                <th className="p-3">Quem</th>
                <th className="p-3">Ação</th>
                <th className="p-3">Entidade</th>
                <th className="p-3">IP</th>
                <th className="p-3">Antes</th>
                <th className="p-3">Depois</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td className="p-3 text-muted-foreground" colSpan={7}>Nenhum registro.</td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <td className="p-3 whitespace-nowrap">{formatWhen(item.createdAt)}</td>
                  <td className="p-3">{item.actorUsername}<div className="text-xs text-muted-foreground">{item.actorRole}</div></td>
                  <td className="p-3">{item.action}</td>
                  <td className="p-3">{item.entityType}{item.entityId ? ` · ${item.entityId}` : ""}</td>
                  <td className="p-3">{item.ip || "—"}</td>
                  <td className="p-3 max-w-[220px] break-all text-xs">{jsonPreview(item.before)}</td>
                  <td className="p-3 max-w-[220px] break-all text-xs">{jsonPreview(item.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
