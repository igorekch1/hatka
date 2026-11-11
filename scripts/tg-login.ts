/**
 * Одноразовый вход в Telegram для чтения каналов.
 * Запуск: npm run tg-login  → в конце печатает строку TG_SESSION для .env
 *
 * ⚠️ Строка сессии = полный доступ к аккаунту. Храните её только в .env на сервере,
 * никому не отправляйте и не коммитьте в git. Отозвать: Telegram → Настройки →
 * Устройства → завершить сеанс «lviv-flats-radar».
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadGramJs } from '../src/sources/telegram.ts';

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);

const apiId = Number(process.env.TG_API_ID || (await ask('api_id (с my.telegram.org): ')));
const apiHash = process.env.TG_API_HASH || (await ask('api_hash: '));

const { TelegramClient, StringSession } = await loadGramJs();
const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
  deviceModel: 'lviv-flats-radar',
});
client.setLogLevel?.('error');

await client.start({
  phoneNumber: () => ask('Телефон (+380…): '),
  phoneCode: () => ask('Код из Telegram: '),
  password: () => ask('Пароль 2FA (если есть, иначе Enter): '),
  onError: (e: unknown) => console.error(e),
});

console.log('\n✅ Готово. Добавьте в .env строку:\n');
console.log(`TG_SESSION=${client.session.save()}\n`);
await client.disconnect();
rl.close();
process.exit(0);
