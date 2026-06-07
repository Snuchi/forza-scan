const { chromium } = require('playwright');

const EMAIL = process.env.FORZA_EMAIL;
const PASSWORD = process.env.FORZA_PASSWORD;
const BASE = 'https://forza-wcp.online';
const API = 'https://back.forza-wcp.online';
const MAX_WAIT_MIN = 38;

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!EMAIL || !PASSWORD) {
  console.error('Missing FORZA_EMAIL / FORZA_PASSWORD secrets');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  let bearer = null;
  let scanId = null;

  // Перехватываем Bearer-токен из запросов приложения
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('back.forza-wcp.online')) {
      const a = req.headers()['authorization'];
      if (a && a.startsWith('Bearer ')) bearer = a;
    }
  });

  // Ловим id созданного скана
  page.on('response', async (resp) => {
    try {
      if (resp.request().method() === 'POST' && /\/adv\/log-check\/v2(\?|$)/.test(resp.url())) {
        const body = await resp.json().catch(() => null);
        if (body && body.id) {
          scanId = body.id;
          log('New scan created:', scanId);
        }
      }
    } catch (e) {}
  });

  try {
    log('Opening login page...');
    await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 60000 });

    const emailSelectors = [
      'input[type="email"]',
      'input[formcontrolname="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[type="text"]',
    ];
    let filledEmail = false;
    for (const s of emailSelectors) {
      const el = await page.$(s);
      if (el) { await el.fill(EMAIL); filledEmail = true; break; }
    }
    if (!filledEmail) throw new Error('Email field not found on login page');

    const passEl = await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await passEl.fill(PASSWORD);

    log('Submitting login...');
    const submit = await page.$('button[type="submit"]');
    if (submit) await submit.click();
    else await page.keyboard.press('Enter');

    await page.waitForURL(/\/u\//, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    log('After login URL:', page.url());

    log('Opening advanced monitoring...');
    await page.goto(BASE + '/u/p/advanced-monitoring', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    log('Looking for "New scan with all companies" button...');
    let clicked = false;
    const byRole = page.getByRole('button', { name: /new scan with all companies/i });
    try { await byRole.first().click({ timeout: 15000 }); clicked = true; } catch (e) {}
    if (!clicked) {
      const byText = page.getByText(/new scan with all companies/i);
      try { await byText.first().click({ timeout: 10000 }); clicked = true; } catch (e) {}
    }
    if (!clicked) throw new Error('Scan button not found');
    log('Scan button clicked.');

    // На случай окна подтверждения
    await page.waitForTimeout(1500);
    for (const name of [/^yes$/i, /^confirm$/i, /^ok$/i, /^start$/i, /^scan$/i]) {
      const c = page.getByRole('button', { name });
      if (await c.count()) {
        try { await c.first().click({ timeout: 3000 }); log('Clicked confirm:', name); break; } catch (e) {}
      }
    }

    // Ждём появления id нового скана
    const t0 = Date.now();
    while (!scanId && Date.now() - t0 < 60000) await page.waitForTimeout(1000);
    if (!scanId) log('WARNING: scan id not captured; will track the newest scan.');

    // КЛЮЧЕВОЕ: держим браузер открытым, пока клиентский цикл обходит все компании
    log('Keeping browser open while the scan processes all companies...');
    const deadline = Date.now() + MAX_WAIT_MIN * 60000;
    let done = false, last = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(30000);
      const status = await page.evaluate(async ({ api, id, tok }) => {
        try {
          const r = await fetch(api + '/adv/log-check/v2', { headers: tok ? { Authorization: tok } : {} });
          if (!r.ok) return { httpError: r.status };
          const j = await r.json();
          const items = j.items || [];
          const s = id ? items.find((x) => x.id === id) : items[0];
          if (!s) return { found: false };
          return { found: true, id: s.id, companies: s.scanningCompanies, ok: s.scanningSuccessfully, failed: s.scanningFailed };
        } catch (e) { return { error: String(e) }; }
      }, { api: API, id: scanId, tok: bearer });
      last = status;
      log('progress:', JSON.stringify(status));
      if (status.found && status.companies > 0 && status.ok + status.failed >= status.companies) { done = true; break; }
    }

    log(done ? 'Scan completed successfully.' : 'Timed out waiting. Last status: ' + JSON.stringify(last));
    await page.screenshot({ path: 'result.png' }).catch(() => {});
    await browser.close();
    process.exit(0);
  } catch (err) {
    log('ERROR:', err && err.message ? err.message : String(err));
    try { await page.screenshot({ path: 'error.png', fullPage: true }); } catch (e) {}
    await browser.close();
    process.exit(1);
  }
})();
