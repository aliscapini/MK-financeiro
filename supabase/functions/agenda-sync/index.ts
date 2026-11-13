// MK Financeiro — Edge Function: lê o Google Agenda do salão (endereço secreto iCal) para as confirmações
// Ações (POST JSON):
//   {acao:"status"}                         -> agendas conectadas (só os nomes)
//   {acao:"conectar", agendas:[{nome,url}]} -> testa e guarda os endereços secretos (substitui os anteriores)
//   {acao:"eventos", de:"AAAA-MM-DD", ate:"AAAA-MM-DD"} -> eventos com horário nesse intervalo (horário de Brasília)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const OFFSET_H = -3; // America/Sao_Paulo (sem horário de verão desde 2019)

type Ev = { data: string; inicio: string; fim: string; titulo: string; agenda: string; uid: string };

function unfold(txt: string): string[] {
  return txt.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
function unesc(s: string) {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
// devolve {data:'AAAA-MM-DD', hora:'HH:MM'} no horário local, ou null para evento de dia inteiro
function quando(prop: string, val: string): { data: string; hora: string } | null {
  if (/VALUE=DATE(?!-)/.test(prop) || /^\d{8}$/.test(val)) return null;
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  let d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (m[7] === "Z") d = new Date(d.getTime() + OFFSET_H * 3600000); // UTC -> Brasília
  const iso = d.toISOString();
  return { data: iso.substring(0, 10), hora: iso.substring(11, 16) };
}
function parseIcs(txt: string, agenda: string, de: string, ate: string): Ev[] {
  const out: Ev[] = [];
  let cur: Record<string, [string, string]> | null = null;
  for (const line of unfold(txt)) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.DTSTART && !cur.RRULE && !/CANCELLED/i.test(cur.STATUS?.[1] || "")) {
        const ini = quando(cur.DTSTART[0], cur.DTSTART[1]);
        const fim = cur.DTEND ? quando(cur.DTEND[0], cur.DTEND[1]) : null;
        if (ini && ini.data >= de && ini.data <= ate) {
          out.push({ data: ini.data, inicio: ini.hora, fim: fim?.hora || "", titulo: unesc(cur.SUMMARY?.[1] || ""), agenda,
            uid: (cur.UID?.[1] || "") + (cur["RECURRENCE-ID"]?.[1] || "") });
        }
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const head = line.substring(0, i), val = line.substring(i + 1);
    const nome = head.split(";")[0].toUpperCase();
    if (!cur[nome]) cur[nome] = [head, val];
  }
  return out;
}
async function baixar(url: string) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok || !t.includes("BEGIN:VCALENDAR")) throw new Error("o Google não devolveu a agenda (" + r.status + "). Confira se o endereço é o secreto, no formato iCal.");
  return t;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const J = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const auth = req.headers.get("Authorization") || "";
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } });
    const { data: ok } = await user.rpc("mk_tem_acesso", { area: "financeiro" });
    if (!ok) return J({ error: "não autorizado" }, 401);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const acao = body.acao || "status";

    if (acao === "conectar") {
      const ags = (body.agendas || []).filter((a: { nome?: string; url?: string }) => a && a.url);
      if (!ags.length) return J({ error: "cole pelo menos um endereço" }, 400);
      for (const a of ags) {
        a.url = String(a.url).trim(); a.nome = String(a.nome || "Agenda").trim();
        if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\/.+\/private-[^/]+\/basic\.ics$/.test(a.url))
          return J({ error: `"${a.nome}": use o "Endereço secreto no formato iCal" (termina em /basic.ics)` }, 400);
        await baixar(a.url); // testa antes de guardar
      }
      await db.from("mk_agenda_ics").delete().gte("id", 0);
      const { error } = await db.from("mk_agenda_ics").insert(ags.map((a: { nome: string; url: string }) => ({ nome: a.nome, url: a.url })));
      if (error) throw error;
      return J({ ok: true, agendas: ags.map((a: { nome: string }) => a.nome) });
    }

    const { data: rows, error } = await db.from("mk_agenda_ics").select("nome,url").order("id");
    if (error) throw error;
    if (acao === "status") return J({ conectado: (rows || []).length > 0, agendas: (rows || []).map((r) => r.nome) });

    if (acao === "eventos") {
      const de = String(body.de || ""), ate = String(body.ate || body.de || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return J({ error: "datas inválidas" }, 400);
      let eventos: Ev[] = []; const erros: string[] = [];
      for (const r of rows || []) {
        try { eventos = eventos.concat(parseIcs(await baixar(r.url), r.nome, de, ate)); }
        catch (e) { erros.push(r.nome + ": " + String((e as Error).message || e)); }
      }
      eventos.sort((a, b) => (a.data + a.inicio).localeCompare(b.data + b.inicio));
      return J({ conectado: (rows || []).length > 0, eventos, erros });
    }
    return J({ error: "ação desconhecida" }, 400);
  } catch (e) {
    return J({ error: String((e as Error).message || e) }, 500);
  }
});
