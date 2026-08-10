import cookieParser from 'cookie-parser';
import cookieSession from 'cookie-session';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import morgan from 'morgan';
import { env, googleAuthEnabled } from './config/env.js';
import passport from './config/passport.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import authRoutes from './routes/auth/authRoutes.js';
import residencesRoutes from './routes/residences/residencesRoutes.js';
import expensesRoutes from './routes/expenses/expensesRoutes.js';
import reportsRoutes from './routes/reports/reportsRoutes.js';
import notificationsRoutes from './routes/notifications/notificationsRoutes.js';
import usersRoutes from './routes/users/usersRoutes.js';

const app = express();

// Log de cada requisição recebida (método, path, status, tempo de resposta) no terminal.
// Silenciado em test pra não poluir a saída do Jest/Supertest.
if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.use(cors({ credentials: true, origin: env.FRONTEND_URL }));
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
app.use('/notifications', notificationsRoutes);
app.use('/users', usersRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
