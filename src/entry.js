// Entry screen, carried over from the Node server unchanged.

// The default screen: the brand splash, then the one field this proxy exists
// for. Everything is sized in vh so the stack shrinks with the window and the
// cards always clear the wordmark baked into background.png.
export function entryPage(host, routing) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Plutonium Compaxy</title>
<meta name="description" content="A server-side fetch-and-rewrite web proxy. Ask for a site with ?url= and it fetches, rewrites and serves it." />
<meta name="theme-color" content="#050508" />
<meta property="og:title" content="Plutonium Compaxy" />
<meta property="og:description" content="A server-side fetch-and-rewrite web proxy." />
<meta property="og:image" content="/background.png" />
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/favicon.png" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --text:   #f5f5f7;
    --muted:  #9b9ba4;
    --accent: #e8175d;
    --ok:     #3ecf8e;
    --warn:   #f5a524;
    --err:    #f2555a;
    --card:   rgba(6, 6, 10, 0.72);
    --line:   rgba(255, 255, 255, 0.10);
    --mono:   ui-monospace, "SF Mono", "Fira Code", Menlo, monospace;
  }

  html { background: #000; }

  body {
    min-height: 100%;
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* Fixed so the artwork stays put while short screens scroll; bottom-anchored
     so the brand wordmark always sits on the bottom edge, never half-cropped.
     Untinted: the image is drawn exactly as supplied. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: -2;
    background: #000 url("/background.png") center bottom / cover no-repeat;
  }

  .stage {
    min-height: 100svh;
    display: grid;
    align-content: safe center;
    justify-items: center;
    gap: clamp(7px, 1vh, 11px);
    /* background.png is exactly 2:1 and its Plutonium wordmark fills the lower
       third. Under cover the image is max(50vw, 100svh) tall and the artwork
       starts 34.8% of that above the bottom edge, so that band is reserved:
       the cards sit above the brand instead of on top of it. */
    padding:
      clamp(28px, 5vh, 74px)
      clamp(18px, 2vw, 28px)
      calc(max(50vw, 100svh) * 0.348 + 4px)
      clamp(18px, 2vw, 28px);
  }

  .card {
    width: min(100%, 1160px);
    padding: clamp(10px, 1.7vh, 20px) clamp(12px, 2.2vh, 24px);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    backdrop-filter: blur(22px) saturate(130%);
    -webkit-backdrop-filter: blur(22px) saturate(130%);
    box-shadow:
      0 30px 80px -32px rgba(0, 0, 0, 0.95),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  /* ---- 1. title ---------------------------------------------------------- */

  .card--title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(14px, 1.8vw, 24px);
  }
  .card__mark {
    flex: none;
    width: clamp(38px, 5.4vh, 60px);
    height: auto;
    filter: drop-shadow(0 0 20px rgba(232, 23, 93, 0.3));
  }
  .card__eyebrow {
    font-family: var(--mono);
    font-size: clamp(0.76rem, 1.8vh, 0.98rem);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(232, 23, 93, 0.95);
    margin-bottom: clamp(2px, 0.7vh, 6px);
  }
  .card__title {
    font-size: clamp(1.5rem, 5.2vh, 3.2rem);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.05;
  }

  /* ---- 2. search --------------------------------------------------------- */

  .search__label {
    display: block;
    font-family: var(--mono);
    font-size: clamp(0.6rem, 1.35vh, 0.7rem);
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.34);
    margin-bottom: clamp(5px, 1vh, 9px);
  }
  .search__row { display: flex; gap: clamp(8px, 1vw, 12px); }
  .search__input {
    flex: 1 1 auto;
    min-width: 0;
    padding: clamp(9px, 1.6vh, 15px) clamp(12px, 1.2vw, 18px);
    font: inherit;
    font-size: clamp(0.84rem, 1.9vh, 1rem);
    color: var(--text);
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search__input::placeholder { color: rgba(255, 255, 255, 0.28); }
  .search__input:focus-visible {
    border-color: rgba(232, 23, 93, 0.75);
    box-shadow: 0 0 0 4px rgba(232, 23, 93, 0.14);
  }
  .search__go {
    flex: none;
    padding: 0 clamp(16px, 2vw, 26px);
    font: inherit;
    font-size: clamp(0.84rem, 1.9vh, 1rem);
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    background: linear-gradient(180deg, #ef2a6b, #cf0f4e);
    border: 0;
    border-radius: 14px;
    box-shadow: 0 12px 30px -14px rgba(232, 23, 93, 0.9);
    transition: filter 0.15s ease, transform 0.1s ease;
  }
  .search__go:hover { filter: brightness(1.08); }
  .search__go:active { transform: translateY(1px); }
  .search__go:focus-visible {
    outline: 2px solid rgba(232, 23, 93, 0.9);
    outline-offset: 3px;
  }

  /* ---- 3. status -------------------------------------------------------- */

  .status__head {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .status__dot {
    width: clamp(7px, 1.1vh, 9px);
    height: clamp(7px, 1.1vh, 9px);
    flex: none;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 5px rgba(245, 165, 36, 0.14);
  }
  .status__state {
    font-size: clamp(0.92rem, 2vh, 1.22rem);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .status__latency {
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--muted);
  }
  .status__latency:empty { display: none; }
  .status__link {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.74rem;
    color: rgba(255, 255, 255, 0.34);
    text-decoration: none;
    transition: color 0.15s ease;
  }
  .status__link:hover,
  .status__link:focus-visible { color: var(--accent); }

  .status[data-state="ok"] .status__dot {
    background: var(--ok);
    box-shadow: 0 0 0 5px rgba(62, 207, 142, 0.16);
    animation: pulse 2.6s ease-in-out infinite;
  }
  .status[data-state="error"] .status__dot {
    background: var(--err);
    box-shadow: 0 0 0 5px rgba(242, 85, 90, 0.16);
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 5px rgba(62, 207, 142, 0.16); }
    50%      { box-shadow: 0 0 0 8px rgba(62, 207, 142, 0.05); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status[data-state="ok"] .status__dot { animation: none; }
  }

  .checks {
    display: grid;
    /* One column per check, however many /healthz reports: two fill the row,
       more wrap instead of leaving a bare track. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
    gap: clamp(4px, 0.9vh, 8px) 26px;
    margin-top: clamp(7px, 1.5vh, 12px);
    padding-top: clamp(7px, 1.4vh, 11px);
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    list-style: none;
  }
  .checks[hidden] { display: none; }
  .checks li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: clamp(0.72rem, 1.6vh, 0.84rem);
  }
  .checks__name { color: rgba(245, 245, 247, 0.74); }
  .checks__val {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .checks li[data-ok="true"] .checks__val  { color: rgba(62, 207, 142, 0.92); }
  .checks li[data-ok="false"] .checks__val { color: rgba(242, 85, 90, 0.95); }

  .status__foot {
    margin-top: clamp(6px, 1.2vh, 10px);
    font-family: var(--mono);
    font-size: clamp(0.6rem, 1.25vh, 0.68rem);
    color: rgba(255, 255, 255, 0.3);
  }

  /* ---- 4. routing ------------------------------------------------------- */

  .card--routing { display: grid; gap: clamp(6px, 1.2vh, 10px); }
  .routes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .routes li {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 9px;
    font-size: clamp(0.66rem, 1.45vh, 0.76rem);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 999px;
  }
  .routes__host { font-family: var(--mono); color: rgba(245, 245, 247, 0.8); }
  .routes__engine { color: rgba(232, 23, 93, 0.92); }

  /* ---- 5. description --------------------------------------------------- */

  .card__desc {
    max-width: 68ch;
    margin-inline: auto;
    text-align: center;
    color: var(--muted);
    font-size: clamp(0.8rem, 1.7vh, 0.96rem);
    line-height: 1.65;
  }
  .card__desc strong { color: rgba(245, 245, 247, 0.88); font-weight: 550; }

  /* Short, wide windows (a 768p laptop minus browser chrome): cover would blow
     the artwork up to nearly half the height, so scale the image by height
     instead and reserve the correspondingly smaller band. */
  @media (max-height: 700px) {
    .backdrop {
      background-size: auto 72%;
      background-position: left bottom;
    }
    .stage { padding-bottom: calc(72vh * 0.348 + 8px); }
  }

  /* Portrait phones: cover would blow the wordmark up to a third of the screen
     and crop it, so size the image by width instead and reserve 17.4vw. */
  @media (max-width: 700px) {
    .backdrop {
      background-size: 100% auto;
      background-position: left bottom;
    }
    .stage { padding-bottom: calc(50vw * 0.348 + 8px); }
    /* vh-driven type would run enormous on a tall phone, so scale by width. */
    .card__title { font-size: clamp(1.5rem, 7vw, 2.3rem); }
    .card__eyebrow { font-size: clamp(0.62rem, 2.7vw, 0.82rem); letter-spacing: 0.1em; }
    .search__row { flex-wrap: wrap; }
    .search__go { flex: 1 1 auto; min-height: 44px; }
  }

</style>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>

<main class="stage">
  <section class="card card--title">
    <img class="card__mark" src="/logo.png" alt="" width="58" height="58" />
    <div>
      <p class="card__eyebrow">${escapeHtml(host)}</p>
      <h1 class="card__title">Plutonium Compaxy</h1>
    </div>
  </section>

  <section class="card card--search">
    <form onsubmit="location.replace('/?url=' + encodeURIComponent(this.q.value)); return false">
      <label class="search__label" for="target">Proxy a site</label>
      <div class="search__row">
        <input class="search__input" id="target" name="q" type="text"
               placeholder="https://example.com" autofocus required
               autocomplete="off" spellcheck="false" />
        <button class="search__go" type="submit">Go</button>
      </div>
    </form>
  </section>

  <section class="card status" data-state="checking" role="status" aria-live="polite">
    <div class="status__head">
      <span class="status__dot" aria-hidden="true"></span>
      <span class="status__state">Checking status</span>
      <span class="status__latency"></span>
      <a class="status__link" href="/healthz">/healthz</a>
    </div>
    <ul class="checks" hidden></ul>
    <p class="status__foot">Contacting the proxy\u2026</p>
  </section>
  <noscript><style>.status { display: none; }</style></noscript>

  <section class="card card--desc">
    <p class="card__desc">
    Compaxy is a three-engine web proxy. Supply a site with
    <strong>?url=&lt;address&gt;</strong> and it picks the engine that site is
    assigned to, then serves the page through it.
    </p>
  </section>

  <section class="card card--routing">
    <p class="search__label">Routing</p>
    <ul class="routes">
${routing.rows
  .map(
    (row) =>
      `      <li><span class="routes__host">${escapeHtml(row.hosts.join(", "))}</span>` +
      `<span class="routes__engine">${escapeHtml(row.engine.label)}</span></li>`
  )
  .join("\n")}
    </ul>
    <p class="status__foot">Unlisted sites use ${escapeHtml(routing.fallback.label)} · edit sites.json${
      routing.problem ? ` · table could not be read: ${escapeHtml(routing.problem)}` : ""
    }</p>
  </section>
</main>

<script>
  (function () {
    var card    = document.querySelector('.status');
    var state   = card.querySelector('.status__state');
    var latency = card.querySelector('.status__latency');
    var list    = card.querySelector('.checks');
    var foot    = card.querySelector('.status__foot');
    var started = Date.now();

    function settle(mode, label, ms, body) {
      card.dataset.state = mode;
      state.textContent  = label;
      latency.textContent = ms ? Math.max(1, Math.round(ms)) + ' ms' : '';

      if (body && Array.isArray(body.components) && body.components.length) {
        list.innerHTML = body.components.map(function (c) {
          return '<li data-ok="' + (c.ok ? 'true' : 'false') + '">' +
                   '<span class="checks__name">' + c.name + '</span>' +
                   '<span class="checks__val">' + (c.ok ? 'ok' : 'down') + '</span>' +
                 '</li>';
        }).join('');
        list.hidden = false;
      }

      var at = new Date();
      foot.textContent = 'Checked ' + at.toISOString().slice(11, 19) + ' UTC · GET /healthz';
    }

    fetch('/healthz', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        var ms = Date.now() - started;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!body) return settle('error', 'No response', ms, null);
          settle(body.status === 'ok' ? 'ok' : 'error',
                 body.status === 'ok' ? 'Operational' : 'Degraded', ms, body);
        });
      })
      .catch(function () {
        card.dataset.state = 'error';
        state.textContent  = 'Unreachable';
        latency.textContent = '';
        foot.textContent = 'No response from /healthz';
      });
  })();
</script>
</body>
</html>`;
}
