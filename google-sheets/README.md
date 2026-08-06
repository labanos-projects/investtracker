# Google Sheets quote microservice

A keyless price source built on `GOOGLEFINANCE`, for the exchanges no free API
covers. Intended as the **fallback** when Yahoo returns a stale quote — not as
the primary source.

## Why

On 2026-08-06 Yahoo's edge serving Denmark stopped refreshing at 09:40 CEST and
replayed that snapshot all day: every endpoint, both hostnames, and Yahoo's own
website, which displayed `295.55 — As of 9:40:36 AM GMT+2. Market Open.` at
16:58. Full write-up in [`../docs/DATA_SOURCES.md`](../docs/DATA_SOURCES.md).

No free API replaces it for the Danish holdings. Measured against live
endpoints that day:

| Provider | Nasdaq Copenhagen intraday |
|---|---|
| FMP (`stable/quote`) | 402 — not on this plan |
| Finnhub | not covered at any tier |
| Twelve Data | paid only |
| **GOOGLEFINANCE** | **native — `CPH:`** |

Measured on the first live run: **CPH and US report `datadelay: 0`** — real
time, not delayed. AMS, ETR and TSE report 15 minutes.

Google's terms discourage redistributing this data. For a personal tracker on
your own domain that is a judgement call; for anything public it is not.

## Setup

**1. Create the sheet.** One tab named exactly `Quotes`.

**2. Headers in row 1:**

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| yahoo | google | price | closeyest | tradetime | datadelay |

**3. Column A** — your Yahoo symbols, one per row, exactly as the app stores
them (`NOVO-B.CO`, `AAPL`, `USDDKK=X`).

**4. Column B** — the mapping formula, filled down:

```
=IF($A2="","",
  IFS(
    RIGHT($A2,3)=".CO", "CPH:"&LEFT($A2,LEN($A2)-3),
    RIGHT($A2,3)=".AS", "AMS:"&LEFT($A2,LEN($A2)-3),
    RIGHT($A2,3)=".DE", "ETR:"&LEFT($A2,LEN($A2)-3),
    RIGHT($A2,3)=".TO", "TSE:"&LEFT($A2,LEN($A2)-3),
    RIGHT($A2,2)="=X",  "CURRENCY:"&LEFT($A2,LEN($A2)-2),
    TRUE, $A2
  ))
```

Xetra is **`ETR:`**, not `DE:` — `CHG.DE` becomes `ETR:CHG`. US tickers pass
through bare; Google resolves them without an exchange prefix.

**5. Columns C–F**, filled down.

**Currency pairs take no attribute.** `GOOGLEFINANCE("CURRENCY:USDDKK","price")`
returns `#N/A` — it must be called bare. Getting this wrong leaves every FX rate
blank, which silently breaks base-currency conversion rather than erroring:

```
C2  =IF($B2="","",IF(LEFT($B2,9)="CURRENCY:",IFERROR(GOOGLEFINANCE($B2),""),IFERROR(GOOGLEFINANCE($B2,"price"),"")))
D2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"closeyest"),""))
E2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"tradetime"),""))
F2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"datadelay"),""))
```

`IFERROR` matters elsewhere too: currency pairs return no `closeyest` or
`tradetime`, and a bare `#N/A` breaks the whole read.

**6. Format column E as a date.** Select column E → **Format → Number → Date
time**. Apps Script then returns real `Date` objects instead of raw serials.
`Code.gs` handles both, but this path is cleaner.

**7. Apps Script.** Extensions → Apps Script, paste `Code.gs`, save. Run
`testReadQuotes` and read the log — it prints each quote's **age in minutes**,
which is the number to eyeball. A timezone mistake shows up as a plausible
few-hundred-minute age, not as an error.

**8. Deploy.** Deploy → New deployment → **Web app**, Execute as **Me**, access
**Anyone**. Copy the `/exec` URL. The Worker calls it server-side, so the
redirect to `googleusercontent.com` that trips up browser CORS is irrelevant.

Editing the script does **not** update the live web app. Redeploy via
**Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**

**9. Trigger.** Triggers → Add trigger → `keepFresh` → Time-driven → Minutes
timer → every 5 minutes. Stops a sheet nobody has open from drifting.

## `tradetime` is in the EXCHANGE's local time

The single most dangerous thing here, and invisible unless two exchanges are
compared side by side. At 17:37 CEST the sheet showed:

```
CPH:NOVO-B   17:0x       ← Copenhagen local
AAPL         11:2x       ← New York local
TSE:CSU      10:4x       ← Toronto local
```

Same instant, three different wall clocks. A `Date` from `getValues()` is that
wall clock interpreted in the **spreadsheet's** zone, which is correct for at
most one exchange. Read literally it made US quotes appear ~6 hours old while
they were actively trading:

| symbol | naive reading | truth |
|---|---|---|
| AAPL | 435 min old | trading now |
| CSU.TO | 451 min old | ~15 min |
| NOVO-B.CO | 98 min old | ~37 min |

`Code.gs` recovers the wall clock in the spreadsheet's zone and re-interprets it
in the exchange's, keyed off the `CPH:`/`AMS:`/`ETR:`/`TSE:` prefix, resolving
DST at that instant rather than assuming a fixed offset — Europe and the US
switch on different dates, so a constant is wrong twice a year.

## Contract

Returns the same envelope as the Worker's `?symbols=`:

```json
{ "quoteResponse": { "result": [
    { "symbol": "NOVO-B.CO", "googleSymbol": "CPH:NOVO-B",
      "regularMarketPrice": 293.60, "previousClose": 294.30,
      "regularMarketTime": 1786001400, "exchangeTimeZone": "Europe/Copenhagen",
      "dataDelayMin": 0 }
  ], "error": null } }
```

**No change% is returned, on purpose.** `closeyest` is the previous *session's*
close, so for a US symbol before 15:30 CET, `price - closeyest` is yesterday's
move — and showing that as "today" is the precise bug the Worker's Copenhagen
walk-back prevents. The Worker takes raw inputs and applies its own rule: if
`regularMarketTime` is not today in Copenhagen, today's change is 0.00%.

`regularMarketTime` is null when Google gave no trade time — currency pairs
always, and some thin listings. Null renders as unknown. It must never be
replaced with the current time; that substitution is what hid the Yahoo outage
for six hours.
