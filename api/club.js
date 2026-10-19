// api/club.js — Club Candy: tarjeta de sellos con códigos de un solo uso.
// Corre en el servidor de Vercel. Guarda los datos en Upstash Redis.
//
// Variables de entorno en Vercel:
//   KV_REST_API_URL / KV_REST_API_TOKEN   (las crea Vercel al conectar Upstash)
//   o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   ADMIN_USER / ADMIN_PASSWORD           (las mismas del login)
//   CLUB_META (opcional, sellos para el premio; por defecto 5)

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const META = parseInt(process.env.CLUB_META || '5', 10);
const CODIGO_SEG = 300; // el código vence a los 5 minutos

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
function normTel(t) {
  let d = soloDigitos(t);
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 8 && d.length <= 13 ? d : null;
}
function hoyAR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
const esAdmin = (b) =>
  !!process.env.ADMIN_PASSWORD &&
  b.usuario === process.env.ADMIN_USER &&
  b.password === process.env.ADMIN_PASSWORD;

async function cliente(tel) {
  const arr = (await redis('HGETALL', `club:cli:${tel}`)) || [];
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  if (!arr.length) return null;
  return { nombre: o.nombre || '', cumple: o.cumple || '', email: o.email || '', sellos: parseInt(o.sellos || '0', 10), canjes: parseInt(o.canjes || '0', 10) };
}

async function limite(clave, max, seg) {
  const n = await redis('INCR', clave);
  if (n === 1) await redis('EXPIRE', clave, seg);
  return n > max;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  if (!URL_ || !TOKEN) return res.status(500).json({ ok: false, error: 'Falta conectar la base de datos del Club.' });

  const b = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();

  try {
    switch (b.action) {
      // ---------- CLIENTE ----------
      case 'consultar': {
        if (await limite(`club:rl:c:${ip}`, 40, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        const tel = normTel(b.tel);
        if (!tel) return res.status(400).json({ ok: false, error: 'Revisá el celular: poné el número completo con código de área.' });
        const c = await cliente(tel);
        return res.json({ ok: true, meta: META, existe: !!c, nombre: c ? c.nombre.split(' ')[0] : '', sellos: c ? c.sellos : 0 });
      }

      case 'registrar': {
        if (await limite(`club:rl:r:${ip}`, 10, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        const tel = normTel(b.tel);
        const nombre = String(b.nombre || '').trim().slice(0, 40);
        if (!nombre) return res.status(400).json({ ok: false, error: 'Poné tu nombre.' });
        if (!tel) return res.status(400).json({ ok: false, error: 'Revisá el celular: poné el número completo con código de área.' });
        const k = `club:cli:${tel}`;
        const ya = await cliente(tel);
        if (ya && ya.nombre) return res.json({ ok: true, meta: META, yaEstaba: true, nombre: ya.nombre.split(' ')[0], sellos: ya.sellos });
        await redis('HSET', k, 'nombre', nombre);
        const cumple = String(b.cumple || '').match(/^(\d{1,2})\/(\d{1,2})$/);
        if (cumple && +cumple[1] >= 1 && +cumple[1] <= 31 && +cumple[2] >= 1 && +cumple[2] <= 12)
          await redis('HSET', k, 'cumple', `${cumple[1].padStart(2, '0')}/${cumple[2].padStart(2, '0')}`);
        const email = String(b.email || '').trim().slice(0, 80);
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) await redis('HSET', k, 'email', email);
        await redis('HSETNX', k, 'alta', Date.now());
        await redis('HSETNX', k, 'sellos', 0);
        await redis('ZADD', 'club:clientes', Date.now(), tel);
        return res.json({ ok: true, meta: META, yaEstaba: false, nombre: nombre.split(' ')[0], sellos: ya ? ya.sellos : 0 });
      }

      case 'sumar': {
        if (await limite(`club:rl:s:${ip}`, 15, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        const tel = normTel(b.tel);
        const codigo = soloDigitos(b.codigo);
        if (!tel) return res.status(400).json({ ok: false, error: 'Revisá el celular: poné el número completo con código de área.' });
        if (codigo.length !== 6) return res.status(400).json({ ok: false, error: 'El código tiene 6 números.' });

        const diaKey = `club:dia:${tel}:${hoyAR()}`;
        if (await redis('EXISTS', diaKey)) return res.status(409).json({ ok: false, error: 'Ya sumaste un sello hoy. ¡Volvé mañana!' });

        const valido = await redis('GETDEL', `club:cod:${codigo}`);
        if (!valido) return res.status(400).json({ ok: false, error: 'Ese código no es válido o ya se usó. Pedí uno nuevo en el local.' });

        await redis('SET', diaKey, '1', 'EX', 26 * 3600);
        const nombre = String(b.nombre || '').trim().slice(0, 40);
        if (nombre) await redis('HSETNX', `club:cli:${tel}`, 'nombre', nombre);
        await redis('HSETNX', `club:cli:${tel}`, 'alta', Date.now());
        const sellos = await redis('HINCRBY', `club:cli:${tel}`, 'sellos', 1);
        await redis('ZADD', 'club:clientes', Date.now(), tel);
        return res.json({ ok: true, meta: META, sellos, premio: sellos >= META });
      }

      // ---------- ADMIN ----------
      case 'generar': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        for (let i = 0; i < 10; i++) {
          const codigo = String(Math.floor(100000 + Math.random() * 900000));
          const ok = await redis('SET', `club:cod:${codigo}`, '1', 'EX', CODIGO_SEG, 'NX');
          if (ok) return res.json({ ok: true, codigo, vence: CODIGO_SEG });
        }
        return res.status(500).json({ ok: false, error: 'No se pudo generar el código. Probá de nuevo.' });
      }

      case 'ver': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const tel = normTel(b.tel);
        if (!tel) return res.status(400).json({ ok: false, error: 'Celular inválido' });
        const c = await cliente(tel);
        return res.json({ ok: true, meta: META, tel, cliente: c });
      }

      case 'recientes': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const tels = (await redis('ZREVRANGE', 'club:clientes', 0, 29)) || [];
        const lista = [];
        for (const t of tels) { const c = await cliente(t); if (c) lista.push({ tel: t, ...c }); }
        const total = await redis('ZCARD', 'club:clientes');
        return res.json({ ok: true, meta: META, total, lista });
      }

      case 'ajustar': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const tel = normTel(b.tel);
        if (!tel) return res.status(400).json({ ok: false, error: 'Celular inválido' });
        const c = await cliente(tel);
        const k = `club:cli:${tel}`;
        if (b.tipo === 'canjear') {
          if (!c || c.sellos < META) return res.status(400).json({ ok: false, error: 'Todavía no completó la tarjeta.' });
          await redis('HINCRBY', k, 'sellos', -META);
          await redis('HINCRBY', k, 'canjes', 1);
        } else if (b.tipo === 'mas') {
          if (b.nombre) await redis('HSETNX', k, 'nombre', String(b.nombre).slice(0, 40));
          await redis('HINCRBY', k, 'sellos', 1);
        } else if (b.tipo === 'menos') {
          if (!c || c.sellos <= 0) return res.status(400).json({ ok: false, error: 'No tiene sellos para quitar.' });
          await redis('HINCRBY', k, 'sellos', -1);
        } else return res.status(400).json({ ok: false, error: 'Acción inválida' });
        await redis('ZADD', 'club:clientes', Date.now(), tel);
        return res.json({ ok: true, meta: META, tel, cliente: await cliente(tel) });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Acción inválida' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error del servidor. Probá de nuevo en un rato.' });
  }
}
