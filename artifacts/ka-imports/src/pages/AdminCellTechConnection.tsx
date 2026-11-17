import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem("adminToken") || localStorage.getItem("adminToken") || "";
  if (!token) return { "Content-Type": "application/json" };
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type Settings = {
  accessConfigured?: boolean;
  secretConfigured?: boolean;
  accessHint?: string;
  secretHint?: string;
  webhookUrl?: string;
  usuarioId?: string;
  lojaId?: string;
};

type CallStatus = {
  outcome: "ok" | "recusado" | "falhou" | null;
  message: string;
  at: string | null;
};

type ConnectionStatus = {
  accessConfigured: boolean;
  secretConfigured: boolean;
  accessHint: string;
  secretHint: string;
  gestao: CallStatus;
  whatsapp: CallStatus;
};

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string };
    return data.message || "Não foi possível concluir.";
  } catch {
    return "Não foi possível concluir.";
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Sem horário";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Sem horário";
  return date.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function tone(outcome: CallStatus["outcome"]): string {
  if (outcome === "ok") return "border-emerald-300 bg-emerald-50";
  if (outcome === "recusado" || outcome === "falhou") return "border-red-300 bg-red-50";
  return "border-border bg-white";
}

function outcomeLabel(outcome: CallStatus["outcome"], kind: "gestao" | "whatsapp"): string {
  if (kind === "gestao") {
    if (outcome === "ok") return "Ok";
    if (outcome === "recusado") return "Recusado";
    return "Sem registro";
  }
  if (outcome === "ok") return "Enviado";
  if (outcome === "falhou") return "Falhou";
  return "Sem registro";
}

export default function AdminCellTechConnection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [secretAccessToken, setSecretAccessToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [usuarioId, setUsuarioId] = useState("");
  const [lojaId, setLojaId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");

  const loadSettings = useCallback(async () => {
    const res = await fetch(`${BASE}/api/admin/cell-tech/settings`, { headers: authHeaders() });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json() as Settings;
    setSettings(data);
    setWebhookUrl(data.webhookUrl || "");
    setUsuarioId(data.usuarioId || "");
    setLojaId(data.lojaId || "");
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch(`${BASE}/api/admin/cell-tech/connection`, { headers: authHeaders() });
    if (!res.ok) throw new Error(await readError(res));
    setStatus(await res.json() as ConnectionStatus);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadSettings(), loadStatus()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao carregar a conexão.");
    } finally {
      setLoading(false);
    }
  }, [loadSettings, loadStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings() {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/settings`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ accessToken, secretAccessToken, webhookUrl, usuarioId, lojaId }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = await res.json() as Settings;
      setSettings(data);
      setAccessToken("");
      setSecretAccessToken("");
      toast.success("Conexão salva.");
      await loadStatus();
    } catch {
      toast.error("Erro ao salvar a conexão.");
    } finally {
      setSaving(false);
    }
  }

  async function testGestao() {
    setBusy("connection");
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/test-connection`, { method: "POST", headers: authHeaders() });
      const data = await res.json().catch(() => ({})) as { message?: string; orders?: number; situations?: number };
      if (!res.ok) toast.error(data.message || "O Gestão Click recusou a consulta.");
      else toast.success(`Conectou. ${data.orders ?? 0} OS e ${data.situations ?? 0} situações.`);
    } catch {
      toast.error("Erro ao consultar o Gestão Click.");
    } finally {
      setBusy("");
      void loadStatus().catch(() => undefined);
    }
  }

  const accessHint = status?.accessHint || settings?.accessHint || "";
  const secretHint = status?.secretHint || settings?.secretHint || "";
  const accessOn = status?.accessConfigured ?? settings?.accessConfigured ?? false;
  const secretOn = status?.secretConfigured ?? settings?.secretConfigured ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Conexão</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Token e secret do Gestão Click. O valor completo não aparece, só o final. O grupo automático continua só das 8h às 19h, horário de Brasília. Esta tela não manda mensagem.
        </p>
      </div>

      {loading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <>
          <section className="grid gap-3 md:grid-cols-2">
            <article className="rounded-2xl border border-border bg-white p-4">
              <p className="text-xs text-muted-foreground">Access token</p>
              <p className="text-lg font-semibold mt-1">{accessOn ? "Configurado" : "Não configurado"}</p>
              {accessHint ? <p className="text-sm mt-1 font-mono">{accessHint}</p> : null}
            </article>
            <article className="rounded-2xl border border-border bg-white p-4">
              <p className="text-xs text-muted-foreground">Secret</p>
              <p className="text-lg font-semibold mt-1">{secretOn ? "Configurado" : "Não configurado"}</p>
              {secretHint ? <p className="text-sm mt-1 font-mono">{secretHint}</p> : null}
            </article>
            <article className={`rounded-2xl border-2 p-4 ${tone(status?.gestao.outcome ?? null)}`}>
              <p className="text-xs text-muted-foreground">Última chamada ao Gestão Click</p>
              <p className="text-lg font-semibold mt-1">{outcomeLabel(status?.gestao.outcome ?? null, "gestao")}</p>
              <p className="text-sm mt-1">{formatWhen(status?.gestao.at ?? null)}</p>
              {status?.gestao.message ? <p className="text-sm mt-2">{status.gestao.message}</p> : null}
            </article>
            <article className={`rounded-2xl border-2 p-4 ${tone(status?.whatsapp.outcome ?? null)}`}>
              <p className="text-xs text-muted-foreground">Último envio ao grupo de WhatsApp</p>
              <p className="text-lg font-semibold mt-1">{outcomeLabel(status?.whatsapp.outcome ?? null, "whatsapp")}</p>
              <p className="text-sm mt-1">{formatWhen(status?.whatsapp.at ?? null)}</p>
              {status?.whatsapp.message ? <p className="text-sm mt-2">{status.whatsapp.message}</p> : null}
            </article>
          </section>

          <section className="rounded-2xl border border-border bg-white p-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                <span className="block mb-1 text-muted-foreground">Access token {accessHint ? `(${accessHint})` : ""}</span>
                <input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder={accessOn ? "Em branco mantém o atual" : "Cole o access token"} autoComplete="off" className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
              <label className="text-sm">
                <span className="block mb-1 text-muted-foreground">Secret {secretHint ? `(${secretHint})` : ""}</span>
                <input type="password" value={secretAccessToken} onChange={(e) => setSecretAccessToken(e.target.value)} placeholder={secretOn ? "Em branco mantém o atual" : "Cole o secret"} autoComplete="off" className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
              <label className="text-sm md:col-span-2">
                <span className="block mb-1 text-muted-foreground">Webhook n8n (https)</span>
                <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://….app.n8n.cloud/webhook/…" className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
              <label className="text-sm">
                <span className="block mb-1 text-muted-foreground">usuario_id (se a conta tiver mais de um)</span>
                <input value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
              <label className="text-sm">
                <span className="block mb-1 text-muted-foreground">loja_id (se tiver mais de uma loja)</span>
                <input value={lojaId} onChange={(e) => setLojaId(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">No n8n, o HTTP Request lê o campo message e a Z-API manda no grupo. O token da Z-API fica no n8n. Atualizar status só lê o que já foi gravado.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void saveSettings()} disabled={saving} className="h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60">
                {saving ? "Salvando…" : "Salvar"}
              </button>
              <button type="button" onClick={() => void testGestao()} disabled={busy === "connection"} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
                {busy === "connection" ? "Testando…" : "Testar Gestão Click"}
              </button>
              <button type="button" onClick={() => void loadStatus().catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao atualizar."))} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
                Atualizar status
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
