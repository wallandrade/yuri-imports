import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const CHANNELS = [
  ["zapi_channel_order_paid", "Pedido pago"],
  ["zapi_channel_tracking", "Rastreio"],
  ["zapi_channel_posted", "Postado"],
  ["zapi_channel_out_for_delivery", "Saiu para entrega"],
  ["zapi_channel_delivered", "Entregue"],
  ["zapi_channel_filmagem", "Filmagem"],
  ["zapi_channel_delivery_correction", "Correção de entrega"],
  ["zapi_channel_support", "Atendimento"],
  ["zapi_channel_support_menu", "Menu do atendimento"],
  ["zapi_channel_cell_tech", "Cell Tech"],
  ["zapi_channel_shopee_route", "Rota Shopee"],
] as const;

type QueueRow = {
  id: string;
  instance: string;
  origin: string;
  kind: string;
  status: string;
  attempts: number;
  phoneMask: string;
  preview: string;
  lastError: string;
  createdAt: string | null;
};

type QueueView = {
  counts: { pending: number; sending: number; sent: number; failed: number };
  rows: QueueRow[];
};

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem("adminToken") || localStorage.getItem("adminToken") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function channelValue(settings: Record<string, string>, key: string): "direto" | "n8n" {
  return settings[key] === "n8n" ? "n8n" : "direto";
}

function statusLabel(status: string): string {
  if (status === "pending") return "pendente";
  if (status === "sending") return "enviando";
  if (status === "sent") return "enviado";
  if (status === "failed") return "erro";
  return status;
}

export default function WhatsappDispatchCard({
  settings,
  loading,
  onSave,
}: {
  settings: Record<string, string>;
  loading: Record<string, boolean>;
  onSave: (_key: string, _value: string) => void;
}) {
  const delivery = settings.zapi_support_delivery === "na_hora" ? "na_hora" : "fila";
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [queueError, setQueueError] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`${BASE}/api/admin/whatsapp/outbound-queue`, { headers: authHeaders(), credentials: "include" });
    if (!res.ok) {
      setQueueError("Não consegui ler a fila.");
      return;
    }
    setQueueError("");
    setQueue(await res.json() as QueueView);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setQueueError("Não consegui ler a fila."));
  }, [refresh]);

  return (
    <div className="space-y-4 border border-border rounded-xl p-4">
      <div>
        <h3 className="font-semibold">Como enviar</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Direto manda pela Z-API. Pedido pago espera no máximo 2 minutos. Os outros avisos esperam 6 minutos, no máximo 10 por hora em cada número. n8n usa a URL salva abaixo, para voltar atrás sem deploy.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {CHANNELS.map(([key, label]) => (
          <label key={key} className="block text-xs">
            <span className="font-medium">{label}</span>
            <select
              value={channelValue(settings, key)}
              disabled={!!loading[key]}
              onChange={(event) => onSave(key, event.target.value)}
              className="mt-1 w-full h-10 px-3 rounded-xl border-2 border-border bg-background text-sm"
            >
              <option value="direto">direto</option>
              <option value="n8n">n8n</option>
            </select>
          </label>
        ))}
      </div>
      <label className="block text-xs">
        <span className="font-medium">Respostas do atendimento</span>
        <select
          value={delivery}
          disabled={!!loading.zapi_support_delivery}
          onChange={(event) => onSave("zapi_support_delivery", event.target.value)}
          className="mt-1 w-full h-10 px-3 rounded-xl border-2 border-border bg-background text-sm"
        >
          <option value="fila">fila</option>
          <option value="na_hora">na hora</option>
        </select>
        <span className="mt-1 block text-muted-foreground">
          Fila é o padrão: a resposta espera a mesma fila dos avisos. Na hora, quem mandou mensagem recebe na hora e só o aviso de pedido fica na fila.
        </span>
      </label>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-sm">Fila</h3>
          <button type="button" onClick={() => void refresh()} className="text-xs underline">
            Atualizar
          </button>
        </div>
        {queue ? (
          <p className="text-xs text-muted-foreground">
            Pendentes {queue.counts.pending + queue.counts.sending} · Enviados {queue.counts.sent} · Erros {queue.counts.failed}
          </p>
        ) : null}
        {queueError ? <p className="text-xs text-destructive">{queueError}</p> : null}
        <div className="max-h-64 overflow-auto border border-border rounded-xl">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium">Quando</th>
                <th className="px-2 py-1.5 font-medium">Aviso</th>
                <th className="px-2 py-1.5 font-medium">Número</th>
                <th className="px-2 py-1.5 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {(queue?.rows || []).map((row) => (
                <tr key={row.id} className="border-t border-border/70 align-top">
                  <td className="px-2 py-1.5 whitespace-nowrap">{row.createdAt ? new Date(row.createdAt).toLocaleString("pt-BR") : ""}</td>
                  <td className="px-2 py-1.5">
                    <div>{row.origin} · {row.instance}</div>
                    <div className="text-muted-foreground">{row.preview}</div>
                    {row.lastError ? <div className="text-destructive">{row.lastError}</div> : null}
                  </td>
                  <td className="px-2 py-1.5">{row.phoneMask}</td>
                  <td className="px-2 py-1.5">{statusLabel(row.status)}{row.attempts ? ` · ${row.attempts}` : ""}</td>
                </tr>
              ))}
              {queue && queue.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-2 py-3 text-muted-foreground">Nenhuma mensagem na fila.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {!queue && !queueError ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      </div>
    </div>
  );
}
