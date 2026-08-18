import { Router } from 'express';
import { env, googleAuthEnabled } from '../../config/env.js';
import passport from '../../config/passport.js';
import {
  forgotPasswordLimiter,
  loginLimiter,
  refreshLimiter,
  registerLimiter,
  resetPasswordLimiter,
} from '../../middlewares/rateLimit.js';
import { validateBody } from '../../middlewares/validate.js';
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, verifyResetTokenSchema } from '../../schemas/usuarios.js';
import {
  forgotPassword,
  googleCallback,
  login,
  logout,
  refresh,
  register,
  resetPassword,
  verifyResetPasswordToken,
} from '../../controllers/auth/authController.js';

const router = Router();

// SEC-01 -> Os limitadores vêm antes do validateBody de propósito: uma tentativa de
// força bruta não deve conseguir gastar nem o custo da validação do schema.
router.post('/register', registerLimiter, validateBody(registerSchema), register);
router.post('/login', loginLimiter, validateBody(loginSchema), login);
router.post('/refresh', refreshLimiter, refresh);
// logout é barato (um UPDATE) e coberto pelo limitador global — sem limite próprio,
// pra não impedir alguém de encerrar a própria sessão.
router.post('/logout', logout);

// Recuperação de senha (docs/plano-recuperacao-de-senha.md). D-10 -> o token sempre
// no corpo, nunca em parâmetro de rota.
router.post('/forgot-password', forgotPasswordLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post(
  '/reset-password/verify',
  resetPasswordLimiter,
  validateBody(verifyResetTokenSchema),
  verifyResetPasswordToken,
);
router.post('/reset-password', resetPasswordLimiter, validateBody(resetPasswordSchema), resetPassword);

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
