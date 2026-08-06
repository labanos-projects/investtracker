/**
 * InvestTracker — Google Sheets quote microservice
 *
 * Why this exists: on 2026-08-06 Yahoo's edge serving Denmark froze at 09:40
 * and served one snapshot all day, across every endpoint, both hostnames and
 * its own website. No free API replaces it for Nasdaq Copenhagen — FMP,
 * Finnhub and Twelve Data all gate intraday .CO behind paid tiers. But
 * GOOGLEFINANCE quotes CPH, AMS, ETR and TSE natively, so a published sheet
 * becomes a keyless source for exactly the symbols that had no alternative.
 *
 * Measured on the first live run: CPH and US report datadelay 0 (real time);
 * AMS, ETR and TSE report 15 minutes.
 *
 * Contract: returns the same envelope shape the Worker's ?symbols= endpoint
 * returns, so it can be consumed with almost no translation.
 *
 *   { "quoteResponse": { "result": [ { symbol, regularMarketPrice,
 *       previousClose, regularMarketTime, dataDelayMin, ... } ], "error": null } }
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not compute change%. GOOGLEFINANCE's "closeyest" is the previous
 * SESSION's close, so for a US symbol before 15:30 CET, (price - closeyest)
 * is yesterday's move — and rendering that as "today" is the precise bug the
 * Worker's Copenhagen walk-back exists to prevent. Raw inputs only; the Worker
 * decides. See cloudflare/worker.js and docs/DATA_SOURCES.md.
 *
 * SETUP — see google-sheets/README.md for the full walkthrough.
 */

const SHEET_NAME = 'Quotes';

/**
 * GOOGLEFINANCE returns "tradetime" in the EXCHANGE's local time. This is the
 * single most dangerous thing about this file.
 *
 * It is invisible until you hold two exchanges side by side: at 17:37 CEST the
 * sheet showed Copenhagen rows at 17:0x and US rows at 11:2x simultaneously.
 * A Date from getValues() is that wall clock interpreted in the SPREADSHEET's
 * zone, which is right for at most one exchange and silently ~6 hours wrong
 * for US listings.
 *
 * Keys are the prefix produced by the column B mapping formula.
 */
const EXCHANGE_TZ = {
  CPH:      'Europe/Copenhagen',
  STO:      'Europe/Stockholm',
  HEL:      'Europe/Helsinki',
  OSL:      'Europe/Oslo',
  AMS:      'Europe/Amsterdam',
  EBR:      'Europe/Brussels',
  EPA:      'Europe/Paris',
  ETR:      'Europe/Berlin',
  FRA:      'Europe/Berlin',
  LON:      'Europe/London',
  BIT:      'Europe/Rome',
  BME:      'Europe/Madrid',
  SWX:      'Europe/Zurich',
  TSE:      'America/Toronto',
  CVE:      'America/Toronto',
  NASDAQ:   'America/New_York',
  NYSE:     'America/New_York',
  NYSEARCA: 'America/New_York',
  NYSEAMERICAN: 'America/New_York',
  BATS:     'America/New_York'
};

/** Bare tickers (AAPL, MSFT) are US listings. */
const DEFAULT_EXCHANGE_TZ = 'America/New_York';

/**
 * Web app entry point. Deploy as: Execute as **Me**, Who has access **Anyone**.
 * The Worker calls this server-side, so the redirect to googleusercontent.com
 * that breaks browser CORS never matters here.
 */
function doGet(e) {
  var payload;
  try {
    payload = { quoteResponse: { result: readQuotes(), error: null } };
  } catch (err) {
    // 200 with an explicit error, matching how the Worker's news endpoint
    // behaves: the caller can distinguish "we could not look" from "there is
    // nothing", and neither should take the page down.
    payload = { quoteResponse: { result: [], error: String(err && err.message || err) } };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Reads the Quotes sheet. Column order is load-bearing:
 *   A yahoo symbol   B google symbol   C price
 *   D closeyest      E tradetime       F datadelay
 */
function readQuotes() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet "' + SHEET_NAME + '" not found');

  var last = sh.getLastRow();
  if (last < 2) return [];

  var sheetTz = ss.getSpreadsheetTimeZone();
  var rows    = sh.getRange(2, 1, last - 1, 6).getValues();
  var out     = [];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yahooSymbol = String(r[0] || '').trim();
    if (!yahooSymbol) continue;

    var googleSymbol = String(r[1] || '').trim();
    var exchTz       = exchangeTimeZone(googleSymbol);

    out.push({
      symbol:             yahooSymbol,
      googleSymbol:       googleSymbol || null,
      regularMarketPrice: toNum(r[2]),
      previousClose:      toNum(r[3]),
      // Epoch SECONDS — the unit the Worker and app.js already speak.
      // Null when GOOGLEFINANCE returned no trade time (currency pairs, and
      // some thin listings). Null must render as unknown downstream; it must
      // never be replaced with the current time. That substitution is what
      // hid the 2026-08-06 Yahoo outage for six hours.
      regularMarketTime:  toEpochSeconds(r[4], sheetTz, exchTz),
      exchangeTimeZone:   exchTz,
      dataDelayMin:       toNum(r[5])
    });
  }
  return out;
}

/** Null for currency pairs — GOOGLEFINANCE gives them no tradetime at all. */
function exchangeTimeZone(googleSymbol) {
  if (!googleSymbol) return DEFAULT_EXCHANGE_TZ;
  var i = googleSymbol.indexOf(':');
  if (i < 0) return DEFAULT_EXCHANGE_TZ;
  var prefix = googleSymbol.substring(0, i).toUpperCase();
  if (prefix === 'CURRENCY') return null;
  return EXCHANGE_TZ[prefix] || DEFAULT_EXCHANGE_TZ;
}

/** Blank cells and #N/A must become null, not 0 — 0 is a valid price. */
function toNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Converts a tradetime cell to epoch seconds.
 *
 * The cell holds a wall clock with no zone attached, in the exchange's local
 * time. Two shapes arrive depending on how the column is formatted:
 *
 *   Date time formatted → getValues() returns a Date, built by interpreting
 *                         that wall clock in the SPREADSHEET's zone. Recover
 *                         the original digits by formatting it back.
 *   unformatted         → a raw Sheets serial: days since 1899-12-30.
 *
 * Either way the digits are then re-interpreted in the EXCHANGE's zone.
 */
function toEpochSeconds(v, sheetTz, exchTz) {
  if (!exchTz) return null;

  var parts;
  if (v instanceof Date) {
    parts = Utilities.formatDate(v, sheetTz, 'yyyy,MM,dd,HH,mm,ss').split(',').map(Number);
  } else {
    var serial = toNum(v);
    if (serial === null || serial <= 0) return null;
    var d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    parts = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
             d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  }
  return naiveToEpoch(parts, exchTz);
}

/**
 * Wall-clock components → epoch seconds, in timezone `tz`.
 *
 * Resolved at the instant in question rather than with a fixed offset: CEST is
 * +2 in August and +1 in January, and an hour-wrong timestamp is exactly the
 * kind of number that looks fine and isn't. The second lookup catches the case
 * where the first guess landed on the other side of a DST boundary.
 */
function naiveToEpoch(p, tz) {
  var guess = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
  var off1  = zoneOffsetMinutes(new Date(guess), tz);
  var ms    = guess - off1 * 60000;
  var off2  = zoneOffsetMinutes(new Date(ms), tz);
  if (off2 !== off1) ms = guess - off2 * 60000;
  return Math.floor(ms / 1000);
}

/** Offset in minutes east of UTC for `tz` at `date`, e.g. +120 for CEST. */
function zoneOffsetMinutes(date, tz) {
  var z = Utilities.formatDate(date, tz, 'Z');   // "+0200" / "-0500"
  var sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}

/**
 * Time-driven trigger target.
 *
 * GOOGLEFINANCE is a volatile function and Google refreshes it server-side,
 * but a spreadsheet nobody has open can drift. Writing a cell forces a
 * recalculation. Trivial cost against the 90 min/day trigger quota.
 *
 * Install: Apps Script → Triggers → Add trigger → keepFresh → Time-driven →
 * Minutes timer → Every 5 minutes.
 */
function keepFresh() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) return;
  sh.getRange('H1').setValue(new Date());
  SpreadsheetApp.flush();
}

/**
 * Run once from the editor to sanity-check before deploying. Prints the age of
 * every quote in minutes — the number to eyeball, because a timezone mistake
 * shows up as a plausible-looking few-hundred-minute age rather than as an
 * error.
 */
function testReadQuotes() {
  var rows = readQuotes();
  var now  = Math.floor(Date.now() / 1000);

  Logger.log('sheet timezone: ' + SpreadsheetApp.getActive().getSpreadsheetTimeZone());
  Logger.log('rows: ' + rows.length +
             '  no price: '     + rows.filter(function (r) { return r.regularMarketPrice === null; }).length +
             '  no tradetime: ' + rows.filter(function (r) { return r.regularMarketTime === null; }).length);

  rows.forEach(function (r) {
    Logger.log(
      r.symbol + '  ' + r.googleSymbol +
      '  price=' + r.regularMarketPrice +
      '  age='   + (r.regularMarketTime ? Math.round((now - r.regularMarketTime) / 60) + 'min' : 'null') +
      '  tz='    + r.exchangeTimeZone +
      '  delay=' + r.dataDelayMin
    );
  });
}
