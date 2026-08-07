import type { AuthUser } from '../modules/auth/auth.service.js';

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

export {};
