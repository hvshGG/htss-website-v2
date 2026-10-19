/* For static hosting: set the recipient and, optionally, a same-origin contact API URL.
   Never place SMTP passwords or private API keys in this public file.
   The Node server serves this configuration from environment variables. */
window.HTSS_CONFIG = Object.freeze({
  contactEmail: 'info@htss-co.kz',
  contactPhone: '+77015919386',
  contactEndpoint: '',
  delivery: 'email'
});
