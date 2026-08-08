import cookieParser from 'cookie-parser';
import cookieSession from 'cookie-session';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { env, googleAuthEnabled } from './config/env.js';
import passport from './config/passport.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import residencesRoutes from './modules/residences/residences.routes.js';
import expensesRoutes from './modules/expenses/expenses.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';

const app = express();

app.use(cors({ credentials: true }));
app.use(express.json());
app.use(cookieParser());

// cookie-session só existe pra sobreviver o handshake do OAuth do Google (proteção
// CSRF via "state" do passport-oauth2/openidconnect, que exige req.session). Não é
// usado pra guardar sessão de usuário — isso é o JWT em cookie httpOnly, sempre.
if (googleAuthEnabled) {
  app.use(
    cookieSession({
      name: 'oauth_state',
      secret: env.COOKIE_SESSION_SECRET!,
      maxAge: 10 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
    }),
  );
}
app.use(passport.initialize());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRoutes);
app.use('/residences', residencesRoutes);
app.use('/residences', expensesRoutes);
app.use('/residences', reportsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
