/**
 * local.js — local-dev wrapper.
 *
 * In production, this file is NEVER required. The router is mounted directly
 * by /var/www/5s-tracker/server.js (see Phase 4 of OPERATIONS_PORTAL_NEW_APP_GUIDE).
 *
 * In local dev, run `npm start` to host the router on PORT under MOUNT.
 * That mirrors the production URL shape, so the same frontend code works in
 * both environments without any flag-flipping.
 */
require('dotenv').config();
const express = require('express');
const router  = require('./server');

const app  = express();
const PORT = process.env.PORT || 3001;
const MOUNT = '/shopfloor-mistakes';

// Convenience: visiting / redirects to the mounted app.
app.get('/', (_req, res) => res.redirect(MOUNT + '/'));
app.use(MOUNT, router);

app.listen(PORT, () => {
  console.log(`shopfloor-mistake-tracker running at http://localhost:${PORT}${MOUNT}/`);
});
