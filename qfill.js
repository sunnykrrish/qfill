// quiz-bot.js
// No IMAP. One logged-in browser session does everything.
// Launched by cron at 10:58; polls Gmail until POLL_UNTIL (11:05); on finding
// today's quiz mail it extracts the link, fills the form, (optionally) submits,
// and stamps the day so it never runs twice.
// Node 18+. Run: node quiz-bot.js

import 'dotenv/config';
import { chromium } from 'playwright';
import OpenAI from 'openai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const {
  STABLE_FORM_URL,               // set to skip Gmail entirely if the URL never changes
  QUIZ_SENDER,                   // e.g. quizmaster@company.com
  QUIZ_SUBJECT,                  // e.g. Daily Quiz
  GMAIL_USER_INDEX = '0',        // /mail/u/<index>/ — 0 if the org account is the only one signed in
  POLL_INTERVAL_MS = '100',      // sleep between checks (~100-200ms per poll cycle)
  POLL_UNTIL = '11:05',          // stop polling at this local time (HH:MM)
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  USER_DATA_DIR = './.chrome-profile',
  HEADLESS = 'false',
  AUTO_SUBMIT = 'false',
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signInWall = (url) => /accounts\.google\.com|ServiceLogin|signin/i.test(url);

// ---- once-per-day guard -----------------------------------------------------
const STAMP = './.last-run';
const today = () => new Date().toISOString().slice(0, 10);
const alreadyDoneToday = () => {
  try { return existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === today(); }
  catch { return false; }
};
const markDoneToday = () => { try { writeFileSync(STAMP, today()); } catch {} };

const deadlineToday = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

// ---------------------------------------------------------------------------
// 1. Poll Gmail (in the logged-in session) until the quiz mail shows up, then
//    open it and pull out the Forms link.
// ---------------------------------------------------------------------------
function searchUrl() {
  const parts = [];
//   parts.push('in:anywhere')
  if (QUIZ_SENDER) parts.push(`from:${QUIZ_SENDER}`);
  if (QUIZ_SUBJECT) parts.push(`subject:(${QUIZ_SUBJECT})`);
  parts.push('newer_than:1d');
  return `https://mail.google.com/mail/u/${GMAIL_USER_INDEX}/#search/${encodeURIComponent(parts.join(' '))}`;
}

async function quizRowPresent(page) {
  try {
    return (await page.locator('tr.zA').count()) > 0;
  } catch {
    return false;
  }
}

async function pollGmailForFormUrl(page) {
  await page.goto(searchUrl(), { waitUntil: 'domcontentloaded' });
  if (signInWall(page.url())) return { needsLogin: true };

  // Wait for Gmail UI shell to render before polling search results
  try {
    await page.waitForSelector('div[role="main"], input[name="q"]', { timeout: 15000 });
  } catch {}

  const deadline = deadlineToday(POLL_UNTIL);
  const interval = Number(POLL_INTERVAL_MS);

  while (Date.now() <= deadline) {
    const found = await quizRowPresent(page);
    if (found) {
      await page.locator('tr.zA').first().click();
      await page.waitForSelector('.a3s', { timeout: 15000 });
      const url = await page.evaluate(() => {
        const scopes = document.querySelectorAll('.a3s');
        const anchors = [];
        (scopes.length ? scopes : [document]).forEach((s) =>
          anchors.push(...s.querySelectorAll('a[href]'))
        );
        for (const a of anchors) {
          let href = a.href;
          try {
            const u = new URL(href);
            if (u.hostname === 'www.google.com' && u.pathname === '/url') {
              href = u.searchParams.get('q') || href;
            }
          } catch {}
          if (/(docs\.google\.com\/forms|forms\.gle)/.test(href)) return href;
        }
        return null;
      });
      return { url };
    }

    await sleep(interval);

    // Refresh search results within Gmail SPA without forcing a full page reload
    const searchInput = page.locator('input[name="q"]');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.focus().catch(() => {});
      await searchInput.press('Enter').catch(() => {});
    } else {
      await page.goto(searchUrl(), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('div[role="main"], input[name="q"]', { timeout: 10000 }).catch(() => {});
    }
  }

  return { url: null };
}

// ---------------------------------------------------------------------------
// 2. LLM: one answer per line, order preserved, no bullets/numbering.
// ---------------------------------------------------------------------------
async function getAnswers(questions) {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const prompt =
    'Answer each quiz question below. Rules:\n' +
    '- Output exactly one answer per line.\n' +
    '- Keep the same order as the questions.\n' +
    '- No numbering, no bullets, no labels, no commentary.\n' +
    '- For fill-in-the-blank, output only the missing word/phrase.\n\n' +
    `Questions:\n${numbered}`;

  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const answers = (res.choices[0].message.content || '')
    .trim()
    .split('\n')
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (answers.length !== questions.length) {
    console.warn(`⚠️  Got ${answers.length} answers for ${questions.length} questions — verify before submit.`);
  }
  return answers;
}

// ---------------------------------------------------------------------------
// 3. Open the form, pair each question with its input (in order), fill.
//    Returns true only if it actually submitted.
// ---------------------------------------------------------------------------
async function fillForm(page, formUrl) {
  await page.goto(formUrl, { waitUntil: 'domcontentloaded' });
  if (signInWall(page.url())) {
    console.log('🔒 Google is asking to sign in — the saved session expired.');
    console.log('   Re-run with HEADLESS=false, sign in with your ORG account, then retry.');
    return false;
  }
  await page.waitForSelector('div[role="listitem"]');

  // Tick "Record email" checkbox if present and not already checked
  try {
    const recordCheckbox = page
      .locator('[role="checkbox"], input[type="checkbox"]')
      .filter({ hasText: /record (.* as the email|.* response|the response|.*@)/i })
      .first();

    const recordByRole = page
      .getByRole('checkbox', { name: /record (.* as the email|.* response|the response|.*@)/i })
      .first();

    let target = null;
    if ((await recordCheckbox.count()) > 0 && (await recordCheckbox.isVisible().catch(() => false))) {
      target = recordCheckbox;
    } else if ((await recordByRole.count()) > 0 && (await recordByRole.isVisible().catch(() => false))) {
      target = recordByRole;
    }

    if (target) {
      const isChecked =
        (await target.getAttribute('aria-checked')) === 'true' ||
        (await target.isChecked().catch(() => false));
      if (!isChecked) {
        await target.click();
        console.log('☑️ Ticked "Record email" checkbox.');
      }
    }
  } catch {
    // Ignore if checkbox is not present on this form
  }

  const items = await page.$$('div[role="listitem"]');
  const pairs = [];
  for (const item of items) {
    const field = await item.$('input[type="text"], textarea');
    if (!field) continue;
    const heading = await item.$('[role="heading"]');
    const q = heading ? (await heading.innerText()).replace(/\s*\*$/, '').trim() : '';
    if (q) pairs.push({ q, field });
  }
  if (!pairs.length) {
    console.log('No fill-in-the-blank fields found — check the form / signed-in account.');
    return false;
  }

  const answers = await getAnswers(pairs.map((p) => p.q));
  for (let i = 0; i < pairs.length; i++) {
    await pairs[i].field.fill(answers[i] ?? '');
  }

  if (AUTO_SUBMIT === 'true') {
    await page.getByRole('button', { name: /submit/i }).click();
    await page.waitForTimeout(1500);
    console.log('✅ Submitted.');
    return true;
  }
  console.log('✅ Filled. Review, then submit manually. (Set AUTO_SUBMIT=true to auto-submit.)');
  return false;
}

// ---------------------------------------------------------------------------
async function main() {
  if (alreadyDoneToday()) {
    console.log('Already handled today — exiting.');
    return;
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS === 'true',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    let formUrl = STABLE_FORM_URL;
    if (!formUrl) {
      const res = await pollGmailForFormUrl(page);
      if (res.needsLogin) {
        console.log('🔒 Not signed in to Gmail. Run with HEADLESS=false and sign in with your ORG account.');
        return;
      }
      formUrl = res.url;
    }
    if (!formUrl) {
      console.log('No quiz mail appeared before the deadline. Exiting.');
      return;
    }
    console.log('Form:', formUrl);
    const submitted = await fillForm(page, formUrl);
    if (submitted) markDoneToday();
  } finally {
    const reviewMode = HEADLESS !== 'true' && AUTO_SUBMIT !== 'true';
    if (!reviewMode) await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});