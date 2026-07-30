<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

define('DB_HOST', '%%DB_HOST%%');
define('DB_NAME', '%%DB_NAME%%');
define('DB_USER', '%%DB_USER%%');
define('DB_PASS', '%%DB_PASS%%');

try {
    $pdo = new PDO(
        'mysql:host='.DB_HOST.';dbname='.DB_NAME.';charset=utf8mb4',
        DB_USER, DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'DB connection failed']);
    exit;
}

require_once __DIR__ . '/auth_check.php';
require_once __DIR__ . '/db_migrate.php';

// Schema lives in db_migrate.php (repo convention) — including the v11
// screener columns. The old inline CREATE TABLE here has been removed.
run_migrations($pdo);

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST' && isset($_GET['_method'])) {
    $override = strtoupper(trim($_GET['_method']));
    if ($override === 'DELETE') $method = 'DELETE';
}

// ── GET — list all OR fetch single ticker ───────────────────────────────────────
if ($method === 'GET') {
    $ticker = strtoupper(trim($_GET['ticker'] ?? ''));
    if ($ticker) {
        $stmt = $pdo->prepare("SELECT * FROM screener_results WHERE ticker = ?");
        $stmt->execute([$ticker]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $row['score_data']  = json_decode($row['score_data'], true);
            $row['red_flags']   = json_decode($row['red_flags'] ?? '[]', true);
            $row['sources']     = json_decode($row['sources'] ?? '[]', true);
            $row['diagnostics'] = json_decode($row['diagnostics'] ?? '{}', true);
            // Convenience mirror so the card doesn't have to dig into diagnostics.
            $row['roic_basis']  = $row['diagnostics']['roic_basis'] ?? 'earnings';
        }
        echo json_encode($row ?: null);
    } else {
        // roic_basis is derived from the diagnostics JSON rather than stored in
        // its own column — it's already persisted there and we don't index on
        // it, so a column would be schema churn for no gain.
        $stmt = $pdo->query(
            "SELECT ticker, company, sector, industry,
                    quant_score, quant_max, qual_score, qual_max,
                    total_score, max_score, pct, coverage_pct,
                    sgr, years_to_10x, years_to_100x, mktcap_usd,
                    conviction, red_flags, scored_at,
                    JSON_UNQUOTE(JSON_EXTRACT(diagnostics, '$.roic_basis')) AS roic_basis
             FROM screener_results ORDER BY pct DESC, scored_at DESC"
        );
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            $r['red_flags']  = json_decode($r['red_flags'] ?? '[]', true);
            $r['roic_basis'] = $r['roic_basis'] ?: 'earnings';
        }
        echo json_encode($rows);
    }
    exit;
}

// ── POST — upsert (called from Cloudflare Worker after scoring) ─────────────────
if ($method === 'POST') {
    require_auth($pdo);
    $data = json_decode(file_get_contents('php://input'), true);
    if (!$data || !isset($data['ticker'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid payload — ticker required']);
        exit;
    }

    $ticker     = strtoupper(trim($data['ticker']));
    $company    = trim($data['company']     ?? '');
    $sector     = trim($data['sector']      ?? '');
    $industry   = trim($data['industry']    ?? '');
    $scoreData  = json_encode($data['criteria'] ?? []);
    $quantScore = (float)($data['quant_score'] ?? 0);
    $quantMax   = (int)($data['quant_max']    ?? 0);
    $qualScore  = (float)($data['qual_score']  ?? 0);
    $qualMax    = (int)($data['qual_max']     ?? 0);
    $total      = (float)($data['total']       ?? 0);
    // max is now dynamic — criteria with no data drop out of the denominator,
    // so we store whatever the engine actually scored against.
    $max        = (int)($data['max']           ?? 0);
    $pct        = (float)($data['pct']         ?? 0);
    $coverage   = isset($data['coverage'])      ? (float)$data['coverage']      : null;
    $sgr        = isset($data['sgr'])           ? $data['sgr']                  : null;
    $y10        = isset($data['years_to_10x'])  ? $data['years_to_10x']         : null;
    $y100       = isset($data['years_to_100x']) ? $data['years_to_100x']        : null;
    $mktcap     = isset($data['mktcap_usd'])    ? $data['mktcap_usd']           : null;
    $conviction = trim($data['conviction']     ?? '');
    $redFlags   = json_encode($data['red_flags']   ?? []);
    $sources    = json_encode($data['sources']     ?? []);
    $diagnostics= json_encode($data['diagnostics'] ?? new stdClass());
    $scoredAt   = trim($data['scored_at']      ?? date('Y-m-d'));

    $stmt = $pdo->prepare(
        "INSERT INTO screener_results
             (ticker, company, sector, industry, score_data,
              quant_score, quant_max, qual_score, qual_max,
              total_score, max_score, pct, coverage_pct,
              sgr, years_to_10x, years_to_100x, mktcap_usd,
              conviction, red_flags, sources, diagnostics, scored_at)
         VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
             company=VALUES(company), sector=VALUES(sector),
             industry=VALUES(industry), score_data=VALUES(score_data),
             quant_score=VALUES(quant_score), quant_max=VALUES(quant_max),
             qual_score=VALUES(qual_score), qual_max=VALUES(qual_max),
             total_score=VALUES(total_score), max_score=VALUES(max_score),
             pct=VALUES(pct), coverage_pct=VALUES(coverage_pct),
             sgr=VALUES(sgr), years_to_10x=VALUES(years_to_10x),
             years_to_100x=VALUES(years_to_100x), mktcap_usd=VALUES(mktcap_usd),
             conviction=VALUES(conviction), red_flags=VALUES(red_flags),
             sources=VALUES(sources), diagnostics=VALUES(diagnostics),
             scored_at=VALUES(scored_at), updated_at=NOW()"
    );
    $stmt->execute([
        $ticker, $company, $sector, $industry, $scoreData,
        $quantScore, $quantMax, $qualScore, $qualMax,
        $total, $max, $pct, $coverage,
        $sgr, $y10, $y100, $mktcap,
        $conviction, $redFlags, $sources, $diagnostics, $scoredAt,
    ]);
    echo json_encode(['ok' => true]);
    exit;
}

// ── DELETE ────────────────────────────────────────────────────────────────
if ($method === 'DELETE') {
    require_auth($pdo);
    $ticker = strtoupper(trim($_GET['ticker'] ?? ''));
    if (!$ticker) { http_response_code(400); echo json_encode(['error' => 'ticker required']); exit; }
    $pdo->prepare("DELETE FROM screener_results WHERE ticker = ?")->execute([$ticker]);
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
