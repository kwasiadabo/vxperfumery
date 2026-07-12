require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const routes = require('./routes');
const { sequelize } = require('./models');
const swaggerSpec = require('./config/swagger');

const app = express();

// CLIENT_URL may be a single origin or a comma-separated list (local dev + deployed frontend)
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
}));
// Keep the raw body around — Paystack webhook signatures are computed over the raw payload
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'VX Perfumery API Docs' }));
app.use('/api', routes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const port = process.env.PORT || 5000;

async function start() {
  try {
    await sequelize.authenticate();
    console.log('✓ MSSQL connection established');
  } catch (err) {
    console.error('✗ Could not connect to MSSQL — check .env DB settings:', err.message);
  }
  app.listen(port, () => console.log(`VX Perfumery API running on http://localhost:${port}`));
}

start();
