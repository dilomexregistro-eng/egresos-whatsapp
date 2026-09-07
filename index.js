const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Bot de egresos activo ✅');
});

app.get('/diagnostico', (req, res) => {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64 || '';
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const credentials = JSON.parse(decoded);
    res.json({
      version_de_node: process.version,
      longitud_variable_b64: raw.length,
      longitud_json_decodificado: decoded.length,
      client_email: credentials.client_email,
      private_key_longitud: credentials.private_key.length,
      private_key_inicio: credentials.private_key.slice(0, 30),
      private_key_final: credentials.private_key.slice(-30),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ---------- Google Sheets (autenticación manual, sin librería googleapis) ----------
const SPREADSHEET_ID = '1BgFe384lj58R3pRolR2KeZiDsjMiIevctGVmuaoe880';
const SHEET_NAME = 'Registro';

function base64url(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function obtenerAccessToken() {
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, 'base64').toString('utf-8')
  );

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedClaimSet = base64url(Buffer.from(JSON.stringify(claimSet)));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const privateKeyObject = crypto.createPrivateKey({
    key: credentials.private_key,
    format: 'pem',
    type: 'pkcs8',
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyObject);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Error obteniendo access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function guardarEnSheets(record) {
  const accessToken = await obtenerAccessToken();

  const fila = [
    record.FECHA,
    record.REFERENCIA,
    record.CLASIFICACION,
    record.PLAN_DE_CUENTA,
    record.CLIENTE_PROVEEDOR,
    record.METODO_DE_PAGO,
    record.BANCO,
    record.MONTO,
    record.ESTADO,
    record.FECHA_DE_PAGO,
  ];

  const range = encodeURIComponent(`${SHEET_NAME}!A:J`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: [fila] }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Error de Sheets API: ${JSON.stringify(data)}`);
  }
}

// ---------- Estado en memoria de conversaciones pendientes ----------
const pendientes = new Map();

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
  const montoConMoneda = datos.moneda ? `${datos.monto} ${datos.moneda}` : datos.monto;
  return {
    FECHA: datos.fecha,
    REFERENCIA: datos.referencia,
    CLASIFICACION: null,
    PLAN_DE_CUENTA: null,
    CLIENTE_PROVEEDOR: datos.destinatario,
    METODO_DE_PAGO: datos.cuenta_destino ? 'Transferencia' : 'Efectivo',
    BANCO: bancoResuelto,
    MONTO: montoConMoneda,
    ESTADO: 'COMPLETADO',
    FECHA_DE_PAGO: datos.fecha,
  };
}

function formatearResumen(record) {
  return `📋 Resumen del egreso:

FECHA: ${record.FECHA || '(sin dato)'}
REFERENCIA: ${record.REFERENCIA || '(sin dato)'}
CLASIFICACIÓN: ${record.CLASIFICACION || '(pendiente)'}
PLAN DE CUENTA: ${record.PLAN_DE_CUENTA || '(pendiente)'}
CLIENTE/PROVEEDOR: ${record.CLIENTE_PROVEEDOR || '(sin dato)'}
MÉTODO DE PAGO: ${record.METODO_DE_PAGO}
BANCO: ${record.BANCO || '(sin dato)'}
MONTO: ${record.MONTO || '(sin dato)'}
ESTADO: ${record.ESTADO}
FECHA DE PAGO: ${record.FECHA_DE_PAGO || '(sin dato)'}

¿Es correcto?
1. Sí, guardar
2. No, cancelar`;
}

async function preguntarConfirmacion(chatId, record) {
  pendientes.set(chatId, { step: 'confirmacion', record });
  await enviarMensaje(chatId, formatearResumen(record));
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

    if (msg.type === 'image' && msg.image?.link) {
      console.log(`Imagen recibida de ${msg.from}. Analizando con OpenAI...`);
      try {
        const datos = await extraerComprobante(msg.image.link);
        console.log('Datos crudos extraídos:', JSON.stringify(datos));

        const digitos = (datos.cuenta_origen || '').replace(/\D/g, '');
        const { match, candidatos } = buscarCuenta(digitos);

        if (candidatos.length > 1) {
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
          await preguntarConfirmacion(chatId, pendiente.record);
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
        await preguntarConfirmacion(chatId, pendiente.record);
        continue;
      }

      if (pendiente.step === 'confirmacion') {
        if (texto === '1') {
          try {
            await guardarEnSheets(pendiente.record);
            console.log('✅ EGRESO GUARDADO EN GOOGLE SHEETS:', JSON.stringify(pendiente.record));
            await enviarMensaje(chatId, '✅ Egreso registrado en el Sheet.');
          } catch (err) {
            console.error('❌ Error guardando en Google Sheets:', err.message);
            await enviarMensaje(chatId, '❌ Hubo un error guardando en el Sheet. Avísale a Arturo.');
          }
          pendientes.delete(chatId);
        } else if (texto === '2') {
          console.log('❌ Egreso cancelado por el usuario.');
          await enviarMensaje(chatId, '❌ Registro cancelado. Puedes volver a mandar el comprobante.');
          pendientes.delete(chatId);
        } else {
          await enviarMensaje(chatId, 'Responde 1 (guardar) o 2 (cancelar).');
        }
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
