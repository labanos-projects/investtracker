<?php
// ─── CORS headers ────────────────────────────────────────────────────────────
// Allow requests from your portfolio app (adjust origin if needed)
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

// Handle preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ─── Database config ─────────────────────────────────────────────────────────
// Fill in your one.com MySQL credentials (found in the one.com control panel)
define('DB_HOST', '%%DB_HOST%%');
define('DB_NAME', '%%DB_NAME%%'); 
define('DB_USER', '%%DB_USER%%'); 
define('DB_PASS', '%%DB_PASS%%'); 

// ─── Connect ─────────────────────────────────────────────────────────────────
try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database connection failed']);
    exit;
}

// ─── Create table if it doesn't exist ────────────────────────────────────────
$pdo->exec("
    CREATE TABLE IF NOT EXISTS investment_notes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id INT          NOT NULL DEFAULT 1,
        ticker       VARCHAR(20)  NOT NULL,
        date         DATE         NOT NULL,
        text       TEXT         NOT NULL,
        created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ticker (ticker)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
");

require_once __DIR__ . '/db_migrate.php';
run_migrations($pdo);

// ─── Route request ───────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
// Method override: PUT/DELETE tunnelled through POST (?_method=DELETE)
// Required for shared hosts (e.g. one.com) that block DELETE/PUT methods
if ($method === 'POST' && isset($_GET['_method'])) {
    $override = strtoupper(trim($_GET['_method']));
    if (in_array($override, ['PUT', 'DELETE'])) $method = $override;
}
$id     = isset($_GET['id'])     ? (int)$_GET['id']               : null;
$ticker = isset($_GET['ticker']) ? trim($_GET['ticker'])           : null;
$body   = json_decode(file_get_contents('php://input'), true) ?: [];

// ─── Auth ───────────────────────────────────────────────────────────────────
require_once __DIR__ . '/auth_check.php';

switch ($method) {

    // ── GET /notes.php?ticker=AAPL ─────────────────────────────────────────
    // Notes are TICKER-scoped, not portfolio-scoped. portfolio_id is still
    // written (audit) but is no longer a read filter — the same decision
    // already made for valuation_models. The merged ticker page can be opened
    // from the screener or a watchlist, where there is no portfolio at all; if
    // reads stayed portfolio-scoped, a note written from the screener would be
    // invisible on the holding for the same company, which is worse than two
    // portfolios holding the same ticker sharing a diary.
    //
    // ?portfolio_id= is accepted and ignored, so old clients keep working.
    case 'GET':
        if ($ticker) {
            $stmt = $pdo->prepare("
                SELECT id, ticker, portfolio_id, DATE_FORMAT(date,'%Y-%m-%d') AS date, text
                FROM investment_notes
                WHERE ticker = ?
                ORDER BY date DESC, id DESC
            ");
            $stmt->execute([$ticker]);
        } else {
            $stmt = $pdo->query("
                SELECT id, ticker, portfolio_id, DATE_FORMAT(date,'%Y-%m-%d') AS date, text
                FROM investment_notes
                ORDER BY date DESC, id DESC
            ");
        }
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['portfolio_id'] = (int)$r['portfolio_id']; }
        echo json_encode($rows);
        break;

    // ── POST /notes.php  body: {ticker, date, text} ─────────────────────────
    case 'POST':
        require_auth($pdo);
        $pfId = (int)($body['portfolio_id'] ?? ($_GET['portfolio_id'] ?? 0));
        $t    = trim($body['ticker'] ?? '');
        $date = trim($body['date']   ?? '');
        $text = trim($body['text']   ?? '');

        // portfolio_id 0 is legitimate: a note on a company you don't own yet,
        // written from the screener or a watchlist.
        if (!$t || !$date || !$text) {
            http_response_code(400);
            echo json_encode(['error' => 'ticker, date and text are required']);
            exit;
        }

        $stmt = $pdo->prepare("INSERT INTO investment_notes (portfolio_id, ticker, date, text) VALUES (?, ?, ?, ?)");
        $stmt->execute([$pfId, $t, $date, $text]);
        $newId = (int)$pdo->lastInsertId();

        http_response_code(201);
        echo json_encode(['id' => $newId, 'portfolio_id' => $pfId, 'ticker' => $t, 'date' => $date, 'text' => $text]);
        break;

    // ── PUT /notes.php?id=5  body: {date, text} ─────────────────────────────
    case 'PUT':
        require_auth($pdo);
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }

        $date = trim($body['date'] ?? '');
        $text = trim($body['text'] ?? '');

        if (!$date || !$text) {
            http_response_code(400);
            echo json_encode(['error' => 'date and text are required']);
            exit;
        }

        $stmt = $pdo->prepare("UPDATE investment_notes SET date = ?, text = ? WHERE id = ?");
        $stmt->execute([$date, $text, $id]);
        echo json_encode(['success' => true]);
        break;

    // ── DELETE /notes.php?id=5 ───────────────────────────────────────────────
    case 'DELETE':
        require_auth($pdo);
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }

        $stmt = $pdo->prepare("DELETE FROM investment_notes WHERE id = ?");
        $stmt->execute([$id]);
        echo json_encode(['success' => true]);
        break;

    default:
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
}
