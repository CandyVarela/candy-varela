// api/preventa.js — Preventa Monster Lando Norris: stock compartido entre todos los clientes.
// Usa la misma base de datos (Upstash Redis) y el mismo usuario admin que api/club.js.
//
// Para cambiar el stock total, editá STOCK acá abajo.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const STOCK = 15;
const DISPONIBLE = STOCK;
// Ajuste manual del stock: cuando cambia "id", la próxima visita fija cuántas quedan.
// Después las reservas online siguen descontando normalmente desde ese número.
const AJUSTE = { id: '2026-11-23-quedan8', quedan: 8 };
const K = 'preventa:lando';

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
const esAdmin = (b) =>
  !!limpio(process.env.ADMIN_PASSWORD) &&
  limpio(b.usuario).toLowerCase() === limpio(process.env.ADMIN_USER).toLowerCase() &&
  limpio(b.password) === limpio(process.env.ADMIN_PASSWORD);

async function sincronizar() {
  if ((await redis('GET', `${K}:ajuste`)) === AJUSTE.id) return;
  await redis('SET', `${K}:vendidas`, Math.max(0, DISPONIBLE - AJUSTE.quedan));
  await redis('SET', `${K}:ajuste`, AJUSTE.id);
}

async function quedan() {
  const v = parseInt((await redis('GET', `${K}:vendidas`)) || '0', 10);
  return Math.max(0, DISPONIBLE - v);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  if (!URL_ || !TOKEN) return res.status(500).json({ ok: false, error: 'Falta conectar la base de datos.' });
  const b = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();

  try {
    await sincronizar();
    switch (b.action) {
      case 'estado':
        return res.json({ ok: true, stock: STOCK, quedan: await quedan() });

      case 'reservar': {
        if (await limite(`${K}:rl:${ip}`, 6, 600)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá en unos minutos.' });
        const cant = Math.floor(Number(b.cantidad));
        if (!(cant >= 1 && cant <= DISPONIBLE)) return res.status(400).json({ ok: false, error: 'Cantidad inválida.' });
        const n = await redis('INCRBY', `${K}:vendidas`, cant);
        if (n > DISPONIBLE) {
          await redis('DECRBY', `${K}:vendidas`, cant);
          const q = await quedan();
          return res.status(409).json({ ok: false, quedan: q, error: q > 0 ? `Solo quedan ${q} unidades en preventa.` : '¡Se agotó la preventa!' });
        }
        await redis('RPUSH', `${K}:pedidos`, JSON.stringify({ pedido: limpio(b.pedido).slice(0, 20), cantidad: cant, fecha: Date.now() }));
        return res.json({ ok: true, quedan: Math.max(0, DISPONIBLE - n) });
      }

      case 'lista': {
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const arr = (await redis('LRANGE', `${K}:pedidos`, 0, -1)) || [];
        return res.json({ ok: true, stock: STOCK, quedan: await quedan(), pedidos: arr.map((s) => JSON.parse(s)) });
      }

      case 'ajustar': {
        // Admin: fija cuántas unidades se vendieron (ej. para liberar una reserva que no se pagó).
        if (!esAdmin(b)) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
        const v = Math.floor(Number(b.vendidas));
        if (!(v >= 0 && v <= DISPONIBLE)) return res.status(400).json({ ok: false, error: 'Número inválido.' });
        await redis('SET', `${K}:vendidas`, v);
        return res.json({ ok: true, quedan: await quedan() });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Acción inválida' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error del servidor. Probá de nuevo en un rato.' });
  }
}
