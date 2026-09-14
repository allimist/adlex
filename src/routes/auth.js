import { Router } from 'express';
import * as users from '../services/users.js';
import { flash } from '../lib/http.js';

export const authRouter = Router();

authRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Log in', error: null, email: '' });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await users.verifyLogin(email, password);
  if (!user) {
    return res.status(401).render('auth/login', { title: 'Log in', error: 'Invalid email or password', email: email || '' });
  }
  const returnTo = req.session.returnTo;
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = user.id;
  res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : '/');
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('adlex.sid');
    res.redirect('/login');
  });
});
