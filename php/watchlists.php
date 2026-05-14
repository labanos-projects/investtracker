<?php
// ─── CORS ────────────────────────────────────────────────────────────────────
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// ─── Database config ─────────────────────────────────────────────────────────
define('DB_HOST', '%%DB_HOST%%');
define('DB_NAME', '%%DB_NAME%%');
define('DB_USER', '%%DB_USER%%');
define('DB_PASS', '%%DB_PASS%%');

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (PDOException $e) {
    http_response_code(500); echo json_encode(['error' => 'Database connection failed']); exit;
}

require_once __DIR__ . '/db_migrate.php';
run_migrations($pdo);

// ─── Method override ─────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST' && isset($_GET['_method'])) {
    $override = strtoupper(trim($_GET['_method']));
    if (in_array($override, ['PUT', 'DELETE'])) $method = $override;
}
$id   = isset($_GET['id']) ? (int)$_GET['id'] : null;
$body = json_decode(file_get_contents('php://input'), true) ?: [];

// ─── Auth helper ─────────────────────────────────────────────────────────────
require_once __DIR__ . '/auth_check.php';

switch ($method) {

    // GET /watchlists.php — list all watchlists (public read)
    case 'GET':
        $stmt = $pdo->query(
            "SELECT id, name, base_currency, user_id FROM watchlists ORDER BY created_at ASC"
        );
        echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
        break;

    // POST /watchlists.php — create {name, base_currency?}
    case 'POST':
        $user    = require_auth($pdo);
        $name    = trim($body['name'] ?? '');
        $baseCcy = strtoupper(trim($body['base_currency'] ?? 'DKK'));
        if (!$name) { http_response_code(400); echo json_encode(['error' => 'name is required']); exit; }
        $stmt = $pdo->prepare(
            "INSERT INTO watchlists (name, base_currency, user_id) VALUES (?, ?, ?)"
        );
        $stmt->execute([$name, $baseCcy, $user['id']]);
        $newId = (int)$pdo->lastInsertId();
        http_response_code(201);
        echo json_encode([
            'id' => $newId, 'name' => $name, 'base_currency' => $baseCcy, 'user_id' => $user['id']
        ]);
        break;

    // PUT /watchlists.php?id=X — update {name?, base_currency?}
    case 'PUT':
        require_auth($pdo);
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }
        $updates = []; $params = [];
        if (isset($body['name']) && trim($body['name']) !== '') {
            $updates[] = 'name = ?';
            $params[]  = trim($body['name']);
        }
        if (isset($body['base_currency'])) {
            $updates[] = 'base_currency = ?';
            $params[]  = strtoupper(trim($body['base_currency']));
        }
        if (empty($updates)) { http_response_code(400); echo json_encode(['error' => 'nothing to update']); exit; }
        $params[] = $id;
        $pdo->prepare("UPDATE watchlists SET " . implode(', ', $updates) . " WHERE id = ?")->execute($params);
        echo json_encode(['ok' => true]);
        break;

    // DELETE /watchlists.php?id=X — only if no items remain
    case 'DELETE':
        require_auth($pdo);
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }
        $items = (int)$pdo->query("SELECT COUNT(*) FROM watchlist_items WHERE watchlist_id = $id")->fetchColumn();
        if ($items > 0) {
            http_response_code(409);
            echo json_encode(['error' => "Cannot delete — watchlist still has $items item(s). Remove all items first."]);
            exit;
        }
        $pdo->prepare("DELETE FROM watchlists WHERE id = ?")->execute([$id]);
        echo json_encode(['ok' => true]);
        break;

    default:
        http_response_code(405); echo json_encode(['error' => 'Method not allowed']);
}
