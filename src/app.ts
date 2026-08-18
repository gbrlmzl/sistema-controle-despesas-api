import cookieParser from 'cookie-parser';
import cookieSession from 'cookie-session';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, googleAuthEnabled } from './config/env.js';
import passport from './config/passport.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { globalLimiter } from './middlewares/rateLimit.js';
import authRoutes from './routes/auth/authRoutes.js';
import residencesRoutes from './routes/residences/residencesRoutes.js';
import expensesRoutes from './routes/expenses/expensesRoutes.js';
import reportsRoutes from './routes/reports/reportsRoutes.js';
import notificationsRoutes from './routes/notifications/notificationsRoutes.js';
import usersRoutes from './routes/users/usersRoutes.js';

const app = express();

// SEC-02 -> Em produção a API fica atrás de um load balancer, então o IP real do
// cliente chega em X-Forwarded-For, não no socket. Sem isso, `req.ip` seria o IP do
// balanceador e o rate limiting por IP colocaria o mundo inteiro no mesmo balde.
//
// O valor é 1 (confia em exatamente um proxy à frente), nunca `true`: confiar na
// cadeia inteira deixaria qualquer cliente forjar o X-Forwarded-For e escapar do
// limite trocando o header a cada requisição.
app.set('trust proxy', 1);

// SEC-05 -> Cabeçalhos de segurança. O que mais importa aqui é o HSTS, já que a API
// vai atender num domínio HTTPS: sem ele, uma primeira requisição em HTTP não recebe
// os cookies de sessão (que são `secure`) e ainda trafega aberta.
app.use(
  helmet({
    // Esta API só devolve JSON, nunca HTML — CSP aqui não protege nada. O CSP que
    // importa é o do front-end.
    contentSecurityPolicy: false,
    hsts: {
      maxAge: 15552000, // 180 dias
      includeSubDomains: true,
      // Entrar na lista de preload do HSTS é praticamente irreversível e vale para o
      // domínio inteiro, incluindo subdomínios que ainda não existem. Fica para depois
      // que todo o ambiente estiver estável em HTTPS.
      preload: false,
    },
  }),
);

// Log de cada requisição recebida (método, path, status, tempo de resposta).
// Silenciado em test pra não poluir a saída do Jest/Supertest.
if (env.NODE_ENV !== 'test') {
  // 'dev' é colorido com códigos ANSI e não traz timestamp nem IP — ilegível no
  // CloudWatch. Em produção, 'combined' (formato Apache) é o que se consegue
  // consultar depois.
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Declarado antes do rate limiting de propósito: quem chama /health é o health check
// do load balancer, e um 429 aqui derrubaria uma instância saudável do balanceamento.
// Também não precisa de CORS nem de body parser.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// SEC-01 -> Teto geral por IP. Os limites mais duros das rotas de auth ficam nas
// próprias rotas (ver routes/auth/authRoutes.ts).
app.use(globalLimiter);

app.use(cors({ credentials: true, origin: env.FRONTEND_URL }));
// SEC-11 -> O default do express.json() já é 100kb, mas deixar explícito documenta a
// intenção e evita que o limite suba sem ninguém perceber. O maior corpo legítimo
// desta API é um PATCH /notifications com uma lista de ids — nada chega perto de 32kb.
app.use(express.json({ limit: '32kb' }));
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

app.use('/auth', authRoutes);
app.use('/residences', residencesRoutes);
app.use('/residences', expensesRoutes);
app.use('/residences', reportsRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/users', usersRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
