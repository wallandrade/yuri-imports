import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem("adminToken") || localStorage.getItem("adminToken") || "";
  if (!token) return { "Content-Type": "application/json" };
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

type Situation = { id: string; name: string };

type Payload = {
  situations: Situation[];
  doneSituationIds: string[];
  workingSituationIds: string[];
  stalledSituationIds: string[];
  stalledMinDays: number;
  labels: Record<string, string>;
  listed: boolean;
  message: string;
};

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string };
    return data.message || "Não foi possível concluir.";
  } catch {
    return "Não foi possível concluir.";
  }
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

export default function AdminCellTechSituations() {
  const [situations, setSituations] = useState<Situation[]>([]);
  const [listed, setListed] = useState(false);
  const [listMessage, setListMessage] = useState("");
  const [doneIds, setDoneIds] = useState<string[]>([]);
  const [workingIds, setWorkingIds] = useState<string[]>([]);
  const [stalledIds, setStalledIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [stalledDays, setStalledDays] = useState("3");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualWorking, setManualWorking] = useState("");
  const [manualStalled, setManualStalled] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((data: Payload) => {
    setSituations(data.situations || []);
    setListed(Boolean(data.listed) && (data.situations || []).length > 0);
    setListMessage(data.message || "");
    setDoneIds(data.doneSituationIds || []);
    setWorkingIds(data.workingSituationIds || []);
    setStalledIds(data.stalledSituationIds || []);
    setLabels(data.labels || {});
    setStalledDays(String(data.stalledMinDays ?? 3));
    setManualWorking((data.workingSituationIds || []).join(", "));
    setManualStalled((data.stalledSituationIds || []).join(", "));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/admin/cell-tech/situations`, { headers: authHeaders() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      apply(await res.json() as Payload);
    } catch {
      toast.error("Erro ao carregar as situações.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  function addManual() {
    const id = manualId.trim();
    const name = manualName.trim();
    if (!id || id === "0") {
      toast.error("Informe o ID. O nome sozinho não fecha a OS.");
      return;
    }
    setDoneIds((current) => current.includes(id) ? current : [...current, id]);
    if (name) setLabels((current) => ({ ...current, [id]: name }));
    setManualId("");
    setManualName("");
  }

  function splitIds(raw: string): string[] {
    return raw.split(",").map((item) => item.trim()).filter((item) => item && item !== "0");
  }

  async function save() {
    setSaving(true);
    try {
      const working = listed ? workingIds : splitIds(manualWorking);
      const stalled = listed ? stalledIds : splitIds(manualStalled);
      const nextLabels = { ...labels };
      for (const situation of situations) {
        if (doneIds.includes(situation.id) && situation.name) nextLabels[situation.id] = situation.name;
      }
      const res = await fetch(`${BASE}/api/admin/cell-tech/settings`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          doneSituationIds: doneIds,
          workingSituationIds: working,
          stalledSituationIds: stalled,
          stalledMinDays: stalledDays,
          situationLabels: nextLabels,
        }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Situações salvas.");
      await load();
    } catch {
      toast.error("Erro ao salvar as situações.");
    } finally {
      setSaving(false);
    }
  }

  const knownIds = new Set(situations.map((situation) => situation.id));
  const extraDone = doneIds.filter((id) => !knownIds.has(id));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Situações</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Marque o que conta como fechada. Exemplos: Finalizado, Concretizado O.S e Sem reparo. O ID gravado continua o mesmo de hoje. O nome que já fecha a OS continua fechando, mesmo sem esta marca.
        </p>
      </div>

      {loading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <section className="rounded-2xl border border-border bg-white p-4 space-y-4">
          {listed ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Lista do Gestão Click. Finalizada grava o ID. Trabalhando e OS parada seguem as marcas que já existiam.</p>
              {situations.map((situation) => (
                <div key={situation.id} className="flex flex-wrap items-center gap-4 text-sm">
                  <span className="min-w-40">{situation.name} <span className="text-muted-foreground">{situation.id}</span></span>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={doneIds.includes(situation.id)} onChange={() => setDoneIds(toggle(doneIds, situation.id))} />
                    Fechada
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={workingIds.includes(situation.id)} onChange={() => setWorkingIds(toggle(workingIds, situation.id))} />
                    Trabalhando
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={stalledIds.includes(situation.id)} onChange={() => setStalledIds(toggle(stalledIds, situation.id))} />
                    OS parada
                  </label>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">{listMessage || "A lista do Gestão Click não veio."}</p>
              <p className="text-xs text-muted-foreground">Informe o ID. O nome é só para reconhecer e não entra na regra.</p>
              {doneIds.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma situação fechada marcada.</p> : doneIds.map((id) => (
                <div key={id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-mono">{id}</span>
                  <span>{labels[id] || "Sem nome"}</span>
                  <button type="button" className="text-sm underline" onClick={() => setDoneIds(doneIds.filter((item) => item !== id))}>Tirar</button>
                </div>
              ))}
              <label className="text-sm block max-w-md">
                <span className="block mb-1 text-muted-foreground">IDs trabalhando, separados por vírgula</span>
                <input value={manualWorking} onChange={(e) => setManualWorking(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
              <label className="text-sm block max-w-md">
                <span className="block mb-1 text-muted-foreground">IDs de OS parada, separados por vírgula</span>
                <input value={manualStalled} onChange={(e) => setManualStalled(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
              </label>
            </div>
          )}

          {listed && extraDone.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">IDs salvos que não vieram na lista.</p>
              {extraDone.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked onChange={() => setDoneIds(doneIds.filter((item) => item !== id))} />
                  <span className="font-mono">{id}</span>
                  <span>{labels[id] || ""}</span>
                </label>
              ))}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] items-end">
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">ID da situação</span>
              <input value={manualId} onChange={(e) => setManualId(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">Nome (opcional)</span>
              <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Finalizado" className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
            </label>
            <button type="button" onClick={addManual} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">Adicionar fechada</button>
          </div>

          <label className="text-sm block max-w-xs">
            <span className="block mb-1 text-muted-foreground">Dias na mesma situação para a OS parada</span>
            <input type="number" min={1} max={365} value={stalledDays} onChange={(e) => setStalledDays(e.target.value)} className="w-full h-10 px-3 rounded-xl border-2 border-border outline-none focus:border-primary text-sm" />
          </label>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void save()} disabled={saving} className="h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60">
              {saving ? "Salvando…" : "Salvar situações"}
            </button>
            <button type="button" onClick={() => void load()} className="h-10 px-4 rounded-xl border-2 border-border text-sm font-medium">
              Atualizar lista
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
