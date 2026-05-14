<?php
// ─── Schema migrations ───────────────────────────────────────────────────────
// Idempotent — safe to call on every request. Fast after first run.

function run_migrations($pdo) {

    // 1. portfolios table
    $pdo->exec("CREATE TABLE IF NOT EXISTS portfolios (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        user_id    INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 2. Default portfolio — seed one if the table is empty
    $pfCount = (int)$pdo->query("SELECT COUNT(*) FROM portfolios")->fetchColumn();
    if ($pfCount === 0) {
        try {
            $uid = $pdo->query("SELECT id FROM users ORDER BY id LIMIT 1")->fetchColumn();
            if ($uid) {
                $pdo->prepare("INSERT INTO portfolios (name, user_id) VALUES ('My Portfolio', ?)")
                    ->execute([$uid]);
            }
        } catch (Exception $e) { /* users table may not exist yet on very first boot */ }
    }

    // Helpers
    $tableExists = function($table) use ($pdo) {
        return (int)$pdo->query(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$table'"
        )->fetchColumn() > 0;
    };
    $hasCol = function($table, $col) use ($pdo) {
        return (int)$pdo->query(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME   = '$table'
               AND COLUMN_NAME  = '$col'"
        )->fetchColumn() > 0;
    };

    $defaultPf = (int)($pdo->query("SELECT id FROM portfolios ORDER BY id LIMIT 1")->fetchColumn() ?: 1);

    // 3. portfolio (holdings) — add portfolio_id if table exists and column is missing
    if ($tableExists('portfolio') && !$hasCol('portfolio', 'portfolio_id')) {
        $pdo->exec("ALTER TABLE portfolio ADD COLUMN portfolio_id INT NOT NULL DEFAULT $defaultPf FIRST");
        try { $pdo->exec("ALTER TABLE portfolio DROP INDEX ticker"); }         catch (Exception $e) {}
        try { $pdo->exec("ALTER TABLE portfolio ADD UNIQUE KEY uniq_pf_ticker (portfolio_id, ticker)"); }
        catch (Exception $e) {}
    }

    // 4. transactions — add portfolio_id if table exists and column is missing
    if ($tableExists('transactions') && !$hasCol('transactions', 'portfolio_id')) {
        $pdo->exec("ALTER TABLE transactions ADD COLUMN portfolio_id INT NOT NULL DEFAULT $defaultPf AFTER ticker");
        try { $pdo->exec("ALTER TABLE transactions ADD INDEX idx_pf_ticker (portfolio_id, ticker)"); }
        catch (Exception $e) {}
    }

    // 5. notes — add portfolio_id if table exists and column is missing
    if ($tableExists('investment_notes') && !$hasCol('investment_notes', 'portfolio_id')) {
        $pdo->exec("ALTER TABLE investment_notes ADD COLUMN portfolio_id INT NOT NULL DEFAULT $defaultPf AFTER ticker");
        try { $pdo->exec("ALTER TABLE investment_notes ADD INDEX idx_pf_ticker (portfolio_id, ticker)"); }
        catch (Exception $e) {}
    }

    // 6. portfolio_snapshots — daily total-value history per portfolio/currency
    $pdo->exec("CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id  INT NOT NULL,
        snapshot_date DATE NOT NULL,
        total_value   DECIMAL(18,4) NOT NULL,
        base_ccy      VARCHAR(10) NOT NULL DEFAULT 'DKK',
        UNIQUE KEY uniq_pf_date_ccy (portfolio_id, snapshot_date, base_ccy),
        INDEX idx_pf_ccy (portfolio_id, base_ccy)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 7. watchlists — named lists of candidate symbols, no transactions
    $pdo->exec("CREATE TABLE IF NOT EXISTS watchlists (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        user_id       INT NOT NULL,
        base_currency VARCHAR(3) NOT NULL DEFAULT 'DKK',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 8. watchlist_items — one row per ticker per watchlist
    $pdo->exec("CREATE TABLE IF NOT EXISTS watchlist_items (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        watchlist_id  INT NOT NULL,
        ticker        VARCHAR(20)  NOT NULL,
        yh_ticker     VARCHAR(30)  NOT NULL,
        company       VARCHAR(100) NOT NULL,
        ccy           VARCHAR(10)  NOT NULL DEFAULT 'USD',
        sector        VARCHAR(80)  NULL,
        country       VARCHAR(80)  NULL,
        target_price  DECIMAL(18,6) NULL,
        note          TEXT NULL,
        date_added    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_wl_ticker (watchlist_id, ticker),
        INDEX idx_wl (watchlist_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 9. ONE-OFF migration — promote any legacy `portfolios` row named 'Watchlist'
    //    into the new `watchlists` table. Strict guards keep this safe:
    //      (a) the legacy portfolio has 0 transactions (no real holdings)
    //      (b) the user does not already have a watchlist
    //      (c) idempotent — once migrated, the legacy `portfolios` row is removed
    if ($tableExists('portfolios') && $tableExists('portfolio')) {
        $hasBaseCcy = $hasCol('portfolios', 'base_currency');
        $sql = $hasBaseCcy
            ? "SELECT id, name, user_id, base_currency FROM portfolios WHERE name = 'Watchlist'"
            : "SELECT id, name, user_id, 'DKK' AS base_currency FROM portfolios WHERE name = 'Watchlist'";
        $legacy = $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC);

        foreach ($legacy as $row) {
            // guard (b)
            $chk = $pdo->prepare("SELECT id FROM watchlists WHERE user_id = ? LIMIT 1");
            $chk->execute([$row['user_id']]);
            if ($chk->fetch()) continue;

            // guard (a)
            $tx = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE portfolio_id = ?");
            $tx->execute([$row['id']]);
            if ((int)$tx->fetchColumn() > 0) continue;

            // create the watchlist
            $ins = $pdo->prepare(
                "INSERT INTO watchlists (name, user_id, base_currency) VALUES (?, ?, ?)"
            );
            $ins->execute([$row['name'], $row['user_id'], $row['base_currency'] ?: 'DKK']);
            $newWlId = (int)$pdo->lastInsertId();

            // copy holdings → watchlist_items
            $copy = $pdo->prepare(
                "INSERT INTO watchlist_items
                    (watchlist_id, ticker, yh_ticker, company, ccy, sector, country, date_added)
                 SELECT ?, ticker, yh_ticker, company, ccy, sector, country, created_at
                 FROM portfolio WHERE portfolio_id = ?"
            );
            $copy->execute([$newWlId, $row['id']]);

            // clean up legacy rows
            $pdo->prepare("DELETE FROM portfolio          WHERE portfolio_id = ?")->execute([$row['id']]);
            $pdo->prepare("DELETE FROM investment_notes   WHERE portfolio_id = ?")->execute([$row['id']]);
            $pdo->prepare("DELETE FROM portfolio_snapshots WHERE portfolio_id = ?")->execute([$row['id']]);
            $pdo->prepare("DELETE FROM portfolios          WHERE id = ?")->execute([$row['id']]);
        }
    }
}
