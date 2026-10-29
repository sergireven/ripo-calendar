'use strict';

const { checkPassword, rateLimit } = require('../auth');

module.exports = (app, { db }) => {
  app.get('/entrar', (req, res) => (req.user ? res.redirect('/') : res.render('login', { title: 'Entrar', error: null, email: '' })));

  app.post('/entrar', rateLimit(), (req, res) => {
    const user = checkPassword(db, req.body.email, req.body.password);
    if (!user) return res.status(401).render('login', { title: 'Entrar', error: 'Correu o contrasenya incorrectes.', email: req.body.email || '' });
    const back = req.session.returnTo;
    req.session.regenerate(() => {
      req.session.userId = user.id;
      res.redirect(back && back.startsWith('/') ? back : '/');
    });
  });

  app.post('/sortir', (req, res) => req.session.destroy(() => res.redirect('/entrar')));
};
