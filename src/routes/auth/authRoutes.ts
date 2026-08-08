import { Router } from 'express';
import { googleAuthEnabled } from '../../config/env.js';
import passport from '../../config/passport.js';
import { validateBody } from '../../middlewares/validate.js';
import { loginSchema, registerSchema } from '../../schemas/usuarios.js';
import { googleCallback, login, logout, refresh, register } from '../../controllers/auth/authController.js';

const router = Router();

router.post('/register', validateBody(registerSchema), register);
router.post('/login', validateBody(loginSchema), login);
router.post('/refresh', refresh);
router.post('/logout', logout);

// Só existe se as credenciais do Google estiverem configuradas (ver src/config/env.ts).
if (googleAuthEnabled) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

  router.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/auth/login' }),
    googleCallback,
  );
}

export default router;
