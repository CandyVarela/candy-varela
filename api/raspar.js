// api/raspar.js
// Corre en el servidor de Vercel. El cliente nunca decide si gana ni genera el código.
// Los códigos y el pozo se guardan en data/codes.json dentro del repo de GitHub.

const OWNER = 'CandyVarela';
const REPO = 'candy-varela';
const FILE_PATH = 'data/codes.json';
const WIN_CHANCE = 0.18; // probabilidad por intento, limitada siempre por el pozo total

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return 'CV-' + c;
}

async function githubGet() {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`,
    { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
  );
  if (!r.ok) throw new Error('No se pudo leer codes.json');
  const data = await r.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString());
  return { content, sha: data.sha };
}

async function githubPut(content, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha,
  };
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('No se pudo guardar codes.json: ' + errText);
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { telefono } = req.body || {};
  if (!telefono || String(telefono).trim().length < 6) {
    return res.status(400).json({ error: 'Falta un teléfono válido' });
  }
  const tel = String(telefono).trim();

  try {
    const { content, sha } = await githubGet();

    if (content.playedPhones.includes(tel)) {
      return res.status(200).json({ ok: true, yaJugo: true });
    }

    const remaining = content.totalPool - content.issued.length;
    let win = false;
    let code = null;

    if (remaining > 0 && Math.random() < WIN_CHANCE) {
      win = true;
      code = genCode();
      content.issued.push({
        code,
        telefono: tel,
        ts: Date.now(),
        redeemed: false,
      });
    }

    content.playedPhones.push(tel);

    await githubPut(content, sha, `Raspadita: jugada de ${tel} (${win ? 'ganó ' + code : 'sin premio'})`);

    return res.status(200).json({ ok: true, yaJugo: false, win, code });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
