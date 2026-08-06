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

`GOOGLEFINANCE` also covers `AMS:`, `ETR:` and `TSE:`, which between them cover
every non-US listing in the portfolio.

Trade-offs, stated plainly: the data is **delayed** (typically 15–20 minutes on
European exchanges), and Google's terms discourage redistributing it. For a
personal tracker on your own domain that is a judgement call; for anything
public it is not.

## Setup

**1. Create the sheet.** One tab named exactly `Quotes`.

Set **File → Settings → Time zone** to `Europe/Copenhagen` *before* anything
else. `GOOGLEFINANCE("tradetime")` is returned in the spreadsheet's timezone,
and `Code.gs` converts it to epoch seconds assuming that setting is right. Get
it wrong and every timestamp is silently offset by hours — which is exactly the
class of bug this whole source exists to expose.

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

**5. Columns C–F**, filled down. `IFERROR` matters: currency pairs return no
`closeyest` or `tradetime`, and a bare `#N/A` would break the whole read.

```
C2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"price"),""))
D2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"closeyest"),""))
E2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"tradetime"),""))
F2  =IF($B2="","",IFERROR(GOOGLEFINANCE($B2,"datadelay"),""))
```

**6. Apps Script.** Extensions → Apps Script, paste `Code.gs`, save. Run
`testReadQuotes` once from the editor and read the log — symbol-mapping and
coverage problems surface there as nulls, before anything depends on them.

**7. Deploy.** Deploy → New deployment → **Web app**:

- Execute as: **Me**
- Who has access: **Anyone**

Copy the `/exec` URL. The Worker calls it server-side, so the redirect to
`googleusercontent.com` that trips up browser CORS is irrelevant here.

**8. Trigger.** Triggers → Add trigger → `keepFresh` → Time-driven → Minutes
timer → every 5 minutes. `GOOGLEFINANCE` is volatile and Google refreshes it
server-side, but a sheet nobody has open can drift; this forces recalculation.

## Contract

Returns the same envelope as the Worker's `?symbols=`:

```json
{ "quoteResponse": { "result": [
    { "symbol": "NOVO-B.CO", "googleSymbol": "CPH:NOVO-B",
      "regularMarketPrice": 295.55, "previousClose": 294.30,
      "regularMarketTime": 1786002033, "dataDelayMin": 15 }
  ], "error": null } }
```

**No change% is returned, on purpose.** `closeyest` is the previous *session's*
close, so for a US symbol before 15:30 CET, `price - closeyest` is yesterday's
move — and showing that as "today" is the precise bug the Worker's Copenhagen
walk-back prevents. The Worker takes raw inputs and applies its own rule: if
`regularMarketTime` is not today in Copenhagen, today's change is 0.00%.

`regularMarketTime` is null when Google gave no trade time. Null renders as
unknown. It must never be replaced with the current time — that substitution is
what hid the Yahoo outage for six hours.
