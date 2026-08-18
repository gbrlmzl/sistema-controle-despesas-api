import { Router } from 'express';
import { env, googleAuthEnabled } from '../../config/env.js';
import passport from '../../config/passport.js';
import { loginLimiter, refreshLimiter, registerLimiter } from '../../middlewares/rateLimit.js';
import { validateBody } from '../../middlewares/validate.js';
import { loginSchema, registerSchema } from '../../schemas/usuarios.js';
import { googleCallback, login, logout, refresh, register } from '../../controllers/auth/authController.js';

const router = Router();

// SEC-01 -> Os limitadores vêm antes do validateBody de propósito: uma tentativa de
// força bruta não deve conseguir gastar nem o custo da validação do schema.
router.post('/register', registerLimiter, validateBody(registerSchema), register);
router.post('/login', loginLimiter, validateBody(loginSchema), login);
router.post('/refresh', refreshLimiter, refresh);
// logout é barato (um UPDATE) e coberto pelo limitador global — sem limite próprio,
// pra não impedir alguém de encerrar a própria sessão.
router.post('/logout', logout);

// Só existe se as credenciais do Google estiverem configuradas (ver src/config/env.ts).
if (googleAuthEnabled) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

  router.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: `${env.FRONTEND_URL}/login?error=oauth` }),
    googleCallback,
  );
}

export default router;
