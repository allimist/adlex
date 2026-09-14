import { Router } from 'express';
import * as users from '../services/users.js';
import { flash } from '../lib/http.js';

export const usersRouter = Router();

usersRouter.get('/', async (req, res) => {
  res.render('users/index', { title: 'Users', rows: await users.list() });
});

usersRouter.get('/new', (req, res) => {
  res.render('users/form', { title: 'New user', item: { email: '', name: '', role: 'user' }, isNew: true, roles: users.ROLES });
});

usersRouter.post('/', async (req, res) => {
  const { email, name, role, password } = req.body;
  try {
    await users.create({ email, name, role, password });
    flash(req, 'success', 'User created');
    res.redirect('/users');
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).render('users/form', { title: 'New user', item: { email, name, role }, isNew: true, roles: users.ROLES, error: err.message });
  }
});

usersRouter.get('/:id/edit', async (req, res) => {
  const item = await users.getById(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'User not found' });
  res.render('users/form', { title: 'Edit user', item, isNew: false, roles: users.ROLES });
});

usersRouter.post('/:id', async (req, res) => {
  const { email, name, role } = req.body;
  try {
    await users.update(req.params.id, { email, name, role }, req.user);
    flash(req, 'success', 'User updated');
    res.redirect('/users');
  } catch (err) {
    if (!err.status) throw err;
    const item = { ...(await users.getById(req.params.id)), email, name, role };
    res.status(err.status).render('users/form', { title: 'Edit user', item, isNew: false, roles: users.ROLES, error: err.message });
  }
});

usersRouter.post('/:id/disable', async (req, res) => {
  await users.setDisabled(req.params.id, true, req.user);
  flash(req, 'success', 'User disabled');
  res.redirect('/users');
});

usersRouter.post('/:id/enable', async (req, res) => {
  await users.setDisabled(req.params.id, false, req.user);
  flash(req, 'success', 'User enabled');
  res.redirect('/users');
});

usersRouter.post('/:id/password', async (req, res) => {
  try {
    await users.resetPassword(req.params.id, req.body.password);
    flash(req, 'success', 'Password updated');
  } catch (err) {
    if (!err.status) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect(`/users/${req.params.id}/edit`);
});
