import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { measureOrderItemStock } from "@/lib/order-stock-check";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem("adminToken") || localStorage.getItem("adminToken") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

type Lane = "motoboy" | "sao_paulo" | "minas" | "santa_catarina";

type QueueItem = { id: string; name: string; quantity: number };

type QueueRow = {
  lane: Lane;
  orderId: string;
  orderNumber: number | null;
  clientName: string;
  packageId: string | null;
  statusLabel: string;
  code: string;
  items: QueueItem[];
};

type Balance = { productId: string; productName: string; quantity: number };

const LANES: Array<{ id: Lane; label: string }> = [
  { id: "motoboy", label: "Motoboy" },
  { id: "sao_paulo", label: "São Paulo" },
  { id: "minas", label: "Minas" },
  { id: "santa_catarina", label: "Santa Catarina" },
];

function rowKey(row: QueueRow): string {
  return `${row.orderId}:${row.packageId || "pedido"}`;
}

export function LabelDebitQueuePanel({
  products,
  motoboyBalances,
  minasBalances,
  santaCatarinaBalances,
  onRefresh,
}: {
  products: Array<{ id: string; name: string }>;
  motoboyBalances: Balance[];
  minasBalances: Balance[];
  santaCatarinaBalances: Balance[];
  onRefresh: () => void;
}) {
  const [lane, setLane] = useState<Lane>("motoboy");
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const catalogNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const product of products) {
      if (product.id && product.name) map[product.id] = product.name;
    }
    return map;
  }, [products]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/admin/inventory/label-debits`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({})) as { rows?: QueueRow[]; message?: string };
      if (!res.ok) throw new Error(data.message || "Erro ao carregar a fila.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao carregar a fila.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = rows.filter((row) => row.lane === lane);
  const balances = lane === "minas"
    ? minasBalances
    : lane === "santa_catarina"
      ? santaCatarinaBalances
      : motoboyBalances;

  const act = async (row: QueueRow, mode: "debit" | "waive") => {
    const key = rowKey(row);
    setBusyKey(key);
    try {
      const res = await fetch(`${BASE}/api/admin/inventory/label-debits`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          orderId: row.orderId,
          packageId: row.packageId,
          lane: row.lane,
          mode,
          ...(password.trim() ? { password: password.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { message?: string; passwordRequired?: boolean };
      if (!res.ok) throw new Error(data.message || "Não foi possível registrar a baixa.");
      toast.success(mode === "debit" ? "Baixa feita e estoque abatido." : "Etiqueta saiu da fila sem abater o estoque.");
      setRows((prev) => prev.filter((item) => rowKey(item) !== key));
      if (mode === "debit") onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível registrar a baixa.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold">Baixa de etiqueta</p>
        <p className="text-xs text-muted-foreground mt-1">
          Etiquetas que ainda não baixaram estoque. São Paulo usa o saldo Motoboy. Santa Catarina usa o próprio saldo. Sem saldo, a baixa que abate fica bloqueada.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {LANES.map((item) => {
          const count = rows.filter((row) => row.lane === item.id).length;
          const selected = lane === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setLane(item.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${selected
                ? "bg-slate-800 text-white border-slate-800"
                : "bg-white text-muted-foreground border-border"}`}
            >
              {item.label} {count > 0 ? `(${count})` : ""}
            </button>
          );
        })}
      </div>
      <input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Senha de baixa"
        className="h-9 w-full max-w-xs px-3 rounded-lg border border-border text-sm outline-none focus:border-emerald-600"
      />
      {loading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando etiquetas...
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma etiqueta sem baixa nesta aba.</p>
      ) : (
        <div className="space-y-2">
          {visible.map((row) => {
            const lines = measureOrderItemStock({
              items: row.items,
              balances,
              catalogNames,
            });
            const canDebit = lines.length > 0 && lines.every((line) => line.available >= line.needed);
            const key = rowKey(row);
            const busy = busyKey === key;
            return (
              <div key={key} className="rounded-xl border border-border px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      Pedido #{row.orderNumber || row.orderId} · {row.clientName}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {row.statusLabel}{row.code ? ` · ${row.code}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !canDebit}
                      title={canDebit ? "Desconta o saldo deste depósito" : "Sem saldo suficiente neste depósito"}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => { void act(row, "debit"); }}
                    >
                      {busy ? "..." : "Baixa abatendo estoque"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => { void act(row, "waive"); }}
                    >
                      Baixa sem abater estoque
                    </Button>
                  </div>
                </div>
                <div className="mt-2 space-y-0.5">
                  {lines.length === 0 ? (
                    <p className="text-xs text-slate-500">Sem produto nesta etiqueta</p>
                  ) : lines.map((line) => {
                    const short = line.available < line.needed;
                    const text = line.available <= 0
                      ? `${line.label}: sem estoque`
                      : short
                        ? `${line.label}: tem ${line.available}, precisa ${line.needed}`
                        : `${line.label}: ${line.available} em estoque`;
                    return (
                      <p key={`${key}-${line.label}`} className={`text-xs ${short ? "text-red-700" : "text-emerald-800"}`}>
                        {text}
                      </p>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
