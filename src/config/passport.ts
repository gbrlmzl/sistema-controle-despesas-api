import passport from 'passport';
import GoogleStrategy from 'passport-google-oidc';
import { env, googleAuthEnabled } from './env.js';
import { findOrCreateGoogleUser } from '../modules/auth/auth.service.js';

// Sem `passport.session()` de propósito: a API é stateless (JWT em cookie httpOnly),
// então serializeUser/deserializeUser não se aplicam aqui — só existem pra sessão
// persistida em store, que não usamos.
if (googleAuthEnabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: env.GOOGLE_CALLBACK_URL!,
      },
      (issuer: string, profile: passport.Profile, done: (err: Error | null, user?: Express.User) => void) => {
        const email = profile.emails?.[0]?.value;

        // Sem e-mail não há como localizar/criar a conta — o Google sempre manda
        // um nessa integração, isso só protege o tipo do que vem depois.
        if (!email) {
          done(new Error('Google não retornou um email para essa conta.'));
          return;
        }

        findOrCreateGoogleUser({
          id: profile.id,
          displayName: profile.displayName,
          email,
          photo: profile.photos?.[0]?.value,
        })
          .then((user) => done(null, user))
          .catch((err: unknown) => done(err as Error));
      },
    ),
  );
}

export default passport;
