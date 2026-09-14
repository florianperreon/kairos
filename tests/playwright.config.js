// Tests du portail Kairos.
// La page est ouverte en file:// : dans ce mode le portail ne joint pas Supabase (garde explicite
// dans initSync), donc les tests sont déterministes et ne dépendent d'aucun réseau.
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { timezoneId: 'Europe/Paris', locale: 'fr-FR' },
});
