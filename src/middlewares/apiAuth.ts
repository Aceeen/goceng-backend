import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

export const apiAuth = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== env.INTERNAL_API_KEY) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or missing Internal API Key' } });
  }
  
  next();
};
