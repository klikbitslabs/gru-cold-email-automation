import { createApp } from './app.js';
import { config, googleConfigured, jevConfigured } from './config.js';
import { openDatabase } from './db.js';
import { createScheduler } from './services/scheduler.js';

const db = openDatabase();
const scheduler = createScheduler({ db });
const app = createApp({ db, scheduler });

app.listen(config.port, () => {
  console.log(`Outreach listo en ${config.baseUrl} (puerto ${config.port})`);
  console.log(`  Google OAuth: ${googleConfigured() ? 'configurado' : 'FALTA GOOGLE_CLIENT_ID/SECRET'}`);
  console.log(`  Jev (TypeSafe): ${jevConfigured() ? `activo (${config.typesafe.model})` : 'sin TYPESAFE_API_KEY → decisiones por reglas'}`);
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
