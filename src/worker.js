/* Portfolio worker: static files from public/, plus POST /api/contact,
 * which emails project inquiries to CONTACT_TO_EMAIL through Resend. */

// www and the old workers.dev address redirect here.
const CANONICAL_HOST = "fathyelhadidy.com";

const esc = s =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL_HOST && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.hostname = CANONICAL_HOST;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
      return contact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function contact(request, env) {
  // Only accept posts from this site's own pages.
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: "Forbidden." }, 403);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.CONTACT_LIMITER) {
    const { success } = await env.CONTACT_LIMITER.limit({ key: ip });
    if (!success) return json({ ok: false, error: "Too many messages. Please try again in a minute." }, 429);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid request." }, 400);

  // Honeypot and fill time: bots fill hidden fields and submit instantly.
  // Pretend it worked so they don't retry.
  if (clean(body.website, 200) || Date.now() - Number(body.t || 0) < 3000) return json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const business = clean(body.business, 160);
  const need = clean(body.need, 60);
  const budget = clean(body.budget, 60);
  const message = clean(body.message, 5000);

  if (!name || !email || !message) {
    return json({ ok: false, error: "Please fill in your name, email and message." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY missing; inquiry not sent:", name, email);
    return json({ ok: false, error: "The form isn't set up yet. Please email me directly." }, 503);
  }

  const rows = [["Name", name], ["Email", email], ["Business", business], ["Needs", need], ["Budget", budget]]
    .filter(([, v]) => v);
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#15191C;max-width:560px">
  <p style="font:600 11px monospace;letter-spacing:.1em;text-transform:uppercase;color:#1E6B52;margin:0 0 6px">New project inquiry</p>
  <h1 style="font-size:22px;margin:0 0 16px">${esc(name)}${business ? ` · ${esc(business)}` : ""}</h1>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
    ${rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #E1E7E2;color:#5B6560;width:90px">${k}</td><td style="padding:8px 0;border-bottom:1px solid #E1E7E2">${esc(v)}</td></tr>`).join("")}
  </table>
  <div style="margin-top:18px;padding:14px 16px;background:#F3F5F2;border-left:3px solid #1E6B52;border-radius:6px;white-space:pre-wrap">${esc(message)}</div>
  <p style="color:#5B6560;font-size:13px;margin-top:18px">Reply to this email to answer ${esc(name)} directly.</p>
</div>`;
  const text = [...rows.map(([k, v]) => `${k}: ${v}`), "", message].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "Portfolio <onboarding@resend.dev>",
      to: [env.CONTACT_TO_EMAIL || "fathyelhadedy@gmail.com"],
      reply_to: email,
      subject: `New inquiry from ${name}${business ? ` (${business})` : ""}`,
      html,
      text,
    }),
  });
  if (!res.ok) {
    console.error("Resend error:", res.status, await res.text());
    return json({ ok: false, error: "Something went wrong sending your message. Please email me directly." }, 502);
  }
  return json({ ok: true });
}
