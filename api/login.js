// api/login.js
// Esta función corre en el servidor de Vercel, nunca en el navegador.
// La contraseña real se guarda como variable de entorno en Vercel,
// no en el código.

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { usuario, password } = req.body;

  const USUARIO_ADMIN = process.env.ADMIN_USER;     // configurás esto en Vercel
  const PASSWORD_ADMIN = process.env.ADMIN_PASSWORD; // configurás esto en Vercel

  if (usuario === USUARIO_ADMIN && password === PASSWORD_ADMIN) {
    const token = Buffer.from(`${USUARIO_ADMIN}:${Date.now()}:${process.env.TOKEN_SECRET}`).toString('base64');
    return res.status(200).json({ ok: true, token });
  }

  return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
}