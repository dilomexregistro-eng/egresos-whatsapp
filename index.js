const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

// Endpoint de salud, para confirmar que Railway levantó el servicio
app.get('/', (req, res) => {
  res.send('Bot de egresos activo ✅');
});

// Endpoint que recibirá el webhook de Whapi.Cloud
app.post('/webhook', (req, res) => {
  console.log('--- Webhook recibido ---');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
