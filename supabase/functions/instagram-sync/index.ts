// MK Conteúdo — Edge Function: puxa os posts e as métricas do Instagram (@michelekrasniakbc)
// Ações (POST JSON):
//   {acao:"status"}             -> conta conectada? última atualização?
//   {acao:"conectar", token}    -> guarda o token (troca por um de 60 dias se for curto) e já sincroniza
//   {acao:"sync"}               -> atualiza os últimos 30 posts e as métricas de cada um
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const HOSTS: Record<string, string> = { instagram: "https://graph.instagram.com", facebook: "https://graph.facebook.com" };
const V = "v23.0";
const IG_ID_PADRAO = "17841404133101578"; // @michelekrasniakbc
let IG = HOSTS.instagram;

async function ig(path: string) {
  const r = await fetch(`${IG}/${path}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j?.error?.message || `Instagram respondeu ${r.status}`);
  return j;
}

let ultimoErroInsights = "";
async function insights(id: string, token: string) {
  // tenta o conjunto completo; se a Meta recusar alguma métrica para esse tipo de post, cai para o básico
  const tentativas = [
    "reach,views,saved,shares,total_interactions",
    "reach,saved,shares,total_interactions",
    "reach,saved",
  ];
  for (const m of tentativas) {
    try {
      const j = await ig(`${V}/${id}/insights?metric=${m}&access_token=${token}`);
      const out: Record<string, number> = {};
      for (const it of j.data || []) out[it.name] = it.values?.[0]?.value ?? it.total_value?.value ?? null;
      return out;
    } catch (e) { ultimoErroInsights = String((e as Error).message || e); }
  }
  return {} as Record<string, number>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const J = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    // 1) quem está chamando precisa ter acesso ao Conteúdo
    const auth = req.headers.get("Authorization") || "";
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } });
    const { data: ok } = await user.rpc("mk_tem_acesso", { area: "conteudo" });
    if (!ok) return J({ error: "não autorizado" }, 401);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const acao = body.acao || "sync";

    if (acao === "conectar") {
      const token = String(body.token || "").trim();
      if (!token) return J({ error: "token vazio" }, 400);
      // token do Instagram (IGAA…) -> graph.instagram.com ; token de sistema do login do Facebook -> graph.facebook.com
      let host = "instagram", igId: string | null = null, conta = "";
      try {
        IG = HOSTS.instagram;
        const me = await ig(`${V}/me?fields=user_id,username&access_token=${token}`);
        conta = me.username; igId = me.user_id || me.id;
      } catch (_) {
        host = "facebook"; IG = HOSTS.facebook;
        igId = String(body.ig_id || IG_ID_PADRAO);
        const me = await ig(`${V}/${igId}?fields=username&access_token=${token}`);
        conta = me.username;
      }
      await db.from("mk_instagram_token").upsert({ id: "mk", token, conta, host, ig_id: igId, renovado_em: new Date().toISOString() });
    }

    const { data: row } = await db.from("mk_instagram_token").select("*").eq("id", "mk").maybeSingle();
    if (!row) return J({ conectado: false });

    if (acao === "status") {
      const { data: last } = await db.from("mk_instagram").select("atualizado_em").order("atualizado_em", { ascending: false }).limit(1);
      return J({ conectado: true, conta: row.conta, atualizado_em: last?.[0]?.atualizado_em || null });
    }

    // 2) renova o token (vale 60 dias) quando já passou de ~20 dias
    let token = row.token;
    IG = HOSTS[row.host || "instagram"];
    const quem = row.host === "facebook" ? row.ig_id : "me";
    const idade = (Date.now() - new Date(row.renovado_em).getTime()) / 86400000;
    if (row.host !== "facebook" && idade > 20) { // token de sistema (Facebook) não expira
      try {
        const r = await ig(`refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
        token = r.access_token;
        await db.from("mk_instagram_token").update({ token, renovado_em: new Date().toISOString() }).eq("id", "mk");
      } catch (_) { /* segue com o atual */ }
    }

    // 3) últimos 30 posts + métricas
    const base = "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count";
    // totais com impulsionamento (só existem no login do Facebook); os números do insights são só orgânicos
    const extras = row.host === "facebook"
      ? [",total_like_count,total_views_count,boost_ads_list", ",total_like_count,total_views_count", ""] : [""];
    let media: any = null, erroMedia = "";
    for (const ex of extras) {
      try { media = await ig(`${V}/${quem}/media?fields=${base}${ex}&limit=30&access_token=${token}`); break; }
      catch (e) { erroMedia = String((e as Error).message || e); }
    }
    if (!media) throw new Error(erroMedia);
    const linhas = [];
    let semMetricas = 0;
    for (const m of media.data || []) {
      const tipo = m.media_product_type === "REELS" ? "Reels" : m.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : m.media_type === "VIDEO" ? "Vídeo" : "Foto";
      const s = await insights(m.id, token);
      if (s.reach == null) semMetricas++;
      const ads = (m.boost_ads_list && (m.boost_ads_list.data || m.boost_ads_list)) || [];
      linhas.push({
        media_id: m.id, tipo, legenda: (m.caption || "").slice(0, 300), link: m.permalink,
        thumb: m.thumbnail_url || m.media_url || null, publicado_em: m.timestamp,
        alcance: s.reach ?? null, views: s.views ?? null, salvos: s.saved ?? null,
        compartilhamentos: s.shares ?? null, interacoes: s.total_interactions ?? null,
        curtidas: m.like_count ?? null, comentarios: m.comments_count ?? null,
        views_total: m.total_views_count ?? null, curtidas_total: m.total_like_count ?? null,
        impulsionado: (Array.isArray(ads) && ads.length > 0)
          || (m.total_like_count != null && m.like_count != null && m.total_like_count > m.like_count)
          || (m.total_views_count != null && s.views != null && m.total_views_count > s.views * 1.15),
        atualizado_em: new Date().toISOString(),
      });
    }
    if (linhas.length) {
      const { error } = await db.from("mk_instagram").upsert(linhas);
      if (error) return J({ error: error.message }, 500);
    }
    return J({ conectado: true, conta: row.conta, posts: linhas.length, sem_metricas: semMetricas, aviso: semMetricas ? ultimoErroInsights.slice(0, 200) : undefined });
  } catch (e) {
    return J({ error: String((e as Error).message || e) }, 500);
  }
});
