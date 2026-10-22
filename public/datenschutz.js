import { api } from './common.js';

api('/api/config').then((cfg) => {
  if (cfg.privacyContact) document.getElementById('kontakt').textContent = cfg.privacyContact;
}).catch(() => {});
