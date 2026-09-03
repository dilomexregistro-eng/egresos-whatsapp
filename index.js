const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Bot de egresos activo ✅');
});

app.post('/webhook', async (req, res) => {
  console.log('--- Webhook recibido ---');

  const messages = req.body.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue; // ignoramos mensajes que él mismo envía

    if (msg.type === 'text') {
      console.log(`Texto recibido de ${msg.from}: "${msg.text?.body}"`);
    }

    if (msg.type === 'image' && msg.image?.link) {
      console.log(`Imagen recibida de ${msg.from}. Descargando desde: ${msg.image.link}`);
      try {
        const response = await fetch(msg.image.link);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`✅ Imagen descargada correctamente. Tamaño: ${buffer.length} bytes, mime_type: ${msg.image.mime_type}`);
      } catch (err) {
        console.error('❌ Error descargando la imagen:', err.message);
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
