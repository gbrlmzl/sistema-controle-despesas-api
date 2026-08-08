import type { AuthUser } from '../services/auth/authService.js';

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

export {};
