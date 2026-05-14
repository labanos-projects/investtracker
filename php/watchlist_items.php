<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
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
    http_response_code(500); echo json_encode(['error' => 'DB connection failed']); exit;
}

require_once __DIR__ . '/db_migrate.php';
run_migrations($pdo);

// ─── Method override (DELETE/PUT tunnelled via POST) ─────────────────────
$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST' && isset($_GET['_method'])) {
    $override = strtoupper(trim($_GET['_method']));
    if (in_array($override, ['PUT', 'DELETE'])) $method = $override;
}

// ─── GET — list items for a watchlist ────────────────────────────────────
if ($method === 'GET') {
    $wlId = (int)($_GET['watchlist_id'] ?? 0);
    if (!$wlId) { http_response_code(400); echo json_encode(['error' => 'watchlist_id required']); exit; }
    $stmt = $pdo->prepare(
        "SELECT id, watchlist_id, ticker, yh_ticker, company, ccy, sector, country,
                target_price, note, date_added
         FROM watchlist_items
         WHERE watchlist_id = ?
         ORDER BY date_added ASC, ticker ASC"
    );
    $stmt->execute([$wlId]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
    exit;
}

// ─── POST ?batch=1 — bulk seed items ──────────────────────────────────────
if ($method === 'POST' && isset($_GET['batch'])) {
    $items = json_decode(file_get_contents('php://input'), true);
    if (!is_array($items)) { http_response_code(400); echo json_encode(['error' => 'Expected array']); exit; }
    $wlId = (int)($_GET['watchlist_id'] ?? ($items[0]['watchlist_id'] ?? 0));
    if (!$wlId) { http_response_code(400); echo json_encode(['error' => 'watchlist_id required']); exit; }
    $stmt = $pdo->prepare(
        "INSERT IGNORE INTO watchlist_items
            (watchlist_id, ticker, yh_ticker, company, ccy, sector, country, target_price, note)
         VALUES (?,?,?,?,?,?,?,?,?)"
    );
    foreach ($items as $item) {
        $yhTicker = $item['yhTicker'] ?? $item['yh_ticker'] ?? $item['ticker'];
        $stmt->execute([
            $wlId,
            $item['ticker'],
            $yhTicker,
            $item['company']  ?? '',
            strtoupper($item['ccy'] ?? 'USD'),
            $item['sector']   ?? null,
            $item['country']  ?? null,
            isset($item['target_price']) && $item['target_price'] !== '' ? (float)$item['target_price'] : null,
            $item['note']     ?? null,
        ]);
    }
    $all = $pdo->prepare(
        "SELECT id, watchlist_id, ticker, yh_ticker, company, ccy, sector, country,
                target_price, note, date_added
         FROM watchlist_items WHERE watchlist_id = ? ORDER BY date_added ASC, ticker ASC"
    );
    $all->execute([$wlId]);
    echo json_encode($all->fetchAll(PDO::FETCH_ASSOC));
    exit;
}

// ─── POST — create single item ────────────────────────────────────────────
if ($method === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    $wlId     = (int)($data['watchlist_id'] ?? ($_GET['watchlist_id'] ?? 0));
    $ticker   = strtoupper(trim($data['ticker'] ?? ''));
    $yhTicker = trim($data['yhTicker'] ?? $data['yh_ticker'] ?? $ticker);
    $company  = trim($data['company'] ?? '');
    $ccy      = strtoupper(trim($data['ccy'] ?? 'USD'));
    $sector   = $data['sector']  ?? null;
    $country  = $data['country'] ?? null;
    $target   = isset($data['target_price']) && $data['target_price'] !== '' ? (float)$data['target_price'] : null;
    $note     = isset($data['note']) ? trim($data['note']) : null;

    if (!$wlId || !$ticker || !$company) {
        http_response_code(400);
        echo json_encode(['error' => 'watchlist_id, ticker and company are required']);
        exit;
    }
    try {
        $stmt = $pdo->prepare(
            "INSERT INTO watchlist_items
                (watchlist_id, ticker, yh_ticker, company, ccy, sector, country, target_price, note)
             VALUES (?,?,?,?,?,?,?,?,?)"
        );
        $stmt->execute([$wlId, $ticker, $yhTicker, $company, $ccy, $sector, $country, $target, $note]);
        $id = (int)$pdo->lastInsertId();
        echo json_encode([
            'id' => $id, 'watchlist_id' => $wlId, 'ticker' => $ticker,
            'yh_ticker' => $yhTicker, 'company' => $company, 'ccy' => $ccy,
            'sector' => $sector, 'country' => $country,
            'target_price' => $target, 'note' => $note,
        ]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            http_response_code(409);
            echo json_encode(['error' => "Ticker '$ticker' already on this watchlist"]);
        } else {
            http_response_code(500);
            echo json_encode(['error' => 'Could not create item']);
        }
    }
    exit;
}

// ─── PUT — update fields ──────────────────────────────────────────────────
if ($method === 'PUT') {
    $id   = (int)($_GET['id'] ?? 0);
    $data = json_decode(file_get_contents('php://input'), true);
    if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }

    $updates = []; $params = [];

    if (array_key_exists('yhTicker', $data) || array_key_exists('yh_ticker', $data)) {
        $updates[] = 'yh_ticker = ?';
        $params[]  = trim($data['yhTicker'] ?? $data['yh_ticker'] ?? '');
    }
    if (array_key_exists('company', $data)) {
        $updates[] = 'company = ?';
        $params[]  = trim($data['company']);
    }
    if (array_key_exists('ccy', $data)) {
        $updates[] = 'ccy = ?';
        $params[]  = strtoupper(trim($data['ccy']));
    }
    if (array_key_exists('sector', $data)) {
        $updates[] = 'sector = ?';
        $params[]  = $data['sector'] === null ? null : trim($data['sector']);
    }
    if (array_key_exists('country', $data)) {
        $updates[] = 'country = ?';
        $params[]  = $data['country'] === null ? null : trim($data['country']);
    }
    if (array_key_exists('target_price', $data)) {
        $updates[] = 'target_price = ?';
        $params[]  = ($data['target_price'] === null || $data['target_price'] === '') ? null : (float)$data['target_price'];
    }
    if (array_key_exists('note', $data)) {
        $updates[] = 'note = ?';
        $params[]  = $data['note'] === null ? null : trim($data['note']);
    }

    if (empty($updates)) { http_response_code(400); echo json_encode(['error' => 'nothing to update']); exit; }
    $params[] = $id;
    $pdo->prepare("UPDATE watchlist_items SET " . implode(', ', $updates) . " WHERE id = ?")->execute($params);
    echo json_encode(['ok' => true]);
    exit;
}

// ─── DELETE — remove item ─────────────────────────────────────────────────
if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    $pdo->prepare("DELETE FROM watchlist_items WHERE id = ?")->execute([$id]);
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
