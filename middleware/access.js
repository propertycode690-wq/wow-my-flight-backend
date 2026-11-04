const managementPaths = ['/permission-control', '/permission-management', '/finance', '/audit-trail', '/management-reports', '/automation'];
function enforceRole(req, res, next) {
  if (!req.user) return next(); // Public webhooks have their own signature checks.
  const path = req.path;
  const admin = ['super_admin', 'admin'].includes(req.user.role);
  if (managementPaths.some(prefix => path === prefix || path.startsWith(prefix + '/')) && !admin) {
    return res.status(403).json({ success: false, error: 'Administrator access required' });
  }
  if (path.startsWith('/settings') && !['GET', 'HEAD'].includes(req.method) && !admin) {
    return res.status(403).json({ success: false, error: 'Administrator access required' });
  }
  if ((path.startsWith('/permission-control') || path.startsWith('/permission-management')) && !['GET', 'HEAD'].includes(req.method) && req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Super admin access required' });
  }
  next();
}
module.exports = { enforceRole };
