const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Bot de egresos activo ✅');
});

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    fecha: { type: ['string', 'null'] },
    hora: { type: ['string', 'null'] },
    monto: { type: ['string', 'null'] },
    moneda: { type: ['string', 'null'] },
    banco_origen: { type: ['string', 'null'] },
    cuenta_origen: { type: ['string', 'null'] },
    titular_origen: { type: ['string', 'null'] },
    banco_destino: { type: ['string', 'null'] },
    cuenta_destino: { type: ['string', 'null'] },
    destinatario: { type: ['string', 'null'] },
    concepto: { type: ['string', 'null'] },
    motivo: { type: ['string', 'null'] },
    referencia: { type: ['string', 'null'] },
    clave_rastreo: { type: ['string', 'null'] },
    folio: { type: ['string', 'null'] },
  },
  required: [
    'fecha', 'hora', 'monto', 'moneda', 'banco_origen', 'cuenta_origen',
    'titular_origen', 'banco_destino', 'cuenta_destino', 'destinatario',
    'concepto', 'motivo', 'referencia', 'clave_rastreo', 'folio',
  ],
  additionalProperties: false,
};

async function extraerComprobante(imageUrl) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.6-terra',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Extrae los datos de este comprobante de transferencia bancaria. Si un dato no aparece en la imagen, devuelve null para ese campo. No inventes información.',
            },
            {
              type: 'input_image',
              image_url: imageUrl,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'comprobante',
          schema: EXTRACTION_SCHEMA,
          strict: true,
        },
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`OpenAI respondió con error: ${JSON.stringify(data)}`);
  }

  const mensaje = data.output?.find((item) => item.type === 'message');
  const textoSalida = mensaje?.content?.find((c) => c.type === 'output_text')?.text;

  if (!textoSalida) {
    throw new Error(`No se encontró texto de salida. Respuesta completa: ${JSON.stringify(data)}`);
  }

  return JSON.parse(textoSalida);
}

app.post('/webhook', async (req, res) => {
  console.log('--- Webhook recibido ---');

  const messages = req.body.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue;

    if (msg.type === 'text') {
      console.log(`Texto recibido de ${msg.from}: "${msg.text?.body}"`);
    }

    if (msg.type === 'image' && msg.image?.link) {
      console.log(`Imagen recibida de ${msg.from}. Analizando con OpenAI...`);
      try {
        const datos = await extraerComprobante(msg.image.link);
        console.log('✅ Datos extraídos por OpenAI:');
        console.log(JSON.stringify(datos, null, 2));
      } catch (err) {
        console.error('❌ Error analizando la imagen con OpenAI:', err.message);
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
