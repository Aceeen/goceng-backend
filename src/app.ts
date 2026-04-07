import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';

// Routers
import webhookRouter from './modules/webhook/webhook.router';
import authRouter from './modules/auth/auth.router';

const app = express();

// Security Headers
app.use(helmet());

// CORS config for frontend domain
app.use(cors({
  origin: env.NODE_ENV === 'production' ? 'https://goceng.app' : '*',
  credentials: true,
}));

// Rate limiting (100 req per 15 min per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, please try again later.' } },
});
app.use(limiter);

// Webhook Router (Needs raw body for signature verification in some implementations, 
// but our config uses standard body with signature checks)
// We mount webhook without the generic express.json if we need raw body, 
// but the specs say we can just verify the secret. 
// For express, we need to preserve raw body to check HMAC.
app.use('/v1/webhook', express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}), webhookRouter);

// Auth Router
app.use('/v1/auth', authRouter);

// Standard JSON body parser for other paths
app.use(express.json());

// Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', time: new Date() });
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
});

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Error Handler]', err);
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'development' ? err.message : 'Internal Server Error',
    }
  });
});

export default app;
