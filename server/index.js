import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { connectDB } from './db.js';
import { config } from './config.js';
import { errorHandler } from './errors.js';
import { authenticate, optionalAuthenticate } from './middleware/auth.js';

// Routes
import authRoutes from './routes/auth.js';
import universesRoutes from './routes/universes.js';
import charactersRoutes from './routes/characters.js';
import knowledgeBasesRoutes from './routes/knowledgeBases.js';
import projectsRoutes from './routes/projects.js';
import pagesRoutes from './routes/pages.js';
import exportsRoutes from './routes/exports.js';
import paymentsRoutes from './routes/payments.js';
import webhooksRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai/index.js';
import aiReview from './routes/project-review.js';
import characterTemplatesRoutes from './routes/characterTemplates.js';
import exportPdfRoutes from './routes/exportPdf.js';

const app = express();

// ─── Security & Logging ──────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(morgan(config.isDev ? 'dev' : 'combined'));

// ─── Body Parsing ────────────────────────────────────────────────────────────
// Stripe webhooks need raw body — mount BEFORE express.json()
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
// 50mb: individual image uploads (upload-image) can be up to ~10MB base64 per image.
// The editor/pages PATCH only carries URLs after sanitization so it stays tiny.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Public Routes ───────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhooksRoutes);
// ─── Protected Routes ────────────────────────────────────────────────────────
app.use('/api/universes', authenticate, universesRoutes);
app.use('/api/characters', authenticate, charactersRoutes);
app.use('/api/knowledge-bases', authenticate, knowledgeBasesRoutes);
app.use('/api/projects', authenticate, projectsRoutes);
app.use('/api/projects', authenticate, pagesRoutes);   // ← page-level editing & approval
app.use('/api/projects', authenticate, aiReview );     // ← review workflow
app.use('/api/projects', authenticate, exportPdfRoutes); // ← Puppeteer PDF export
app.use('/api/exports', authenticate, exportsRoutes);
app.use('/api/payments', authenticate, paymentsRoutes);
app.use('/api/admin', authenticate, adminRoutes);
// /defaults is public (no token needed); all other template routes require auth
app.use('/api/character-templates', optionalAuthenticate, characterTemplatesRoutes);
app.use('/api/ai', authenticate, aiRoutes);

// ─── Error Handler ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  app.listen(config.port, () => {
    console.log(`[SERVER] NoorStudio backend running on port ${config.port} (${config.nodeEnv})`);
  });
}

start();

export default app;