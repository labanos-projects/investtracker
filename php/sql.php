<?php
// sql.php — admin SQL execution endpoint for the Claude Cowork agent.
//
// Authenticated by a single long-random token (CLAUDE_SQL_TOKEN) injected at deploy
// time from a GitHub Secret. Logs every query (without parameter values) to PHP's
// error log for audit. Blocks DDL and privilege changes; everything else is allowed.
//
// Request:  POST https://labanos.dk/sql.php
//           Authorization: Bearer <CLAUDE_SQL_TOKEN>
//           Content-Type:  application/json
//           Body: { "sql": "SELECT ...", "params": [optional, array] }
//
// Response (SELECT/SHOW/EXPLAIN/etc):
//           { "rows": [...], "row_count": N, "duration_ms": N }
// Response (INSERT/UPDATE/DELETE):
//           { "affected_rows": N, "last_insert_id": N, "duration_ms": N }
// Response (error):
//           { "error": "..." } with appropriate HTTP status.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// Only POST is allowed.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed; POST a JSON body to this endpoint']);
    exit;
}

// Token injected by GitHub Actions deploy.
define('CLAUDE_SQL_TOKEN', '%%CLAUDE_SQL_TOKEN%%');

function get_auth_header() {
    if (!empty($_SERVER['HTTP_AUTHORIZATION']))          return $_SERVER['HTTP_AUTHORIZATION'];
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) return $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strtolower($k) === 'authorization') return $v;
        }
    }
    return '';
}

// Constant-time token comparison.
$auth = get_auth_header();
if (!preg_match('/^Bearer\s+(.+)$/', $auth, $m)
    || !hash_equals(CLAUDE_SQL_TOKEN, trim($m[1]))) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// Parse body.
$raw  = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['sql']) || !is_string($body['sql']) || trim($body['sql']) === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Body must be JSON: {"sql": "...", "params": []}']);
    exit;
}
$sql    = $body['sql'];
$params = (isset($body['params']) && is_array($body['params'])) ? $body['params'] : [];

// Soft DDL guard. Real defense is the dedicated MySQL user's grants;
// this just trips obvious destructive statements before they hit the DB.
$check = strtolower($sql);
$blocked = ['drop ', 'truncate ', 'alter ', 'grant ', 'revoke ', 'create user', 'drop user'];
foreach ($blocked as $kw) {
    if (strpos($check, $kw) !== false) {
        http_response_code(403);
        echo json_encode(['error' => "Statements containing '" . trim($kw) . "' are not allowed here. Use db_migrate.php / a PR for schema changes."]);
        exit;
    }
}

// DB credentials injected by deploy.
define('DB_HOST', '%%DB_HOST%%');
define('DB_NAME', '%%DB_NAME%%');
define('DB_USER', '%%DB_USER%%');
define('DB_PASS', '%%DB_PASS%%');

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'DB connection failed']);
    exit;
}

// Audit: log the SQL (not param values — those may carry sensitive data).
error_log(sprintf(
    'CLAUDE_SQL_AUDIT ip=%s sql=%s',
    $_SERVER['REMOTE_ADDR'] ?? '-',
    str_replace(["\n", "\r"], ' ', $sql)
));

$start = microtime(true);
try {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $is_read = (bool) preg_match('/^\s*(select|show|describe|desc|explain|with)\b/i', $sql);

    if ($is_read) {
        $rows = $stmt->fetchAll();
        echo json_encode([
            'rows'        => $rows,
            'row_count'   => count($rows),
            'duration_ms' => (int) round((microtime(true) - $start) * 1000),
        ]);
    } else {
        echo json_encode([
            'affected_rows'  => $stmt->rowCount(),
            'last_insert_id' => (int) $pdo->lastInsertId(),
            'duration_ms'    => (int) round((microtime(true) - $start) * 1000),
        ]);
    }
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(['error' => $e->getMessage()]);
}
