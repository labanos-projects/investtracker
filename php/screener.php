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

// ── Schema bootstrap (idempotent) ─────────────────────────────────────────────
$pdo->exec("CREATE TABLE IF NOT EXISTS screener_results (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    ticker      VARCHAR(20)  NOT NULL,
    company     VARCHAR(255),
    sector      VARCHAR(100),
    industry    VARCHAR(100),
    score_data  JSON         NOT NULL,
    quant_score DECIMAL(5,2),
    quant_max   INT          NOT NULL DEFAULT 48,
    qual_score  DECIMAL(5,2),
    qual_max    INT          NOT NULL DEFAULT 24,
    total_score DECIMAL(5,2),
    max_score   INT          NOT NULL DEFAULT 72,
    pct         DECIMAL(5,2),
    conviction  VARCHAR(50),
    red_flags   JSON,
    scored_at   DATE         NOT NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY  unique_ticker (ticker),
    INDEX       idx_pct (pct),
    INDEX       idx_scored_at (scored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

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
            $row['score_data'] = json_decode($row['score_data'], true);
            $row['red_flags']  = json_decode($row['red_flags'] ?? '[]', true);
        }
        echo json_encode($row ?: null);
    } else {
        $stmt = $pdo->query(
            "SELECT ticker, company, sector, industry,
                    quant_score, quant_max, qual_score, qual_max,
                    total_score, max_score, pct, conviction, red_flags, scored_at
             FROM screener_results ORDER BY pct DESC, scored_at DESC"
        );
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            $r['red_flags'] = json_decode($r['red_flags'] ?? '[]', true);
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
    $quantMax   = (int)($data['quant_max']    ?? 48);
    $qualScore  = (float)($data['qual_score']  ?? 0);
    $qualMax    = (int)($data['qual_max']     ?? 24);
    $total      = (float)($data['total']       ?? 0);
    $max        = (int)($data['max']           ?? 72);
    $pct        = (float)($data['pct']         ?? 0);
    $conviction = trim($data['conviction']     ?? '');
    $redFlags   = json_encode($data['red_flags'] ?? []);
    $scoredAt   = trim($data['scored_at']      ?? date('Y-m-d'));

    $stmt = $pdo->prepare(
        "INSERT INTO screener_results
             (ticker, company, sector, industry, score_data,
              quant_score, quant_max, qual_score, qual_max,
              total_score, max_score, pct, conviction, red_flags, scored_at)
         VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
             company=VALUES(company), sector=VALUES(sector),
             industry=VALUES(industry), score_data=VALUES(score_data),
             quant_score=VALUES(quant_score), quant_max=VALUES(quant_max),
             qual_score=VALUES(qual_score), qual_max=VALUES(qual_max),
             total_score=VALUES(total_score), max_score=VALUES(max_score),
             pct=VALUES(pct), conviction=VALUES(conviction),
             red_flags=VALUES(red_flags), scored_at=VALUES(scored_at),
             updated_at=NOW()"
    );
    $stmt->execute([
        $ticker, $company, $sector, $industry, $scoreData,
        $quantScore, $quantMax, $qualScore, $qualMax,
        $total, $max, $pct, $conviction, $redFlags, $scoredAt,
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
