// api/validar.js
// Corre en el servidor de Vercel. Valida un código de descuento y lo marca
// como canjeado para que no se pueda volver a usar.

const OWNER = 'CandyVarela';
const REPO = 'candy-varela';
const FILE_PATH = 'data/codes.json';

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

  const { password, code } = req.body || {};

  if (password !== process.env.VALIDATION_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
  }
  if (!code) {
    return res.status(400).json({ ok: false, error: 'Falta el código' });
  }

  try {
    const { content, sha } = await githubGet();
    const entry = content.issued.find(
      (e) => e.code.toUpperCase() === String(code).trim().toUpperCase()
    );

    if (!entry) {
      return res.status(200).json({ ok: true, valido: false, motivo: 'Ese código no existe' });
    }
    if (entry.redeemed) {
      return res.status(200).json({
        ok: true,
        valido: false,
        motivo: `Ya fue canjeado el ${new Date(entry.redeemedTs).toLocaleString('es-AR')}`,
      });
    }

    entry.redeemed = true;
    entry.redeemedTs = Date.now();
    await githubPut(content, sha, `Raspadita: código ${entry.code} canjeado`);

    return res.status(200).json({ ok: true, valido: true, telefono: entry.telefono });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
