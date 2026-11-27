import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { BadgeCheck, CheckCircle, Loader2, Package, Search } from "lucide-react";
import { toast } from "sonner";
import { sendCardProductImage, type SendCardCatalogProduct } from "@/lib/send-card-list";
import { shouldRefreshPreconfirmQueue } from "@/lib/preconfirm-queue";
import { formatCurrency } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type PreconfirmQueueProduct = {
  id?: string | null;
  name?: string | null;
  image?: string | null;
};

export type PreconfirmQueueItem = {
  id: string;
  orderId: string;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  orderNumber?: number | string | null;
  clientName?: string | null;
  total?: string | number | null;
  orderCreatedAt?: string | null;
  products?: PreconfirmQueueProduct[] | null;
};

type PhotoHover = { src: string; name: string; top: number; left: number };

function formatDateBR(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatWhen(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const day = date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const time = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
  return `${day} ${time}`;
}

function orderLabel(item: PreconfirmQueueItem): string {
  if (item.orderNumber != null && String(item.orderNumber).trim()) return String(item.orderNumber);
  return String(item.orderId || "—");
}

function QueuePhotoThumb({
  src,
  name,
  style,
  onOpen,
  onHover,
  onHoverEnd,
}: {
  src: string | null;
  name: string;
  style?: CSSProperties;
  onOpen?: (src: string, name: string) => void;
  onHover?: (hover: PhotoHover) => void;
  onHoverEnd?: () => void;
}) {
  return (
    <button
      type="button"
      title={src ? "Ampliar foto" : undefined}
      className={`relative h-8 w-8 shrink-0 bg-transparent p-0 ${src ? "cursor-zoom-in" : ""}`}
      style={style}
      onMouseEnter={(event) => {
        if (!src || !onHover) return;
        const rect = event.currentTarget.getBoundingClientRect();
        onHover({
          src,
          name,
          top: rect.top + rect.height / 2,
          left: rect.right + 10,
        });
      }}
      onMouseLeave={() => onHoverEnd?.()}
      onClick={(event) => {
        if (!src || !onOpen) return;
        event.preventDefault();
        event.stopPropagation();
        onHoverEnd?.();
        onOpen(src, name);
      }}
    >
      <span className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-200">
        {src ? (
          <img src={src} alt={name} className="h-full w-full object-cover" />
        ) : (
          <Package className="h-3.5 w-3.5 text-gray-500" />
        )}
      </span>
      {src ? (
        <span className="pointer-events-none absolute -bottom-1 -right-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-violet-300 bg-white shadow-sm">
          <Search className="h-2 w-2 text-violet-800" />
        </span>
      ) : null}
    </button>
  );
}

export function PreconfirmQueueCardView({
  items,
  catalog,
  loading,
  error,
  isBusy,
  onOpenList,
  onOpenOrder,
  onApprove,
  onReject,
  onPhotoOpen,
  onPhotoHover,
  onPhotoHoverEnd,
}: {
  items: PreconfirmQueueItem[];
  catalog: SendCardCatalogProduct[];
  loading: boolean;
  error: string;
  isBusy: (orderId: string) => boolean;
  onOpenList: () => void;
  onOpenOrder: (item: PreconfirmQueueItem) => void;
  onApprove: (item: PreconfirmQueueItem) => void;
  onReject: (item: PreconfirmQueueItem) => void;
  onPhotoOpen: (src: string, name: string) => void;
  onPhotoHover: (hover: PhotoHover) => void;
  onPhotoHoverEnd: () => void;
}) {
  return (
    <div
      data-preconfirm-card
      className="rounded-xl border p-4 cursor-pointer transition bg-violet-50 border-violet-300 hover:bg-violet-100"
      onClick={onOpenList}
      title="Ver pré-confirmações"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5 text-violet-700">
          <BadgeCheck className="w-4 h-4" /> Pré-confirmados
        </p>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-violet-200 text-violet-800">
          {loading && items.length === 0 ? "…" : items.length}
        </span>
      </div>
      {error && items.length === 0 ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : loading && items.length === 0 ? (
        <p className="text-sm text-violet-700/80 flex items-center gap-1.5">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm flex items-center gap-1.5 text-violet-700/80">
          <CheckCircle className="w-4 h-4 text-green-500" /> Nenhuma pré-confirmação pendente.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-[320px] overflow-y-auto" onScroll={onPhotoHoverEnd}>
          {error ? <p className="text-xs text-red-700">{error}</p> : null}
          {items.map((item) => {
            const products = Array.isArray(item.products) ? item.products : [];
            const shown = (products.length > 0 ? products : [{ id: "", name: "Produto", image: null }]).slice(0, 4);
            const extra = products.length - shown.length;
            const busy = isBusy(item.orderId);
            return (
              <div
                key={item.id}
                title="Abrir este pedido"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenOrder(item);
                }}
                className="flex flex-col gap-1.5 rounded-lg px-3 py-1.5 border cursor-pointer hover:brightness-[0.98] bg-white border-violet-200"
              >
                <div className="flex items-center gap-2">
                  <div className="flex items-center shrink-0">
                    {shown.map((product, index) => {
                      const name = String(product.name || "Produto");
                      const src = products.length > 0 ? sendCardProductImage(product, catalog) : null;
                      return (
                        <QueuePhotoThumb
                          key={`${product.id || "vazio"}-${index}`}
                          src={src}
                          name={name}
                          style={{ marginLeft: index === 0 ? 0 : -8, zIndex: shown.length - index }}
                          onOpen={onPhotoOpen}
                          onHover={onPhotoHover}
                          onHoverEnd={onPhotoHoverEnd}
                        />
                      );
                    })}
                    {extra > 0 ? <span className="ml-1 text-[10px] font-bold text-violet-800">+{extra}</span> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate text-violet-950">{item.clientName || "Cliente"}</p>
                    <p className="text-xs text-violet-700/80">#{orderLabel(item)} · {formatDateBR(item.orderCreatedAt) || "—"}</p>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap text-violet-800 bg-violet-100">
                    {formatCurrency(item.total)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 text-[11px] leading-4 text-violet-700/80">
                    Pré-confirmou {item.confirmedBy || "—"} · {formatWhen(item.confirmedAt)}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onApprove(item);
                      }}
                      className="h-7 px-2 rounded-full border border-emerald-600 bg-emerald-600 text-white text-[10px] font-bold hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {busy ? "..." : "Aprovar"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onReject(item);
                      }}
                      className="h-7 px-2 rounded-full border border-red-600 bg-red-600 text-white text-[10px] font-bold hover:bg-red-700 disabled:opacity-60"
                    >
                      {busy ? "..." : "Recusar"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AdminPreconfirmQueueCard({
  headers,
  onUnauthorized,
  catalog,
  reloadToken,
  onReviewed,
  onOpenList,
  onOpenOrder,
  onPhotoOpen,
  onPhotoHover,
  onPhotoHoverEnd,
}: {
  headers: () => Record<string, string>;
  onUnauthorized: () => void;
  catalog: SendCardCatalogProduct[];
  reloadToken: number;
  onReviewed: () => void;
  onOpenList: () => void;
  onOpenOrder: (item: PreconfirmQueueItem) => void;
  onPhotoOpen: (src: string, name: string) => void;
  onPhotoHover: (hover: PhotoHover) => void;
  onPhotoHoverEnd: () => void;
}) {
  const [items, setItems] = useState<PreconfirmQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`${BASE}/api/admin/orders/payment-preconfirms?status=pending_admin`, { headers: headers() });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const data = await res.json() as { items?: PreconfirmQueueItem[]; message?: string };
      if (!res.ok) {
        setError(data.message || "Não foi possível carregar as pré-confirmações.");
        return;
      }
      setItems(data.items || []);
    } catch {
      setError("Não foi possível carregar as pré-confirmações.");
    } finally {
      setLoading(false);
    }
  }, [headers, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const review = async (item: PreconfirmQueueItem, decision: "approve" | "reject") => {
    if (decision === "reject") {
      const label = orderLabel(item);
      const ok = window.confirm(`Recusar a pré-confirmação do pedido #${label}?`);
      if (!ok) return;
    }
    setBusyIds((current) => {
      const next = new Set(current);
      next.add(item.orderId);
      return next;
    });
    try {
      const res = await fetch(`${BASE}/api/admin/orders/${item.orderId}/payment-preconfirm/${decision}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ note: "" }),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const data = await res.json().catch(() => ({})) as { message?: string };
      const fallback = res.ok
        ? (decision === "approve" ? "Pagamento confirmado." : "Pré-confirmação recusada.")
        : (decision === "approve" ? "Não foi possível aprovar." : "Não foi possível recusar.");
      const message = data.message || fallback;
      if (res.ok) toast.success(message);
      else toast.error(message);
      if (shouldRefreshPreconfirmQueue(res.status)) onReviewed();
    } catch {
      toast.error(decision === "approve" ? "Não foi possível aprovar." : "Não foi possível recusar.");
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(item.orderId);
        return next;
      });
    }
  };

  return (
    <PreconfirmQueueCardView
      items={items}
      catalog={catalog}
      loading={loading}
      error={error}
      isBusy={(orderId) => busyIds.has(orderId)}
      onOpenList={onOpenList}
      onOpenOrder={onOpenOrder}
      onApprove={(item) => { void review(item, "approve"); }}
      onReject={(item) => { void review(item, "reject"); }}
      onPhotoOpen={onPhotoOpen}
      onPhotoHover={onPhotoHover}
      onPhotoHoverEnd={onPhotoHoverEnd}
    />
  );
}
