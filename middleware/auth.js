const jwt = require('jsonwebtoken');

module.exports = {
  sign(user) {
    return jwt.sign(
      { id: user.id, role: user.role_enum, branch_id: user.branch_id },
      process.env.JWT_SECRET || 'dev_secret',
      { expiresIn: '7d' }
    );
  },

  requireAuth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
      next();
    } catch {
      res.status(401).json({ message: 'Unauthorized' });
    }
  }
};
