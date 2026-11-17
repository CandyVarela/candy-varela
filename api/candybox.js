// api/candybox.js — Club Candy Box: inscripción a la membresía mensual con cupos limitados.
// Usa la misma base de datos (Upstash Redis) y el mismo usuario admin que api/club.js.
//
// Para cambiar cupos o fecha de apertura, editá CUPOS y APERTURA acá abajo.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// 16 de noviembre de 2026, 17:00 hora Argentina (= 20:00 UTC)
const APERTURA = Date.UTC(2026, 10, 16, 20, 0, 0);
const CUPOS = { plata: 5, oro: 5 };

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
async function limite(clave, max, seg) {
  const n = await redis('INCR', clave);
  if (n === 1) await redis('EXPIRE', clave, seg);
  return n > max;
}
const limpio = (v) => String(v || '').trim();
function normTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 8 && d.length <= 13 ? d : null;
}
const esAdmin = (b) =>
  !!limpio(process.env.ADMIN_PASSWORD) &&
  limpio(b.usuario).toLowerCase() === limpio(process.env.ADMIN_USER).toLowerCase() &&
  limpio(b.password) === limpio(process.env.ADMIN_PASSWORD);

async function quedan() {
  const [p, o] = await Promise.all([redis('GET', 'candybox:n:plata'), redis('GET', 'candybox:n:oro')]);
  return {
    plata: Math.max(0, CUPOS.plata - parseInt(p || '0', 10)),
    oro: Math.max(0, CUPOS.oro - parseInt(o || '0', 10)),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  if (!URL_ || !TOKEN) return res.status(500).json({ ok: false, error: 'Falta conectar la base de datos.' });
  const b = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();

  try {
    switch (b.action) {
      case 'estado':
        return res.json({ ok: true, apertura: APERTURA, ahora: Date.now(), abierto: Date.now() >= APERTURA, cupos: CUPOS, quedan: await quedan() });

      case 'anotar': {
        if (await limite(`candybox:rl:${ip}`, 8, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        if (Date.now() < APERTURA) return res.status(403).json({ ok: false, error: 'La inscripción todavía no abrió. ¡Volvé el lunes 16 a las 17 hs!' });
        const plan = b.plan === 'oro' ? 'oro' : b.plan === 'plata' ? 'plata' : null;
        const nombre = limpio(b.nombre).slice(0, 80);
        const tel = normTel(b.tel);
        if (!plan) return res.status(400).json({ ok: false, error: 'Elegí Plata u Oro.' });
        if (nombre.split(/\s+/).length < 2) return res.status(400).json({ ok: false, error: 'Poné tu nombre y apellido.' });
        if (!tel) return res.status(400).json({ ok: false, error: 'Revisá el WhatsApp: poné el número completo con código de área.' });

        const nuevo = await redis('SET', `candybox:tel:${tel}`, plan, 'NX');
        if (nuevo !== 'OK') return res.status(409).json({ ok: false, error: 'Ese número ya está anotado. Te vamos a escribir por WhatsApp.' });
        const n = await redis('INCR', `candybox:n:${plan}`);
        if (n > CUPOS[plan]) {
          await redis('DECR', `candybox:n:${plan}`);
          await redis('DEL', `candybox:tel:${tel}`);
          return res.status(409).json({ ok: false, error: `Se agotaron los cupos ${plan === 'oro' ? 'Oro' : 'Plata'}.`, quedan: await quedan() });
        }
        await redis('RPUSH', 'candybox:lista', JSON.stringify({ nombre, tel, plan, fecha: Date.now() }));
        return res.json({ ok: true, plan, quedan: await quedan() });
      }

      case 'espera': {
        if (await limite(`candybox:rl:${ip}`, 8, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        const nombre = limpio(b.nombre).slice(0, 80);
        const tel = normTel(b.tel);
        if (nombre.split(/\s+/).length < 2) return res.status(400).json({ ok: false, error: 'Poné tu nombre y apellido.' });
        if (!tel) return res.status(400).json({ ok: false, error: 'Revisá el WhatsApp: poné el número completo con código de área.' });
        if (await redis('EXISTS', `candybox:tel:${tel}`)) return res.status(409).json({ ok: false, error: 'Ese número ya es miembro del Club Candy Box 💖' });
        const nuevo = await redis('SET', `candybox:esp:${tel}`, '1', 'NX');
        if (nuevo !== 'OK') return res.status(409).json({ ok: false, error: 'Ese número ya está en la lista de espera. ¡Te avisamos!' });
        await redis('RPUSH', 'candybox:espera', JSON.stringify({ nombre, tel, fecha: Date.now() }));
        return res.json({ ok: true });
      }

      case 'agregar': {
        // Alta manual por el admin (excepciones): no usa ni cambia los cupos de la web.
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const plan = b.plan === 'oro' ? 'oro' : 'plata';
        const nombre = limpio(b.nombre).slice(0, 80);
        const tel = normTel(b.tel) || '';
        if (!nombre) return res.status(400).json({ ok: false, error: 'Poné el nombre.' });
        if (tel && (await redis('SET', `candybox:tel:${tel}`, plan, 'NX')) !== 'OK') return res.status(409).json({ ok: false, error: 'Ese número ya está anotado.' });
        await redis('RPUSH', 'candybox:lista', JSON.stringify({ nombre, tel, plan, fecha: Date.now(), manual: true }));
        return res.json({ ok: true });
      }

      case 'lista': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const [arr, esp] = await Promise.all([redis('LRANGE', 'candybox:lista', 0, -1), redis('LRANGE', 'candybox:espera', 0, -1)]);
        return res.json({ ok: true, lista: (arr || []).map((s) => JSON.parse(s)), espera: (esp || []).map((s) => JSON.parse(s)), quedan: await quedan(), cupos: CUPOS });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Acción inválida' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error del servidor. Probá de nuevo en un rato.' });
  }
}
