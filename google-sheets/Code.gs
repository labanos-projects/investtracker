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

  var tz   = ss.getSpreadsheetTimeZone();
  var rows = sh.getRange(2, 1, last - 1, 6).getValues();
  var out  = [];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yahooSymbol = String(r[0] || '').trim();
    if (!yahooSymbol) continue;

    out.push({
      symbol:             yahooSymbol,
      googleSymbol:       String(r[1] || '').trim() || null,
      regularMarketPrice: toNum(r[2]),
      previousClose:      toNum(r[3]),
      // Epoch SECONDS — the unit the Worker and app.js already speak.
      // Null when GOOGLEFINANCE returned no trade time (currency pairs, and
      // some thin listings). Null must render as unknown downstream; it must
      // never be replaced with the current time. That substitution is what
      // hid the 2026-08-06 outage for six hours.
      regularMarketTime:  toEpochSeconds(r[4], tz),
      dataDelayMin:       toNum(r[5])
    });
  }
  return out;
}

/** Blank cells and #N/A must become null, not 0 — 0 is a valid price. */
function toNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * A GOOGLEFINANCE("tradetime") cell arrives one of two ways.
 *
 * Formatted as Date time, getValues() hands back a real Date and there is
 * nothing to do. Left unformatted, it arrives as a raw Sheets serial — days
 * since 1899-12-30 — and the first live run returned null for all 31 symbols
 * because the reader only accepted Date.
 *
 * Serials carry no timezone: they are wall clock in the SPREADSHEET's zone.
 * Converting with a hardcoded offset would be an hour out for half the year,
 * so ask for the actual offset at that instant instead.
 */
function toEpochSeconds(v, tz) {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);

  var serial = toNum(v);
  if (serial === null || serial <= 0) return null;

  // Interpret the serial as if it were UTC, then subtract the zone's offset at
  // that moment to recover the true instant.
  var naiveMs = Math.round((serial - 25569) * 86400 * 1000);
  var offsetMinutes = zoneOffsetMinutes(new Date(naiveMs), tz);
  return Math.round(naiveMs / 1000) - offsetMinutes * 60;
}

/** Offset in minutes east of UTC for `tz` at `date`, e.g. +120 for CEST. */
function zoneOffsetMinutes(date, tz) {
  var z = Utilities.formatDate(date, tz, 'Z');   // "+0200" / "-0500"
  var sign = z.charAt(0) === '-' ? -1 : 1;
  var hh = parseInt(z.substr(1, 2), 10);
  var mm = parseInt(z.substr(3, 2), 10);
  return sign * (hh * 60 + mm);
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
 * Run once from the editor to sanity-check before deploying. Logs what the
 * web app would return, so a coverage or symbol-mapping problem surfaces here
 * rather than as silent nulls in the portfolio.
 */
function testReadQuotes() {
  var rows = readQuotes();
  var missingPrice = rows.filter(function (r) { return r.regularMarketPrice === null; });
  var missingTime  = rows.filter(function (r) { return r.regularMarketTime === null; });

  Logger.log('rows: ' + rows.length +
             '  no price: ' + missingPrice.length +
             '  no tradetime: ' + missingTime.length);

  rows.forEach(function (r) {
    Logger.log(
      r.symbol + '  ' + r.googleSymbol +
      '  price=' + r.regularMarketPrice +
      '  prev='  + r.previousClose +
      '  t='     + (r.regularMarketTime
                    ? new Date(r.regularMarketTime * 1000).toISOString()
                    : 'null') +
      '  delay=' + r.dataDelayMin
    );
  });
}
