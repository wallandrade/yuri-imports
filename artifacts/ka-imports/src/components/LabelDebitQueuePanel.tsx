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
  source?: "yury" | "ka";
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
  return `${row.source || "yury"}:${row.orderId}:${row.packageId || "pedido"}`;
}

function foldSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function productPhoto(products: Array<{ id: string; name: string; image?: string | null }>, productId: string, label: string): string {
  const id = productId.trim().toLowerCase();
  if (id) {
    const byId = products.find((product) => product.id.trim().toLowerCase() === id);
    const src = String(byId?.image || "").trim();
    if (src) return src;
  }
  const name = foldSearch(label);
  if (!name) return "";
  const named = products.filter((product) => foldSearch(product.name) === name && String(product.image || "").trim());
  return named.length === 1 ? String(named[0]?.image || "").trim() : "";
}

function rowMatchesSearch(row: QueueRow, query: string): boolean {
  const needle = foldSearch(query);
  if (!needle) return true;
  const number = String(row.orderNumber ?? "");
  const name = foldSearch(row.clientName || "");
  return number.includes(needle.replace(/^#/, "")) || name.includes(needle);
}

export function LabelDebitQueuePanel({
  products,
  motoboyBalances,
  minasBalances,
  santaCatarinaBalances,
  onRefresh,
}: {
  products: Array<{ id: string; name: string; image?: string | null }>;
  motoboyBalances: Balance[];
  minasBalances: Balance[];
  santaCatarinaBalances: Balance[];
  onRefresh: () => void;
}) {
  const [lane, setLane] = useState<Lane>("motoboy");
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
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

  const visible = rows.filter((row) => row.lane === lane && rowMatchesSearch(row, query));
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
          ...(row.source === "ka" ? { source: "ka" } : {}),
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
          Etiquetas que ainda não baixaram estoque. São Paulo usa o saldo Motoboy. Santa Catarina usa o próprio saldo. Sem saldo, a baixa que abate fica bloqueada. Etiqueta da KA entra na mesma aba e não vira pedido aqui.
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
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Número do pedido ou nome do cliente"
          className="h-9 w-full max-w-sm px-3 rounded-lg border border-border text-sm outline-none focus:border-emerald-600"
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Senha de baixa"
          className="h-9 w-full max-w-xs px-3 rounded-lg border border-border text-sm outline-none focus:border-emerald-600"
        />
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando etiquetas...
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query.trim() ? "Nenhuma etiqueta encontrada para essa busca." : "Nenhuma etiqueta sem baixa nesta aba."}
        </p>
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
                      {row.source === "ka" ? "KA · " : ""}Pedido #{row.orderNumber || row.orderId} · {row.clientName}
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
                <div className="mt-2 space-y-1.5">
                  {lines.length === 0 ? (
                    <p className="text-xs text-slate-500">Sem produto nesta etiqueta</p>
                  ) : lines.map((line) => {
                    const short = line.available < line.needed;
                    const text = line.available <= 0
                      ? "sem estoque"
                      : short
                        ? `tem ${line.available}, precisa ${line.needed}`
                        : `${line.available} em estoque`;
                    const photo = productPhoto(products, line.productId, line.label);
                    return (
                      <div key={`${key}-${line.productId || line.label}`} className="flex items-center gap-2">
                        <button
                          type="button"
                          className={`h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-border bg-white ${photo ? "cursor-zoom-in" : "cursor-default"}`}
                          onClick={() => { if (photo) setPreview({ src: photo, name: line.label }); }}
                          aria-label={photo ? `Ver foto de ${line.label}` : line.label}
                        >
                          {photo ? (
                            <img src={photo} alt="" className="h-full w-full object-cover" loading="lazy" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-[9px] text-slate-400">foto</span>
                          )}
                        </button>
                        <p className={`min-w-0 text-xs ${short ? "text-red-700" : "text-emerald-800"}`}>
                          <span className="font-medium">{line.label}</span>
                          {": "}
                          {text}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {preview ? (
        <button
          type="button"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreview(null)}
          aria-label="Fechar foto"
        >
          <img src={preview.src} alt={preview.name} className="max-h-[80vh] max-w-full rounded-xl bg-white object-contain" />
        </button>
      ) : null}
    </div>
  );
}
