import { Request } from 'express';

// Define the shape of our JWT payload as per GOCENG docs
export interface JwtPayload {
  sub: string;             // users.id
  email: string;
  name: string;
  isOnboarded: boolean;
  spreadsheetId: string | null;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      rawBody?: string;
    }
  }
}
