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
import { pathToFileURL } from 'node:url';

const {
  STABLE_FORM_URL,               // set to skip Gmail entirely if the URL never changes
  QUIZ_SENDER,                   // e.g. quizmaster@company.com
  QUIZ_SUBJECT,                  // e.g. Daily Quiz
  GMAIL_USER_INDEX = '0',        // /mail/u/<index>/ — 0 if the org account is the only one signed in
  POLL_INTERVAL_MS = '100',      // sleep between checks (~100-200ms per poll cycle)
  POLL_UNTIL = '11:05',          // stop polling at this local time (HH:MM)
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  WEB_SEARCH = 'true',           // let the model look things up past its training cutoff
  SEARCH_CONTEXT_SIZE = 'low',   // low keeps the extra latency down
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
      console.log("Found quiz row Time:", new Date().toISOString());
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
// 2. LLM: one request per question, answered in parallel, order preserved.
// ---------------------------------------------------------------------------
const humanToday = () =>
  new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

// Web search answers arrive with inline markdown citations; the form wants bare text.
const stripCitations = (s) =>
  s
    .replace(/【[^】]*】/g, '')
    .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// A lone trailing period is sentence punctuation, not part of the answer; keep it
// when the answer has other periods ("Ph.D.", "U.S.A.").
const trimStop = (s) => (/\.$/.test(s) && s.indexOf('.') === s.length - 1 ? s.slice(0, -1) : s);

const firstLine = (raw) =>
  trimStop(
    raw
      .trim()
      .split('\n')
      .map((s) => stripCitations(s.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim()))
      .find(Boolean) || ''
  );

// A forced search echoes the whole prompt back as the query — log the useful part.
const shortQuery = (q) =>
  (q.includes('Question:') ? q.slice(q.lastIndexOf('Question:') + 9) : q).replace(/\s+/g, ' ').trim().slice(0, 70);

// A question the model cannot possibly know from a 2023 cutoff — don't leave the
// decision to the model, make it search.
const NEEDS_FRESH_INFO =
  /\b20(?:2[4-9]|[3-9]\d)\b|\b(current|currently|latest|recent|recently|today|this year|as of|newest|so far)\b/i;

  async function answerOne(qObj) {
    // Support both raw string or structured question object
    const question = typeof qObj === 'string' ? qObj : qObj.question;
    const options = qObj.options || [];
  
    let optionsPrompt = '';
    if (options.length > 0) {
      optionsPrompt = `\nOptions:\n${options.map((o) => `- ${o}`).join('\n')}\nSelect the exact single correct option from the list above.`;
    }
  
    const prompt =
      `Today's date is ${humanToday()}.\n` +
      'Your knowledge cutoff is October 2023. If the answer could have changed or happened ' +
      'after that date, use the web_search tool instead of answering from memory — your ' +
      'memory of anything after October 2023 is unreliable.\n\n' +
      'Answer the quiz question below. Rules:\n' +
      '- Output only the exact answer string, on a single line.\n' +
      '- No commentary, labels, citations, source names, or URLs.\n' +
      (options.length ? '- Matches MUST match one of the provided options verbatim.\n' : '- For fill-in-the-blank, output only the missing word/phrase.\n') +
      `\nQuestion: ${question}${optionsPrompt}`;
  
    if (WEB_SEARCH === 'true') {
      try {
        const res = await openai.responses.create({
          model: OPENAI_MODEL,
          temperature: 0,
          input: prompt,
          tools: [{ type: 'web_search', search_context_size: SEARCH_CONTEXT_SIZE }],
          tool_choice: NEEDS_FRESH_INFO.test(question) ? 'required' : 'auto',
          service_tier: 'priority',
        });
        const search = res.output.find((o) => o.type === 'web_search_call');
        return {
          answer: firstLine(res.output_text || ''),
          searched: Boolean(search),
          query: search?.action?.query || '',
        };
      } catch (e) {
        console.warn('⚠️ Web search call failed, falling back to plain completion:', e.message);
      }
    }
  
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
      service_tier: 'priority',
    });
    return { answer: firstLine(res.choices[0].message.content || ''), searched: false, query: '' };
  }

export async function getAnswers(questions) {
  console.log("Getting answers at:", new Date().toISOString());

  // One request per question. Batching them makes the model take a single global
  // search decision for the whole set, which starves the question that needed it.
  const results = await Promise.all(questions.map(answerOne));

  console.log("Got answers at:", new Date().toISOString());
  const pad = Math.max(...results.map((r) => r.answer.length));
  console.log('Answers:');
  results.forEach((r, i) => {
    const source = r.searched ? `  🔎 web: "${shortQuery(r.query)}"` : '';
    console.log(`  ${i + 1}. ${r.answer.padEnd(pad)}${source}`);
  });

  const blank = results.filter((r) => !r.answer).length;
  if (blank) console.warn(`⚠️  ${blank} question(s) came back empty — verify before submit.`);

  return results.map((r) => r.answer);
}

// ---------------------------------------------------------------------------
// 3. Open the form, pair each question with its input (in order), fill.
//    Returns true only if it actually submitted.
// ---------------------------------------------------------------------------
async function fillForm(page, formUrl) {
  // Use 'commit' navigation so waitForSelector starts as soon as HTTP response streams in
  await page.goto(formUrl, { waitUntil: 'commit' });
  if (signInWall(page.url())) {
    console.log('🔒 Google is asking to sign in — the saved session expired.');
    console.log('   Re-run with HEADLESS=false, sign in with your ORG account, then retry.');
    return false;
  }
  await page.waitForSelector('div[role="listitem"]');

  // Single-pass DOM evaluation: check email checkbox & extract questions
// Single-pass DOM evaluation: check email checkbox & extract questions + options
const { questions, tickedCheckbox } = await page.evaluate(() => {
    let ticked = false;
    const checkboxes = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
    const recordBox = checkboxes.find((c) =>
      /record (.* as the email|.* response|the response|.*@)/i.test(
        c.innerText || c.getAttribute('aria-label') || c.parentElement?.innerText || ''
      )
    );
    if (recordBox) {
      const isChecked = recordBox.getAttribute('aria-checked') === 'true' || recordBox.checked;
      if (!isChecked) {
        recordBox.click();
        ticked = true;
      }
    }
  
    const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
    const qList = [];
  
    items.forEach((item) => {
      const heading = item.querySelector('[role="heading"]');
      if (!heading) return;
  
      const questionText = heading.innerText.replace(/\s*\*$/, '').trim();
      console.log("Question Text:", questionText);
      // Check for Text input
      const textInput = item.querySelector('input[type="text"], textarea');
      if (textInput) {
        qList.push({ type: 'text', question: questionText });
        return;
      }
  
      // Check for Radio / Multiple Choice options
      const radioOptions = Array.from(item.querySelectorAll('[role="radio"]'));
      console.log("Radio Options:", radioOptions);
      if (radioOptions.length > 0) {
        const options = radioOptions
          .map((opt) => opt.getAttribute('aria-label') || opt.innerText || opt.textContent)
          .map((t) => t.trim())
          .filter(Boolean);
        qList.push({ type: 'radio', question: questionText, options });
        return;
      }
  
      // Check for Dropdown
    //   filter(opt => opt.getAttribute('selected') === 'false');
    //   const listbox = item.querySelector('[role="listbox"]')
    //   console.log("Listbox:", listbox);
    //   if (listbox) {
    //     const options = Array.from(item.querySelectorAll('[role="option"]'))
   
    //       .map((opt) => opt.innerText || opt.textContent || opt.getAttribute('data-value'))
    //       .map((t) => t.trim())
    //       .filter((t) => t && !/choose/i.test(t)); // Filter out default "Choose" 
    //     console.log("Options:", options);
    //     qList.push({ type: 'dropdown', question: questionText, options });
    //   }
    });
  
    return { questions: qList, tickedCheckbox: ticked };
  });
//   const listbox = item.querySelector('[role="listbox"]');
//   if (listbox) {
//     listbox.click(); // Open dropdown menu
//     await sleep(200);

//     const options = Array.from(document.querySelectorAll('[role="option"]'));
  if (tickedCheckbox) {
    console.log('☑️ Ticked "Record email" checkbox.');
  }

  if (!questions.length) {
    console.log('No fill-in-the-blank fields found — check the form / signed-in account.');
    return false;
  }

  const answers = await getAnswers(questions);

  // Fast direct DOM fill & instant submit in the same evaluation pass
// Fast direct DOM fill & instant submit pass
const submitted = await page.evaluate(
    async ({ ans, shouldSubmit }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
      let idx = 0;

      for (const item of items) {
        if (ans[idx] === undefined) continue;
        const answerVal = ans[idx].trim().toLowerCase();

        // 1. Text / Textarea Input
        const textInput = item.querySelector('input[type="text"], textarea');
        if (textInput) {
          textInput.value = ans[idx];
          textInput.dispatchEvent(new Event('input', { bubbles: true }));
          textInput.dispatchEvent(new Event('change', { bubbles: true }));
          textInput.dispatchEvent(new Event('blur', { bubbles: true }));
          idx++;
          continue;
        }

        // 2. Radio Button Selection
        const radios = Array.from(item.querySelectorAll('[role="radio"]'));
        if (radios.length > 0) {
          const matchingRadio = radios.find((r) => {
            const label = (r.getAttribute('aria-label') || r.innerText || r.textContent || '').trim().toLowerCase();
            return label === answerVal || label.includes(answerVal) || answerVal.includes(label);
          });

          if (matchingRadio) {
            matchingRadio.click();
          }
          idx++;
          continue;
        }

        // 3. Dropdown Selection
        // const listbox = item.querySelector('[role="listbox"]');
        // if (listbox) {
        //   listbox.click(); // Open dropdown menu
        //   await sleep(200);

        //   const options = Array.from(item.querySelectorAll('[role="option"]'));
        //   console.log("Options:", options);
        //   const matchingOption = options.find((opt) => {
        //     const optText = (opt.innerText || opt.textContent || opt.getAttribute('data-value') || '').trim().toLowerCase();
        //     console.log("Opt Text:", optText);
        //     return optText === answerVal || optText.includes(answerVal) || answerVal.includes(optText);
        //   });
        //   console.log("Matching Option:", matchingOption);
        //   if (matchingOption) {
        //     matchingOption.click();
        //     await sleep(200);
        //   }
        //   idx++;
        //   continue;
        // }
      }

      if (shouldSubmit) {
        const buttons = Array.from(document.querySelectorAll('div[role="button"], button, input[type="submit"]'));
        const submitBtn = buttons.find((b) =>
          /submit|send|vrati/i.test(b.innerText || b.getAttribute('aria-label') || b.value || '')
        );
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
      }
      return false;
    },
    { ans: answers, shouldSubmit: AUTO_SUBMIT === 'true' }
  );

  if (AUTO_SUBMIT === 'true') {
    if (!submitted) {
      // Fallback if DOM click didn't trigger
      await page.getByRole('button', { name: /submit/i }).click();
    }

    console.log('Quiz Submitted at:', new Date().toISOString());
    await page.waitForTimeout(1500);
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

// `node qfill` leaves argv[1] extensionless, so allow the resolved .js form too.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked && (import.meta.url === invoked || import.meta.url === `${invoked}.js`)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}