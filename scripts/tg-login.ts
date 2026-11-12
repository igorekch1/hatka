/**
 * Одноразовый вход в Telegram для чтения каналов.
 * Запуск: npm run tg-login  → в конце печатает строку TG_SESSION для .env
 *
 * Два способа:
 *  1) QR-код (по умолчанию): сканируете телефоном в Telegram → Настройки → Устройства →
 *     «Подключить устройство». Никаких кодов.
 *  2) Код по номеру: скрипт показывает, КУДА Telegram отправил код (приложение / SMS /
 *     почта / звонок), и по пустому Enter просит отправить ещё раз другим способом.
 *
 * ⚠️ Строка сессии = полный доступ к аккаунту. Храните её только в .env,
 * никому не отправляйте и не коммитьте в git. Отозвать: Telegram → Настройки →
 * Устройства → завершить сеанс «hatka».
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createRequire } from 'node:module';
import { loadGramJs } from '../src/sources/telegram.ts';

const qrcode = createRequire(import.meta.url)('qrcode-terminal');

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);

const apiId = Number(process.env.TG_API_ID || (await ask('api_id (с my.telegram.org): ')));
const apiHash = process.env.TG_API_HASH || (await ask('api_hash: '));
if (!apiId || !apiHash) {
  console.error('Нужны TG_API_ID и TG_API_HASH (в .env или ввести вручную).');
  process.exit(1);
}

const { TelegramClient, StringSession, Api } = await loadGramJs();
const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
  deviceModel: 'hatka',
});
client.setLogLevel?.('error');
console.log('Подключаюсь к Telegram…');
await client.connect();

function done(): never {
  console.log('\n✅ Готово. Добавьте в .env строку:\n');
  console.log(`TG_SESSION=${client.session.save()}\n`);
  void client.disconnect();
  rl.close();
  process.exit(0);
}

const askPassword = (hint?: string) => ask(`Пароль двухэтапной проверки (2FA)${hint ? ` — подсказка: ${hint}` : ''}: `);

const mode = (await ask('\nКак войти?\n  1 — QR-код (рекомендую, без кодов)\n  2 — код по номеру телефона\nВыбор [1]: ')).trim();
if (mode !== '2') {
  console.log('\nНа телефоне: Telegram → Настройки → Устройства → «Подключить устройство» → наведите камеру на QR.');
  console.log('QR обновляется каждые ~30 секунд — сканируйте последний.\n');
  try {
    await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async ({ token }: { token: Buffer }) => {
          const url = `tg://login?token=${token.toString('base64url')}`;
          qrcode.generate(url, { small: true }, (q: string) => console.log(`${q}\n(ждём сканирования…)\n`));
        },
        password: askPassword,
        onError: async (e: any) => {
          console.log(`Не подошло: ${e?.errorMessage ?? e}`);
          return false;
        },
      },
    );
    done();
  } catch (err: any) {
    console.error(`\n⛔ Вход по QR не удался: ${err?.errorMessage ?? err}. Запустите снова и выберите 2 — вход по коду.`);
    process.exit(1);
  }
}

const phone = (await ask('Телефон (+380…): ')).replace(/[^\d+]/g, '');

/** Человеческое описание способа доставки кода */
function where(t: any): string {
  const A = Api.auth;
  if (!t) return 'неизвестно';
  if (t instanceof A.SentCodeTypeApp) return '📱 в приложение Telegram — чат «Telegram» с синей галочкой (на любом вашем устройстве, где вы залогинены)';
  if (t instanceof A.SentCodeTypeSms) return `💬 SMS на ${phone}`;
  if (A.SentCodeTypeEmailCode && t instanceof A.SentCodeTypeEmailCode) return `📧 на почту ${t.emailPattern} (проверьте и «Спам»)`;
  if (A.SentCodeTypeSetUpEmailRequired && t instanceof A.SentCodeTypeSetUpEmailRequired)
    return '📧 Telegram требует сначала привязать почту для входа — сделайте это в приложении (Настройки → Конфиденциальность → Email для входа) и запустите скрипт снова';
  if (t instanceof A.SentCodeTypeCall) return '📞 звонком — код продиктуют';
  if (t instanceof A.SentCodeTypeFlashCall) return '📞 сброшенным звонком — код это номер, с которого звонили';
  if (A.SentCodeTypeMissedCall && t instanceof A.SentCodeTypeMissedCall)
    return `📞 пропущенным звонком — код это последние ${t.length} цифр номера, который позвонит (начинается с ${t.prefix})`;
  if (A.SentCodeTypeFragmentSms && t instanceof A.SentCodeTypeFragmentSms) return `💬 через Fragment: ${t.url}`;
  if (A.SentCodeTypeFirebaseSms && t instanceof A.SentCodeTypeFirebaseSms) return `💬 SMS на ${phone}`;
  return `способ «${t.className}»`;
}

const NEXT: Record<string, string> = {
  'auth.CodeTypeSms': 'SMS',
  'auth.CodeTypeCall': 'звонок',
  'auth.CodeTypeFlashCall': 'сброшенный звонок',
  'auth.CodeTypeMissedCall': 'пропущенный звонок',
  'auth.CodeTypeFragmentSms': 'SMS через Fragment',
};

function report(sent: any) {
  console.log(`\nКод отправлен: ${where(sent.type)}`);
  if (sent.nextType) {
    const next = NEXT[sent.nextType.className] ?? sent.nextType.className;
    console.log(`Если не пришёл — нажмите Enter без кода${sent.timeout ? ` (через ~${sent.timeout} с)` : ''}, и Telegram пришлёт ещё раз: ${next}.`);
  } else {
    console.log('Другого способа отправки Telegram не предлагает — ищите код там, куда он отправлен.');
  }
}

function fail(err: any): never {
  const msg: string = err?.errorMessage ?? String(err);
  const hints: Record<string, string> = {
    PHONE_NUMBER_INVALID: 'номер введён неверно — нужен формат +380XXXXXXXXX',
    PHONE_NUMBER_BANNED: 'номер заблокирован в Telegram',
    API_ID_INVALID: 'неверные TG_API_ID / TG_API_HASH — проверьте .env',
    PHONE_CODE_EXPIRED: 'код устарел — запустите скрипт заново',
  };
  const wait = msg.match(/FLOOD_WAIT_(\d+)/)?.[1] ?? (err?.seconds ? String(err.seconds) : undefined);
  if (wait || msg.includes('FLOOD'))
    console.error(`\n⛔ Слишком много попыток. Telegram просит подождать${wait ? ` ${Math.ceil(Number(wait) / 60)} мин` : ''} и попробовать снова.`);
  else console.error(`\n⛔ Ошибка: ${msg}${hints[msg] ? ` — ${hints[msg]}` : ''}`);
  process.exit(1);
}

let sent: any;
try {
  sent = await client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId, apiHash, settings: new Api.CodeSettings({}) }));
} catch (err) {
  fail(err);
}
if (Api.auth.SentCodeSuccess && sent instanceof Api.auth.SentCodeSuccess) {
  console.log('Telegram сразу авторизовал этот вход.');
} else {
  report(sent);
  let done = false;
  while (!done) {
    const code = (await ask('\nКод (Enter — отправить ещё раз): ')).replace(/\D/g, '');
    if (!code) {
      try {
        sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash }));
        report(sent);
      } catch (err: any) {
        if (err?.errorMessage === 'SEND_CODE_UNAVAILABLE') console.log('Больше способов отправки нет — ищите уже отправленный код.');
        else fail(err);
      }
      continue;
    }
    try {
      await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code }));
      done = true;
    } catch (err: any) {
      const msg = err?.errorMessage;
      if (msg === 'PHONE_CODE_INVALID') {
        console.log('Неверный код. Введите самый последний полученный код ещё раз.');
      } else if (msg === 'SESSION_PASSWORD_NEEDED') {
        await client.signInWithPassword(
          { apiId, apiHash },
          {
            password: askPassword,
            onError: async (e: any) => {
              console.log(`Не подошло: ${e?.errorMessage ?? e}. Попробуйте ещё раз.`);
              return false;
            },
          },
        );
        done = true;
      } else fail(err);
    }
  }
}

done();
