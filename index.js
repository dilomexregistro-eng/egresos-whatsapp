const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Bot de egresos activo ✅');
});

// ---------- Catálogo de cuentas del negocio ----------
const CUENTAS = [
  { nombre: 'CONSTRUCTORA ALCOME SA DE CV', banco: 'BANBAJIO', numero: '51109290201' },
  { nombre: 'TRANSPORTES DILOMEX SA DE CV', banco: 'BANBAJIO', numero: '457401490201' },
  { nombre: 'TRANSPORTES DILOMEX SA DE CV', banco: 'BBVA', numero: '5374' },
];

function buscarCuenta(digitosDetectados) {
  if (!digitosDetectados) return { match: null, candidatos: [] };
  const candidatos = CUENTAS.filter((c) => c.numero.endsWith(digitosDetectados));
  if (candidatos.length === 1) return { match: candidatos[0], candidatos };
  return { match: null, candidatos };
}

// ---------- Estado en memoria de conversaciones pendientes ----------
const pendientes = new Map(); // chat_id -> { step, record, candidatos }

// ---------- Enviar mensaje de WhatsApp ----------
async function enviarMensaje(chatId, texto) {
  await fetch('https://gate.whapi.cloud/messages/text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    },
    body: JSON.stringify({ to: chatId, body: texto }),
  });
}

// ---------- Extracción con OpenAI ----------
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    fecha: { type: ['string', 'null'] },
    monto: { type: ['string', 'null'] },
    moneda: { type: ['string', 'null'] },
    cuenta_origen: { type: ['string', 'null'] },
    cuenta_destino: { type: ['string', 'null'] },
    destinatario: { type: ['string', 'null'] },
    referencia: { type: ['string', 'null'] },
  },
  required: ['fecha', 'monto', 'moneda', 'cuenta_origen', 'cuenta_destino', 'destinatario', 'referencia'],
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
              text: 'Extrae los datos de este comprobante de transferencia bancaria. Para cuenta_origen y cuenta_destino, incluye todos los dígitos visibles (aunque estén parcialmente enmascarados, ej. "****0201"). Si un dato no aparece en la imagen, devuelve null. No inventes información.',
            },
            { type: 'input_image', image_url: imageUrl },
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

// ---------- Construir el registro final ----------
function construirRegistroBase(datos, bancoResuelto) {
  return {
    FECHA: datos.fecha,
    REFERENCIA: datos.referencia,
    CLASIFICACION: null,
    PLAN_DE_CUENTA: null,
    CLIENTE_PROVEEDOR: datos.destinatario,
    METODO_DE_PAGO: datos.cuenta_destino ? 'Transferencia' : 'Efectivo',
    BANCO: bancoResuelto,
    MONTO: datos.monto,
    MONEDA: datos.moneda,
    ESTADO: 'COMPLETADO',
    FECHA_DE_PAGO: datos.fecha,
  };
}

async function finalizarRegistro(chatId, record) {
  console.log('✅ EGRESO LISTO PARA GUARDAR:');
  console.log(JSON.stringify(record, null, 2));
  await enviarMensaje(chatId, '✅ Egreso registrado con todos los datos capturados.');
  pendientes.delete(chatId);
}

async function preguntarClasificacion(chatId, record) {
  pendientes.set(chatId, { step: 'clasificacion_choice', record });
  await enviarMensaje(
    chatId,
    '¿Quieres capturar la clasificación y el plan de cuenta ahora, o lo dejamos pendiente para llenarlo después en el Excel?\n\n1. Capturar ahora\n2. Dejar pendiente'
  );
}

// ---------- Webhook principal ----------
app.post('/webhook', async (req, res) => {
  console.log('--- Webhook recibido ---');
  const messages = req.body.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue;
    const chatId = msg.chat_id;

    // ----- Mensaje de imagen: inicia un nuevo egreso -----
    if (msg.type === 'image' && msg.image?.link) {
      console.log(`Imagen recibida de ${msg.from}. Analizando con OpenAI...`);
      try {
        const datos = await extraerComprobante(msg.image.link);
        console.log('Datos crudos extraídos:', JSON.stringify(datos));

        const digitos = (datos.cuenta_origen || '').replace(/\D/g, '');
        const { match, candidatos } = buscarCuenta(digitos);

        if (candidatos.length > 1) {
          // Ambigüedad: preguntamos cuál cuenta es
          const opciones = candidatos
            .map((c, i) => `${i + 1}. ${c.nombre} (${c.banco})`)
            .join('\n');
          pendientes.set(chatId, {
            step: 'banco',
            record: construirRegistroBase(datos, null),
            candidatos,
          });
          await enviarMensaje(
            chatId,
            `Detecté una cuenta terminada en ${digitos} pero coincide con más de una cuenta. ¿Cuál es?\n\n${opciones}`
          );
        } else {
          const bancoTexto = match ? `${match.banco} - ${match.nombre}` : null;
          const record = construirRegistroBase(datos, bancoTexto);
          await preguntarClasificacion(chatId, record);
        }
      } catch (err) {
        console.error('❌ Error analizando la imagen con OpenAI:', err.message);
      }
      continue;
    }

    // ----- Mensaje de texto: puede ser respuesta a una pregunta pendiente -----
    if (msg.type === 'text') {
      const texto = (msg.text?.body || '').trim();
      const pendiente = pendientes.get(chatId);

      if (!pendiente) {
        console.log(`Texto recibido de ${msg.from} sin conversación pendiente: "${texto}"`);
        continue;
      }

      if (pendiente.step === 'banco') {
        const idx = parseInt(texto, 10) - 1;
        const elegido = pendiente.candidatos[idx];
        if (!elegido) {
          await enviarMensaje(chatId, 'No reconocí esa opción. Responde con el número de la lista.');
          continue;
        }
        pendiente.record.BANCO = `${elegido.banco} - ${elegido.nombre}`;
        await preguntarClasificacion(chatId, pendiente.record);
        continue;
      }

      if (pendiente.step === 'clasificacion_choice') {
        if (texto === '1') {
          pendientes.set(chatId, { step: 'clasificacion_texto', record: pendiente.record });
          await enviarMensaje(chatId, 'Escribe la clasificación:');
        } else if (texto === '2') {
          await finalizarRegistro(chatId, pendiente.record);
        } else {
          await enviarMensaje(chatId, 'Responde 1 (capturar ahora) o 2 (dejar pendiente).');
        }
        continue;
      }

      if (pendiente.step === 'clasificacion_texto') {
        pendiente.record.CLASIFICACION = texto;
        pendientes.set(chatId, { step: 'plan_cuenta_texto', record: pendiente.record });
        await enviarMensaje(chatId, 'Ahora escribe el plan de cuenta:');
        continue;
      }

      if (pendiente.step === 'plan_cuenta_texto') {
        pendiente.record.PLAN_DE_CUENTA = texto;
        await finalizarRegistro(chatId, pendiente.record);
        continue;
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
