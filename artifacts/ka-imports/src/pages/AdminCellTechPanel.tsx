import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { pathForTab } from "@/pages/admin/adminNav";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem("adminToken") || localStorage.getItem("adminToken") || "";
  if (!token) return { "Content-Type": "application/json" };
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type Settings = {
  accessConfigured?: boolean;
  secretConfigured?: boolean;
  alertsEnabled?: boolean;
};

type OrderCard = {
  id: string;
  code: string;
  clientName: string;
  technicianName: string;
  situationName: string;
  services: string[];
  equipment: string;
  deadlineLabel: string;
  finished: boolean;
  working: boolean;
  tone: "green" | "yellow" | "red" | "gray";
  statusLabel: string;
};

type Technician = { id: string; name: string };

type Board = {
  orders: OrderCard[];
  counts: { open: number; overdue: number; dueToday: number; noDeadline: number; working: number; done: number };
  technicians: Technician[];
  fetchedAt?: string;
};

const TONE_CLASS: Record<OrderCard["tone"], string> = {
  green: "border-emerald-300 bg-emerald-50",
  yellow: "border-amber-300 bg-amber-50",
  red: "border-red-300 bg-red-50",
  gray: "border-slate-300 bg-slate-50",
};

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string };
    return data.message || "Não foi possível concluir.";
  } catch {
    return "Não foi possível concluir.";
  }
}

export default function AdminCellTechPanel() {
  const [, setLocation] = useLocation();
  const [tokensReady, setTokensReady] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [board, setBoard] = useState<Board | null>(null);
  const [technicianId, setTechnicianId] = useState("");
  const [client, setClient] = useState("");
  const [service, setService] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [scope, setScope] = useState<"open" | "done" | "all">("open");
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");

  const loadSettings = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/settings`, { headers: authHeaders() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = await res.json() as Settings;
      setTokensReady(Boolean(data.accessConfigured && data.secretConfigured));
      setAlertsEnabled(data.alertsEnabled !== false);
    } catch {
      toast.error("Erro ao carregar a Cell Tech.");
    } finally {
      setLoadingSettings(false);
    }
  }, []);

  const loadBoard = useCallback(async (fresh = false) => {
    setLoadingBoard(true);
    try {
      const params = new URLSearchParams();
      if (technicianId) params.set("technicianId", technicianId);
      if (client.trim()) params.set("client", client.trim());
      if (service.trim()) params.set("service", service.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      params.set("scope", scope);
      if (fresh) params.set("fresh", "1");
      const res = await fetch(`${BASE}/api/admin/cell-tech/board?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) {
        const message = await readError(res);
        if (res.status !== 400) toast.error(message);
        setBoard(null);
        return;
      }
      setBoard(await res.json() as Board);
    } catch {
      toast.error("Erro ao consultar as ordens de serviço.");
    } finally {
      setLoadingBoard(false);
    }
  }, [technicianId, client, service, dateFrom, dateTo, scope]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!tokensReady) return;
    void loadBoard(false);
    const timer = window.setInterval(() => void loadBoard(false), 60_000);
    return () => window.clearInterval(timer);
  }, [tokensReady, loadBoard]);

  async function saveSettings() {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/settings`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ alertsEnabled }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = await res.json() as Settings;
      setTokensReady(Boolean(data.accessConfigured && data.secretConfigured));
      setAlertsEnabled(data.alertsEnabled !== false);
      toast.success("Avisos salvos.");
      if (data.accessConfigured && data.secretConfigured) void loadBoard(true);
    } catch {
      toast.error("Erro ao salvar a Cell Tech.");
    } finally {
      setSaving(false);
    }
  }

  async function runAction(name: string, path: string, ok: string) {
    setBusy(name);
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/${path}`, { method: "POST", headers: authHeaders() });
      const data = await res.json().catch(() => ({})) as { message?: string; alreadySent?: boolean; orders?: number; situations?: number };
      if (!res.ok) {
        toast.error(data.message || "Não foi possível concluir.");
        return;
      }
      if (data.alreadySent) {
        toast.message("Esse relatório já foi para o grupo hoje.");
        return;
      }
      toast.success(ok);
    } catch {
      toast.error("Erro na Cell Tech.");
    } finally {
      setBusy("");
    }
  }

  const counts = board?.counts;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Cell Tech</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Ordens de serviço do Gestão Click. O aviso sai pelo n8n para o grupo da loja. Esta aba não mexe em pedido, PIX nem frete.
        </p>
      </div>

      <section className="rounded-2xl border border-border bg-white p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Token e status da última chamada ficam em
          <button type="button" className="mx-1 font-semibold text-primary" onClick={() => setLocation(pathForTab("cellTechConexao"))}>Conexão</button>
          . O que conta como fechada fica em
          <button type="button" className="mx-1 font-semibold text-primary" onClick={() => setLocation(pathForTab("cellTechSituacoes"))}>Situações</button>
          .
        </p>
        {loadingSettings ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
          <>
            {!tokensReady && <p className="text-sm">Salve o access token e o secret em Conexão para ver as ordens.</p>}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={alertsEnabled} onChange={(e) => setAlertsEnabled(e.target.checked)} />
              Avisar o grupo: cadastro, prazo, lembrete, fila da manhã e OS parada. Relatório às 8h30 e no dia 1 o mensal. O automático só sai das 8h às 19h, horário de Brasília
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void saveSettings()} disabled={saving} className="h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60">
                {saving ? "Salvando…" : "Salvar avisos"}
              </button>
              <button type="button" onClick={() => void runAction("webhook", "test-webhook", "Teste enviado ao n8n.")} disabled={busy === "webhook"} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
                {busy === "webhook" ? "Enviando…" : "Testar grupo"}
              </button>
              <button type="button" onClick={() => void runAction("daily", "reports/daily", "Relatório do dia enviado.")} disabled={busy === "daily"} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
                Relatório do dia
              </button>
              <button type="button" onClick={() => void runAction("monthly", "reports/monthly", "Relatório do mês enviado.")} disabled={busy === "monthly"} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
                Relatório do mês
              </button>
            </div>
          </>
        )}
      </section>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Abertas", counts?.open ?? 0],
          ["Atrasadas", counts?.overdue ?? 0],
          ["Vence hoje", counts?.dueToday ?? 0],
          ["Sem prazo", counts?.noDeadline ?? 0],
          ["Em execução", counts?.working ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl border border-border bg-white p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        ))}
      </section>

      <section className="flex gap-2 flex-wrap">
        <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm">
          <option value="">Todos os técnicos</option>
          {(board?.technicians || []).map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
        </select>
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Cliente" className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm" />
        <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Serviço" className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm" />
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm" />
        <select value={scope} onChange={(e) => setScope(e.target.value as "open" | "done" | "all")} className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm">
          <option value="open">Abertas</option>
          <option value="done">Finalizadas</option>
          <option value="all">Todas</option>
        </select>
        <button type="button" onClick={() => void loadBoard(true)} className="h-11 px-3 rounded-xl border-2 border-border bg-white text-sm inline-flex items-center gap-2">
          {loadingBoard ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Atualizar
        </button>
      </section>

      <p className="text-xs text-muted-foreground">Verde no prazo, amarelo vence hoje, vermelho atrasado, cinza sem prazo. A lista atualiza a cada minuto e olha os últimos 120 dias.</p>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(board?.orders || []).map((order) => (
          <article key={order.id} className={`rounded-2xl border-2 p-4 ${TONE_CLASS[order.tone] || TONE_CLASS.gray}`}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold">OS {order.code}</h3>
              <span className="text-xs font-medium">{order.statusLabel}</span>
            </div>
            <p className="text-sm mt-2">{order.clientName}</p>
            <p className="text-sm">{order.services[0] || order.equipment || "Serviço"}</p>
            <p className="text-sm text-muted-foreground">{order.technicianName} · {order.situationName}{order.working ? " · fazendo agora" : ""}</p>
            <p className="text-sm mt-1">Prazo: {order.deadlineLabel}</p>
          </article>
        ))}
      </section>
      {board && board.orders.length === 0 && !loadingBoard && (
        <p className="text-sm text-muted-foreground">Nenhuma ordem de serviço nesse filtro.</p>
      )}
    </div>
  );
}
