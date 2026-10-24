'use strict';
/* UM6SS – FM6SIPS Dakhla : serveur de déclarations d’absences.
   Aucune dépendance (Node 18+). Héberge l’application d’administration (public/index.html),
   le formulaire mobile (public/form.html) et l’API. Voir README.md. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 8787;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const PASS = process.env.ADMIN_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
if (PASS.length < 8) { console.error('ERREUR : définissez ADMIN_PASSWORD (8 caractères minimum). Aucun mot de passe par défaut n’est fourni.'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });
const SECRET_FILE = path.join(DATA, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const STORE_FILE = path.join(DATA, 'store.json');
let store = { forms: {}, absences: [], audit: [], policies: {}, sessions: {}, alerts: {}, notifs: [] };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))); } catch (e) { /* premier démarrage */ }
function persist() { const tmp = STORE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, STORE_FILE); }
const CASA = 'Africa/Casablanca', ALLOW_EARLY = process.env.ALLOW_EARLY === '1', TEST_CLOCK = process.env.ALLOW_TEST_CLOCK === '1';
let FAKE = null; const nowMs = () => FAKE !== null ? FAKE : Date.now();
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: CASA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function tzOffset(ms) { const o = {}; for (const p of _fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000; }
/* heure murale Africa/Casablanca -> instant UTC (gère GMT+1 / GMT+0 du Ramadan via les données IANA, jamais de décalage fixe) */
function wallToUtc(date, hm) { const [y, m, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number), g = Date.UTC(y, m - 1, d, h, mi); let t = g - tzOffset(g); t = g - tzOffset(t); return t; }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = n => crypto.randomBytes(n).toString('hex');
const GENESIS = '0'.repeat(64);
const audit = (event, req, extra) => { const prev = store.audit.length ? store.audit[store.audit.length - 1].h : GENESIS; const e = { at: new Date(nowMs()).toISOString(), event, ip: req ? ip(req) : 'système', ...extra, prev }; e.h = sha(prev + JSON.stringify(e)); store.audit.push(e); };
function auditValid() { let prev = GENESIS; for (const e of store.audit) { const { h, ...rest } = e; if (rest.prev !== prev || sha(prev + JSON.stringify(rest)) !== h) return false; prev = h; } return true; }
const notify = (kind, title, desc, sessionId, formId) => { store.notifs.push({ id: rid(6), at: new Date(nowMs()).toISOString(), kind, title, desc, sessionId: sessionId || '', formId: formId || '', read: false }); };
function ip(req) { return (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?'; }
const hits = new Map();
function limited(key, max, ms) { const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); return a.length > max; }
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 120000)) hits.delete(k); }, 60000).unref();
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), null, extra);
const fail = (res, code, msg) => json(res, code, { error: msg });
function body(req, max) {
  return new Promise((ok, ko) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return ko({ code: 415, msg: 'JSON attendu' });
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > max) { ko({ code: 413, msg: 'Requête trop volumineuse' }); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { ko({ code: 400, msg: 'JSON invalide' }); } });
    req.on('error', () => ko({ code: 400, msg: 'Erreur de lecture' }));
  });
}
/* ----- session administrateur : cookie signé HttpOnly ----- */
function mkCookie(req) {
  const exp = Date.now() + 12 * 3600e3, sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  const secure = (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  return `sid=${exp}.${sig}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${secure}`;
}
function authed(req) {
  const m = /(?:^|;\s*)sid=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m || +m[1] < Date.now()) return false;
  const good = crypto.createHmac('sha256', SECRET).update(m[1]).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(good), Buffer.from(m[2]));
}
function sameOrigin(req) { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } }
/* ----- validation ----- */
const str = (v, max) => typeof v === 'string' && v.length <= max ? v.trim() : '';
function cleanStudents(a) {
  if (!Array.isArray(a) || a.length > 500) return null; const seen = new Set(), out = [];
  for (const s of a) { const m = str(s && s.m, 40), n = str(s && s.n, 140); if (!m || !n || seen.has(m)) return null; seen.add(m); out.push({ m, n }); } return out;
}
const abList = a => Array.isArray(a) ? cleanStudents(a.map(x => ({ m: x && x.m, n: x && x.n }))) : null;
function formState(f) { return f.revokedAt ? 'revoked' : (Date.parse(f.expiresAt) < nowMs() ? 'expired' : 'open'); }
const pubSession = s => ({ subject: s.subject, teacher: s.teacher, date: s.date, start: s.start, end: s.end, program: s.program, year: s.year, group: s.group, room: s.room });
function findForm(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const h = sha(token); return Object.values(store.forms).find(f => f.tokenHash === h) || null;
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (TRUST_PROXY && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + ((TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host);
}
function amendRule(f, ex) {
  const pol = store.policies[f.session.teacherId || ''] || { mode: '24h' }, first = Date.parse(ex.firstAt || ex.submittedAt), h24 = first + 24 * 3600e3, n = nowMs();
  if (pol.mode === 'block') return { ok: false, msg: 'La modification est bloquée par l’administration.' };
  if (n <= h24) return { ok: true, until: h24 };
  if (pol.mode === 'exception' && pol.until && n <= Date.parse(pol.until)) return { ok: true, until: Date.parse(pol.until), exception: true };
  return { ok: false, msg: 'Le délai de modification de 24 heures est dépassé. Contactez l’administration.' };
}
const startMs = f => wallToUtc(f.session.date, f.session.start);
function absRecord(f, p, now) {
  return { id: rid(8), formId: f.id, sessionId: f.session.sessionId, ...pubSession(f.session), absent: p.absent, total: p.absent.length, enrolled: f.session.students.length, remark: p.remark, source: 'lien', status: 'soumise', signatureType: p.signatureType, signature: p.signature, signedBy: p.signedBy, submittedAt: now, firstAt: now, teacherId: f.session.teacherId || '', versions: [] };
}
/* ----- surveillance : alerte de non-déclaration dès l'heure de fin (heure du Maroc), sans délai de grâce ----- */
function runAlerts() {
  const n = nowMs(); let ch = false; const iso = () => new Date(n).toISOString();
  for (const s of Object.values(store.sessions)) {
    const id = 'nd|' + s.id, al = store.alerts[id], decl = store.absences.some(a => a.sessionId === s.id && a.status !== 'annulée'), live = s.status === 'programmee' || s.status === 'realisee', due = n >= wallToUtc(s.date, s.end);
    if (al && !al.resolvedAt) { if (decl) { al.resolvedAt = iso(); al.resolvedBy = 'déclaration reçue'; ch = true; } else if (!live) { al.resolvedAt = iso(); al.resolvedBy = 'séance annulée ou reportée'; ch = true; } }
    else if (al && al.resolvedAt && live && !decl && due) { al.resolvedAt = null; al.resolvedBy = ''; al.reopenedAt = iso(); ch = true; }
    else if (!al && live && !decl && due) { store.alerts[id] = { id, sessionId: s.id, createdAt: iso(), resolvedAt: null, resolvedBy: '', subject: s.subject, teacher: s.teacher, teacherId: s.teacherId, date: s.date, start: s.start, end: s.end, program: s.program, year: s.year, group: s.group, room: s.room }; ch = true; }
  }
  if (ch) persist();
}
setInterval(runAlerts, +process.env.ALERT_INTERVAL_MS || 30000).unref();
/* ----- routeur ----- */
async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, M = req.method;
  if (M === 'GET' && (p === '/' || p === '/index.html')) return file(res, 'index.html');
  if (M === 'GET' && /^\/f\/[A-Za-z0-9_-]+$/.test(p)) return file(res, 'form.html', { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  if (M === 'GET' && p === '/health') return json(res, 200, { ok: true });
  if (!p.startsWith('/api/')) return fail(res, 404, 'Introuvable');
  if (M === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, app: 'um6ss-edt' });
  /* ---- API publique du formulaire (accès par jeton) ---- */
  let m = /^\/api\/form\/([^/]+)(\/submit)?$/.exec(p);
  if (m) {
    if (limited('pub:' + ip(req), 90, 60000)) return fail(res, 429, 'Trop de requêtes');
    const f = findForm(m[1]);
    if (!f) { audit('lien inconnu', req); return fail(res, 404, 'Lien invalide'); }
    const st = formState(f); if (st !== 'open') return fail(res, 410, st === 'revoked' ? 'Ce lien a été révoqué.' : 'Ce lien a expiré.');
    if (M === 'GET' && !m[2]) {
      const ex = f.absenceId && store.absences.find(a => a.id === f.absenceId && a.status !== 'annulée');
      const can = ALLOW_EARLY || nowMs() >= startMs(f), am = ex ? amendRule(f, ex) : null;
      return json(res, 200, { session: pubSession(f.session), students: f.session.students, canDeclare: can, startsAt: f.session.date + ' ' + f.session.start, submitted: ex ? { absent: ex.absent.map(a => a.m), total: ex.total, remark: ex.remark, submittedAt: ex.submittedAt, status: ex.status, canAmend: am.ok, amendMsg: am.msg || '', amendUntil: am.until ? new Date(am.until).toISOString() : '' } : null });
    }
    if (M === 'POST' && m[2]) {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine refusée');
      let b; try { b = await body(req, 300 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg || 'Erreur'); }
      if (!ALLOW_EARLY && nowMs() < startMs(f)) return fail(res, 403, 'La séance n’a pas encore commencé : la déclaration sera possible à partir de ' + f.session.start + '.');
      const known = new Map(f.session.students.map(s => [s.m, s]));
      const abs = Array.isArray(b.absent) ? b.absent : null; if (!abs || abs.length > known.size) return fail(res, 400, 'Liste des absents invalide');
      const uniq = [...new Set(abs.map(x => typeof x === 'string' ? x : ''))]; if (uniq.length !== abs.length || uniq.some(x => !known.has(x))) return fail(res, 400, 'Un étudiant n’appartient pas à ce groupe');
      if (b.none === true && uniq.length) return fail(res, 400, 'Incohérence : « aucun absent » et absents sélectionnés');
      if (!uniq.length && b.none !== true) return fail(res, 400, 'Sélectionnez les absents ou confirmez qu’aucun étudiant n’est absent');
      const remark = str(b.remark, 1000); let signature = '', signedBy = '';
      if (b.signatureType === 'handwritten') { if (typeof b.signature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) || b.signature.length > 160000 || b.signature.length < 300) return fail(res, 400, 'Signature manuscrite invalide'); signature = b.signature; signedBy = str(b.signedBy, 80); }
      else if (b.signatureType === 'electronic') { signedBy = str(b.signedBy, 80); if (signedBy.length < 2 || b.confirm !== true) return fail(res, 400, 'Confirmation électronique incomplète'); }
      else return fail(res, 400, 'Signature ou confirmation obligatoire');
      const now = new Date(nowMs()).toISOString(), ex = f.absenceId && store.absences.find(a => a.id === f.absenceId && a.status !== 'annulée');
      const pay = { absent: uniq.map(x => known.get(x)), remark, signatureType: b.signatureType, signature, signedBy };
      if (ex) {
        if (b.amend !== true) return fail(res, 409, 'Une déclaration a déjà été validée pour cette séance. Confirmez la modification.');
        const rule = amendRule(f, ex); if (!rule.ok) { audit('modification refusée (délai/blocage)', req, { formId: f.id }); persist(); return fail(res, 403, rule.msg); }
        const why = str(b.reason, 300); if (why.length < 3) return fail(res, 400, 'Indiquez le motif de la modification');
        ex.versions.push({ at: now, by: 'enseignant', absent: ex.absent, total: ex.total, remark: ex.remark, reason: why });
        Object.assign(ex, { absent: pay.absent, total: pay.absent.length, remark, signatureType: pay.signatureType, signature, signedBy, status: 'corrigée', updatedAt: now });
        audit('déclaration corrigée', req, { formId: f.id, ancien: ex.versions[ex.versions.length - 1].total, nouveau: ex.total, motif: why }); notify('modification', 'Déclaration modifiée : ' + f.session.subject, ex.versions[ex.versions.length - 1].total + ' → ' + ex.total + ' absent(s) (' + f.session.teacher + ', motif : ' + why + ')', f.session.sessionId, f.id); runAlerts(); persist(); return json(res, 200, { ok: true, total: ex.total, amended: true });
      }
      const rec = absRecord(f, pay, now); store.absences.push(rec); f.absenceId = rec.id; f.submittedAt = now;
      audit('déclaration soumise', req, { formId: f.id, total: rec.total }); notify(rec.total ? 'declaration' : 'aucun_absent', (rec.total ? 'Absences enregistrées : ' : 'Aucun absent confirmé : ') + f.session.subject, (rec.total ? rec.total + ' absent(s)' : 'Aucun absent') + ' — ' + f.session.teacher + ', ' + f.session.date + ' ' + f.session.start, f.session.sessionId, f.id); runAlerts(); persist(); return json(res, 200, { ok: true, total: rec.total });
    }
    return fail(res, 405, 'Méthode non autorisée');
  }
  /* ---- connexion administrateur ---- */
  if (M === 'POST' && p === '/api/login') {
    if (!sameOrigin(req)) return fail(res, 403, 'Origine refusée');
    if (limited('login:' + ip(req), 5, 60000)) return fail(res, 429, 'Trop de tentatives');
    let b; try { b = await body(req, 2048); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const ok = typeof b.password === 'string' && crypto.timingSafeEqual(Buffer.from(sha(b.password)), Buffer.from(sha(PASS)));
    audit(ok ? 'connexion admin' : 'échec connexion admin', req); if (ok) persist();
    return ok ? json(res, 200, { ok: true }, { 'Set-Cookie': mkCookie(req) }) : fail(res, 401, 'Mot de passe incorrect');
  }
  if (M === 'POST' && p === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  if (M === 'GET' && p === '/api/me') return json(res, 200, { auth: authed(req) });
  /* ---- API administrateur ---- */
  if (!authed(req)) return fail(res, 401, 'Authentification requise');
  if (M !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'Origine refusée');
  if (M === 'POST' && p === '/api/forms') {
    let b; try { b = await body(req, 400 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const s = b.session || {}, students = cleanStudents(s.students), sid = str(s.sessionId, 60);
    if (!sid || !students || !students.length) return fail(res, 400, 'Séance ou liste d’étudiants invalide');
    const session = { sessionId: sid, teacherId: str(s.teacherId, 60), subject: str(s.subject, 200), teacher: str(s.teacher, 140), date: str(s.date, 10), start: str(s.start, 5), end: str(s.end, 5), program: str(s.program, 20), year: str(s.year, 2), group: str(s.group, 10), room: str(s.room, 100), students };
    if (!session.subject || !session.teacher || !/^\d{4}-\d{2}-\d{2}$/.test(session.date)) return fail(res, 400, 'Matière, enseignant et date sont obligatoires');
    const hrs = Math.min(24 * 14, Math.max(0.001, +b.expiresInHours || 72)), now = new Date(nowMs());
    for (const o of Object.values(store.forms)) if (o.session.sessionId === sid && formState(o) === 'open' && !o.submittedAt) o.revokedAt = now.toISOString();
    const token = crypto.randomBytes(24).toString('base64url'), id = rid(8);
    store.forms[id] = { id, tokenHash: sha(token), session, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + hrs * 3600e3).toISOString(), revokedAt: null, submittedAt: null, absenceId: null };
    audit('lien créé', req, { formId: id }); persist();
    return json(res, 200, { id, url: baseUrl(req) + '/f/' + token, expiresAt: store.forms[id].expiresAt });
  }
  if (M === 'GET' && p === '/api/forms') return json(res, 200, { items: Object.values(store.forms).map(f => ({ id: f.id, session: pubSession(Object.assign({ sessionId: f.session.sessionId }, f.session)), sessionId: f.session.sessionId, students: f.session.students.length, createdAt: f.createdAt, expiresAt: f.expiresAt, revokedAt: f.revokedAt, submittedAt: f.submittedAt, state: formState(f) })) });
  m = /^\/api\/forms\/([a-f0-9]+)$/.exec(p);
  if (m && M === 'DELETE') { const f = store.forms[m[1]]; if (!f) return fail(res, 404, 'Introuvable'); f.revokedAt = f.revokedAt || new Date(nowMs()).toISOString(); audit('lien révoqué', req, { formId: f.id }); persist(); return json(res, 200, { ok: true }); }
  if (TEST_CLOCK && p === '/api/_test/clock' && M === 'POST') { let b; try { b = await body(req, 1024); } catch (e) { return fail(res, 400, 'x'); } FAKE = b.iso ? Date.parse(b.iso) : null; return json(res, 200, { now: new Date(nowMs()).toISOString() }); }
  if (M === 'GET' && p === '/api/audit') return json(res, 200, { valid: auditValid(), items: store.audit });
  if (M === 'GET' && p === '/api/policies') return json(res, 200, { items: store.policies });
  m = /^\/api\/policies\/([A-Za-z0-9_:@.-]{1,60})$/.exec(p);
  if (m && M === 'PUT') {
    let b; try { b = await body(req, 2048); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const mode = b.mode, reason = str(b.reason, 300);
    if (!['24h', 'block', 'exception'].includes(mode)) return fail(res, 400, 'Mode invalide');
    let until = '';
    if (mode === 'exception') { until = new Date(b.until).toString() === 'Invalid Date' ? '' : new Date(b.until).toISOString(); if (!until || Date.parse(until) <= nowMs()) return fail(res, 400, 'Une date d’expiration future est obligatoire pour une exception'); }
    const old = store.policies[m[1]] || { mode: '24h' }; store.policies[m[1]] = { mode, until, reason, at: new Date(nowMs()).toISOString() };
    audit('politique de modification', req, { enseignant: m[1], ancien: old.mode, nouveau: mode, jusqua: until, motif: reason });
    if (mode === 'exception') notify('exception', 'Exception de modification accordée', m[1] + ' jusqu’au ' + until, '', '');
    persist(); return json(res, 200, { ok: true });
  }
  if (M === 'POST' && p === '/api/sessions/sync') {
    let b; try { b = await body(req, 2 * 1024 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    if (!Array.isArray(b.sessions) || b.sessions.length > 5000) return fail(res, 400, 'Séances invalides');
    const out = {}, okSt = ['programmee', 'realisee', 'annulee', 'reportee', 'reportee_sans_date'];
    for (const x of b.sessions) {
      const id = str(x && x.id, 60), date = str(x && x.date, 10), st = str(x && x.start, 5), en = str(x && x.end, 5);
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(en) || !okSt.includes(x.status)) continue;
      out[id] = { id, date, start: st, end: en, status: x.status, teacherId: str(x.teacherId, 60), teacher: str(x.teacher, 140), subject: str(x.subject, 200), program: str(x.program, 20), year: str(x.year, 2), group: str(x.group, 10), room: str(x.room, 100) };
    }
    store.sessions = out; runAlerts(); persist(); return json(res, 200, { ok: true, count: Object.keys(out).length });
  }
  if (M === 'GET' && p === '/api/alerts') { return json(res, 200, { items: Object.values(store.alerts) }); }
  if (M === 'GET' && p === '/api/notifications') return json(res, 200, { items: store.notifs.slice(-300).reverse() });
  if (M === 'POST' && p === '/api/notifications/read') {
    let b; try { b = await body(req, 20000); } catch (e) { return fail(res, e.code || 400, e.msg); }
    for (const n of store.notifs) if (b.all === true || (Array.isArray(b.ids) && b.ids.includes(n.id))) n.read = true; persist(); return json(res, 200, { ok: true });
  }
  if (M === 'GET' && p === '/api/absences') return json(res, 200, { items: store.absences.map(a => Object.assign({}, a, { signature: undefined, hasSig: !!a.signature })) });
  m = /^\/api\/absences\/([a-f0-9]+)\/signature$/.exec(p);
  if (m && M === 'GET') { const a = store.absences.find(x => x.id === m[1]); return a ? json(res, 200, { signature: a.signature || '' }) : fail(res, 404, 'Introuvable'); }
  if (M === 'POST' && p === '/api/absences') {
    let b; try { b = await body(req, 200 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const sid = str(b.sessionId, 60), absent = abList(b.absent);
    if (!sid || absent === null) return fail(res, 400, 'Données invalides');
    if (store.absences.some(a => a.sessionId === sid && a.status !== 'annulée')) return fail(res, 409, 'Une déclaration existe déjà pour cette séance : utilisez la correction.');
    const rec = { id: rid(8), formId: null, sessionId: sid, subject: str(b.subject, 200), teacher: str(b.teacher, 140), date: str(b.date, 10), start: str(b.start, 5), end: str(b.end, 5), program: str(b.program, 20), year: str(b.year, 2), group: str(b.group, 10), room: str(b.room, 100), absent, total: absent.length, enrolled: +b.enrolled || 0, remark: str(b.remark, 1000), source: 'papier', status: 'saisie_admin', signatureType: 'administration', signature: '', signedBy: 'Saisie par l’administration', submittedAt: new Date(nowMs()).toISOString(), versions: [] };
    store.absences.push(rec); audit('absences saisies (papier)', req, { id: rec.id }); persist(); return json(res, 200, { id: rec.id });
  }
  m = /^\/api\/absences\/([a-f0-9]+)\/(amend|cancel)$/.exec(p);
  if (m && M === 'POST') {
    const a = store.absences.find(x => x.id === m[1]); if (!a) return fail(res, 404, 'Introuvable');
    let b; try { b = await body(req, 200 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const why = str(b.reason, 300); if (why.length < 3) return fail(res, 400, 'Le motif est obligatoire');
    a.versions.push({ at: new Date(nowMs()).toISOString(), by: 'administration', absent: a.absent, total: a.total, remark: a.remark, reason: m[2] === 'cancel' ? 'annulation : ' + why : why });
    if (m[2] === 'cancel') a.status = 'annulée';
    else { const ab = abList(b.absent); if (ab === null) return fail(res, 400, 'Liste invalide'); a.absent = ab; a.total = ab.length; a.remark = str(b.remark, 1000); a.status = 'corrigée'; a.updatedAt = new Date(nowMs()).toISOString(); }
    audit('déclaration ' + (m[2] === 'cancel' ? 'annulée' : 'corrigée') + ' (admin)', req, { id: a.id }); persist(); return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Introuvable');
}
function file(res, name, extra) {
  fs.readFile(path.join(PUB, name), (e, d) => e ? fail(res, 404, 'Fichier manquant : ' + name) : send(res, 200, d, 'text/html; charset=utf-8', extra));
}
const server = http.createServer((req, res) => { route(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, 500, 'Erreur serveur'); }); });
server.listen(PORT, () => console.log('Serveur UM6SS démarré : http://localhost:' + PORT + '  (données : ' + DATA + ')'));
