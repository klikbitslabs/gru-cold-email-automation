import { createApp } from './app.js';
import { config } from './config.js';
import { googleConfigured, integrations, jevConfigured } from './services/settings.js';
import { openDatabase } from './db.js';
import { createScheduler } from './services/scheduler.js';

const db = openDatabase();
const scheduler = createScheduler({ db });
const app = createApp({ db, scheduler });

app.listen(config.port, () => {
  console.log(`Outreach listo en ${config.baseUrl} (puerto ${config.port})`);
  console.log(`  Google OAuth: ${googleConfigured() ? 'configurado' : 'pendiente (configúralo en Integraciones)'}`);
  console.log(`  Jev (TypeSafe): ${jevConfigured() ? `activo (${integrations.typesafe().model})` : 'sin API key → decisiones por reglas (configúralo en Integraciones)'}`);
  if (config.scheduler.enabled) {
    scheduler.start();
    console.log(`  Scheduler: cada ${config.scheduler.intervalSeconds}s`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler.stop();
    db.close();
    process.exit(0);
  });
}
